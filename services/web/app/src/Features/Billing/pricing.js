'use strict'

/**
 * LLM 计价表与费用计算。
 *
 * 设计要点（对账相关，改动前请先读完）：
 *
 * 1. **价格表以 USD 计价**。各模型官方报价都是 USD，若直接改成 SGD 报价，
 *    汇率一变就得重写整张表，且历史账目无法解释。
 * 2. **结算币种是 Billing.currency**（海外站 SGD）。扣费时按 `fxRate` 换算，
 *    并把 `fxRate` + `priceVersion` **写进每一条账本记录** —— 事后审计时
 *    看到的是"当时按什么价格、什么汇率算的"，而不是"按今天的价格重算"。
 * 3. **金额一律整数微单位**（1 微 = 1e-6 货币单位）。一次便宜模型的调用
 *    可能只值几十微，用「分」会四舍五入成 0。
 * 4. **成本向上取整**（`Math.ceil`）。向下取整在大量调用下会累积成一笔
 *    平台自吞的亏损，且对账时"余额 + 已用 ≠ 充值"永远差一点。
 * 5. 账本字段一旦写入**不可修改**。要改价只改这里的默认表 + 提升
 *    `PRICE_VERSION`，历史记录不受影响。
 */

// 每次调整价格表都必须 +1。历史账本用它解释"这笔是按哪版价算的"。
const PRICE_VERSION = 1

/** 1 个货币单位 = 1e6 微单位 */
const MICRO = 1_000_000

/**
 * 内置价格表：USD / 1M tokens。
 *
 * ⚠️ 这些是**默认值**，生产请用 `Settings.llm.pricing` 覆盖成自己谈定的价格。
 *    留空的模型会走到 `unknown` 分支（拒绝扣费并打 warn），而不是静默按 0 计费。
 *
 * `cacheRead` / `cacheWrite`：Prompt Caching 的读写单价。未提供缓存报价的
 * 模型按普通输入价计（conservative：宁可多收也不漏收，避免被刷）。
 */
const DEFAULT_PRICES_USD_PER_MILLION = {
  // 社区版**不内置任何价目**：留空即「未定价」，按下面的 unknown 分支处理
  // （拒绝扣费并打 warn），部署方通过 Settings.llm.pricing 提供自己的价格表。
}

/**
 * 模型价格查找：精确 → 忽略大小写 → 按最长前缀（处理 `-2024-08-06` 之类
 * 的日期后缀，以及中转商自行加的 `openai/`、`deepseek/` 前缀）。
 */
function priceTableUsd() {
  const overrides = readOverrides()
  return Object.assign({}, DEFAULT_PRICES_USD_PER_MILLION, overrides)
}

function readOverrides() {
  // 延迟 require：本模块会被 Settings 之外的地方引用，避免循环依赖。
  const Settings = require('@overleaf/settings')
  const configured = (Settings.llm || {}).pricing
  if (!configured || typeof configured !== 'object') return {}
  const out = {}
  for (const [model, price] of Object.entries(configured)) {
    if (!price || typeof price !== 'object') continue
    out[String(model).toLowerCase()] = {
      input: Number(price.input) || 0,
      output: Number(price.output) || 0,
      // 缓存价缺省时退回普通价：宁可多收，不留免费口子
      cacheRead:
        Number(price.cacheRead) || Number(price.cacheWrite) || Number(price.input) || 0,
      cacheWrite: Number(price.cacheWrite) || Number(price.input) || 0,
    }
  }
  return out
}

/**
 * @param {string} model
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number} | null}
 *          返回 USD / 1M tokens；未知模型返回 null
 */
function priceFor(model) {
  if (!model) return null
  const table = priceTableUsd()
  const raw = String(model).trim()

  if (table[raw]) return table[raw]
  if (table[raw.toLowerCase()]) return table[raw.toLowerCase()]

  // 中转商可能加前缀：`openai/gpt-4o`、`deepseek/deepseek-chat`
  const bare = raw.toLowerCase().split('/').pop()
  if (table[bare]) return table[bare]

  // 最长前缀匹配：`gpt-4o-2024-08-06` → `gpt-4o`
  const candidates = Object.keys(table)
    .filter(key => bare.startsWith(key))
    .sort((a, b) => b.length - a.length)
  if (candidates.length) return table[candidates[0]]

  return null
}

/* ------------------------------------------------------------------ */
/* usage 归一化                                                       */
/* ------------------------------------------------------------------ */

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0)

/**
 * 把各协议的 usage 归一成同一组字段。
 *
 * 已覆盖三种真实形状（都在本仓库出现过）：
 *   - OpenAI Chat Completions: `prompt_tokens` / `completion_tokens`
 *       缓存命中在 `prompt_tokens_details.cached_tokens`
 *   - OpenAI Responses API:    `input_tokens` / `output_tokens`
 *       缓存在 `input_tokens_details.cached_tokens`
 *   - DeepSeek 原生:            `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number, total:number}}
 */
function normaliseUsage(usage) {
  const u = usage || {}
  const cacheRead = num(
    (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ??
      (u.input_tokens_details && u.input_tokens_details.cached_tokens) ??
      u.cache_read_input_tokens ??
      u.prompt_cache_hit_tokens ??
      0
  )
  const cacheWrite = num(
    (u.prompt_tokens_details && u.prompt_tokens_details.cache_creation_tokens) ??
      u.cache_creation_input_tokens ??
      0
  )

  // 输入总量：Chat Completions 用 prompt_tokens，Responses 用 input_tokens。
  // # 注意：这两者**已经包含**缓存命中部分（OpenAI 语义），因此下面算钱时
  //   要把 cacheRead 从 input 里扣掉，否则缓存 token 会被收两次钱。
  const grossInput = num(u.prompt_tokens ?? u.input_tokens ?? 0)
  const output = num(u.completion_tokens ?? u.output_tokens ?? 0)

  const billableInput = Math.max(grossInput - cacheRead - cacheWrite, 0)

  return {
    input: billableInput,
    output,
    cacheRead,
    cacheWrite,
    total: num(u.total_tokens) || grossInput + output,
  }
}

/* ------------------------------------------------------------------ */
/* 费用计算                                                           */
/* ------------------------------------------------------------------ */

function fxRate() {
  const Settings = require('@overleaf/settings')
  const currency = String((Settings.billing || {}).currency || 'USD').toUpperCase()
  if (currency === 'USD') return 1
  const configured =
    process.env['BILLING_FX_USD_TO_' + currency] ||
    process.env.BILLING_FX_RATE ||
    ''
  const parsed = Number(configured)
  // 没有配置汇率时**不猜**：按 1 记账并在账本里留下 fx=1，
  // 让对账时能立刻看出"这段时期的账没按真实汇率算"。
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/**
 * 计算一次调用的费用。
 *
 * @param {string} model
 * @param {object} usage  上游原始 usage 对象
 * @returns {{ok:true, micros:number, breakdown:object} | {ok:false, reason:string}}
 */
function costFor(model, usage) {
  const price = priceFor(model)
  if (!price) {
    // 未知模型拒绝计费：静默按 0 会留下"无限免费"的入口。
    return { ok: false, reason: 'unknown_model' }
  }

  const normalised = normaliseUsage(usage)
  const rate = fxRate()

  // USD/1M tokens → 结算币种微单位：
  //   usd_per_token = price / 1e6
  //   micros        = tokens * usd_per_token * fx * 1e6 / 1e6
  //                 = tokens * price * fx / 1e6  ... 化简后
  // 直接按「每 1M tokens 的价格」算，避免中间量溢出精度：
  //   micros = tokens * price_usd_per_million * fx
  const usdMicros =
    normalised.input * price.input +
    normalised.output * price.output +
    normalised.cacheRead * price.cacheRead +
    normalised.cacheWrite * price.cacheWrite

  // usdMicros 的单位是「USD 微单位 × 1」，因为 price 已经是 per-1M-tokens，
  // 而 1M tokens 恰好等于把 price 直接当微单位用。见上方推导。
  const micros = Math.ceil(usdMicros * rate)

  return {
    ok: true,
    micros: Math.max(micros, 0),
    breakdown: {
      model,
      price_usd_per_million: price,
      tokens: normalised,
      fx_rate: rate,
      price_version: PRICE_VERSION,
    },
  }
}

module.exports = {
  PRICE_VERSION,
  MICRO,
  DEFAULT_PRICES_USD_PER_MILLION,
  priceFor,
  priceTableUsd,
  normaliseUsage,
  costFor,
  fxRate,
}
