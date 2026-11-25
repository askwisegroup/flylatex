/**
 * 计价与余额账本的回归测试（纯计算部分，不连 Mongo / Redis）。
 *
 * 钉住 5 件对账上会出事的事：
 *   1. 每 1M tokens 的 USD 报价，换算成微单位后**数值恒等**（USD 时 fx=1）。
 *   2. 缓存命中的 token **不会被重复收费**（OpenAI 语义里 cached 已含在
 *      prompt_tokens 内，不扣掉就是收两次钱）。
 *   3. 三种真实 usage 形状（Chat Completions / Responses / DeepSeek 原生）
 *      归一结果一致。
 *   4. 未知模型**拒绝计费**而不是按 0 放过（否则是无限免费入口）。
 *   5. 成本向上取整，不向下（向下取整会累积成平台亏损）。
 */
const test = require('node:test')
const assert = require('node:assert')

// 定死结算币种与汇率，让期望值可复现。
process.env.DEPLOYMENT_PROFILE = 'sg'
process.env.BILLING_CURRENCY = 'SGD'
process.env.BILLING_FX_USD_TO_SGD = '1.35'

// ⚠️ @overleaf/settings 在**首次 require 时**就把 env 读进内存，之后再改
// process.env 不会生效。所以这里主动 require 一次，拿到同一个对象后直接改
// 字段 —— 否则用例之间互相污染，期望值会“看运气”。
const Settings = require('@overleaf/settings')

const Pricing = require('./pricing')

const useCurrency = code => {
  Settings.billing = Object.assign({}, Settings.billing, { currency: code })
}

test('USD 结算时，微单位数值 = tokens × 每百万报价', () => {
  // 用 USD 直接验证恒等关系，绕开汇率这一层。
  useCurrency('USD')
  const cost = Pricing.costFor('deepseek-chat', {
    prompt_tokens: 1000,
    completion_tokens: 500,
  })
  assert.strictEqual(cost.ok, true)
  // 1000 × 0.27 + 500 × 1.1 = 270 + 550 = 820
  assert.strictEqual(cost.micros, 820)
})

test('SGD 结算时按汇率换算', () => {
  useCurrency('SGD')
  const cost = Pricing.costFor('deepseek-chat', {
    prompt_tokens: 1000,
    completion_tokens: 500,
  })
  // 820 × 1.35 = 1107
  assert.strictEqual(cost.micros, 1107)
  assert.strictEqual(cost.breakdown.fx_rate, 1.35)
})

test('缓存命中的 token 不会被重复收费', () => {
  useCurrency('USD')

  const cost = Pricing.costFor('deepseek-chat', {
    prompt_tokens: 1000,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 800 },
  })
  // 付费输入 200 × 0.27 = 54；缓存读 800 × 0.07 = 56；合计 110
  assert.strictEqual(cost.micros, 110)
  assert.strictEqual(cost.breakdown.tokens.input, 200)
  assert.strictEqual(cost.breakdown.tokens.cacheRead, 800)
})

test('三种 usage 形状归一结果一致', () => {
  const chat = Pricing.normaliseUsage({
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 200 },
  })
  const responses = Pricing.normaliseUsage({
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    input_tokens_details: { cached_tokens: 200 },
  })
  const deepseek = Pricing.normaliseUsage({
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_cache_hit_tokens: 200,
    prompt_cache_miss_tokens: 800,
  })

  for (const usage of [chat, responses, deepseek]) {
    assert.strictEqual(usage.input, 800)
    assert.strictEqual(usage.output, 500)
    assert.strictEqual(usage.cacheRead, 200)
  }
})

test('未知模型拒绝计费（不能按 0 放过）', () => {
  const cost = Pricing.costFor('totally-unknown-model-xyz', {
    prompt_tokens: 1000,
    completion_tokens: 1000,
  })
  assert.strictEqual(cost.ok, false)
  assert.strictEqual(cost.reason, 'unknown_model')
})

test('成本向上取整（不向下）', () => {
  useCurrency('USD')
  // 3 tokens × 1.1 = 3.3 → 必须进到 4
  const cost = Pricing.costFor('deepseek-chat', {
    prompt_tokens: 0,
    completion_tokens: 3,
  })
  assert.strictEqual(cost.micros, 4)
})

test('模型 id 带日期后缀 / 中转商前缀也能匹配到价格', () => {
  assert.ok(Pricing.priceFor('gpt-4o-2024-08-06'), '日期后缀')
  assert.ok(Pricing.priceFor('openai/gpt-4o'), '中转商前缀')
  assert.ok(Pricing.priceFor('DeepSeek-Chat'), '大小写')
  assert.strictEqual(Pricing.priceFor('nope'), null)
})

test('priceFor 返回的表不包含 format 之外的字段污染', () => {
  const price = Pricing.priceFor('gpt-4o-mini')
  assert.deepStrictEqual(Object.keys(price).sort(), [
    'cacheRead',
    'cacheWrite',
    'input',
    'output',
  ])
})

test('价格为 0 的 usage 不产生费用', () => {
  const cost = Pricing.costFor('deepseek-chat', {
    prompt_tokens: 0,
    completion_tokens: 0,
  })
  assert.strictEqual(cost.ok, true)
  assert.strictEqual(cost.micros, 0)
})

// ---------------------------------------------------------------------
// 配置默认值：赠送额度与“记帐/拦截”分离
// ---------------------------------------------------------------------

test('默认每个用户首次登录赠送 100 个货币单位', () => {
  // 100 × 1e6 微 = 1e8。用 env 覆盖时也按微单位算。
  assert.strictEqual(Settings.billing.signupGrantMicros, 100_000_000)
})

test('记帐开关与拦截开关是两个独立概念', () => {
  // ledgerEnabled 缺省时跟随 enabled（见 ledger.isLedgerEnabled），
  // 两者分开的意义：可以先只记帐不拦截（shadow），确认数字对了再开拦截。
  assert.notStrictEqual(
    typeof Settings.billing.ledgerEnabled,
    'undefined',
    'ledgerEnabled 必须有默认值，否则“只记账不拦截”这个阶段无法开'
  )
})

test('微单位换算：100 个货币单位 = 100_000_000 微', () => {
  assert.strictEqual(Pricing.MICRO, 1_000_000)
  assert.strictEqual(100 * Pricing.MICRO, 100_000_000)
})
