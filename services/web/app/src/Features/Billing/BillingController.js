'use strict'

/**
 * 设置页「账户充值 / 充值记录」的只读数据接口。
 *
 * 余额和流水都来自本地账本（`billing_accounts` / `billing_ledger`），这里只读，
 * 不做任何写操作：充值本身要等支付渠道接上，在那之前这个接口
 * 负责把「有没有开通、余额多少、最近发生了哪些账」讲清楚，前端据此渲染
 * 「暂无记录」而不是一个错误提示。
 *
 * 路由挂在 `webRouter` 上（只读 GET，不需要 CSRF），与 `/api/llm/*` 一致：
 * 未登录时返回 200 + `reason`，让设置页自己决定怎么提示，而不是弹 401。
 */

const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')
const Billing = require('./index')
const Checkout = require('./checkout')
const Providers = require('./providers')
const Money = require('./providers/money')

const PAGE_SIZE = 10
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

/** 微单位（1e-6 个货币单位）→ 便于展示的十进制数字。 */
function toAmount(micros) {
  return Math.round(Number(micros) || 0) / 1e6
}

function serializeEntry(entry) {
  const at = entry.at instanceof Date ? entry.at : new Date(entry.at)
  return {
    id: String(entry._id || ''),
    kind: entry.kind || 'unknown',
    amount: toAmount(entry.amount_micros),
    balanceAfter: toAmount(entry.balance_after_micros),
    at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
    note: entry.note || '',
    status: entry.status || 'applied',
  }
}

/**
 * GET /api/billing/ledger?limit=20
 *
 * 200 的响应约定：
 *   { ok: true, enabled, currency, balance, entries, reason? }
 * 失败（账本读不到）也返回 200 + ok:false，前端只显示一句「读取失败」，
 * 不让设置页整块报错。
 */
async function ledger(req, res) {
  const user = (req.session && req.session.user) || req.user
  if (!user || !user._id) {
    // 设置页只对已登录用户渲染；走到这里说明 cookie 丢了，按空数据处理
    return res.json({
      ok: true,
      enabled: false,
      reason: 'not_logged_in',
      currency: Billing.currency(),
      balance: null,
      entries: [],
    })
  }

  const currency = Billing.currency()
  if (!Billing.isLedgerEnabled()) {
    // 记账没开（中国站、或 sg 站灰度前）：仍然 200，前端显示「暂无记录」
    return res.json({
      ok: true,
      enabled: false,
      currency,
      balance: null,
      entries: [],
    })
  }

  // 分页：一页最多 10 条（用户明确要求的密度），page 从 1 开始
  const requested = Number(req.query && req.query.limit)
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : PAGE_SIZE
  const requestedPage = Number(req.query && req.query.page)
  const page = Number.isFinite(requestedPage)
    ? Math.max(Math.trunc(requestedPage), 1)
    : 1

  try {
    const [balance, entries, total] = await Promise.all([
      Billing.balance(user._id),
      Billing.listLedger({
        userId: user._id,
        limit,
        offset: (page - 1) * limit,
      }),
      Billing.countLedger({ userId: user._id }),
    ])
    return res.json({
      ok: true,
      enabled: true,
      currency,
      balance: balance ? toAmount(balance.balanceMicros) : null,
      entries: entries.map(serializeEntry),
      page,
      pageSize: limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    })
  } catch (error) {
    logger.error(
      { err: error, userId: String(user._id) },
      '[billing] 读取充值记录失败'
    )
    return res.json({
      ok: false,
      enabled: true,
      reason: 'ledger_unavailable',
      currency,
      balance: null,
      entries: [],
    })
  }
}

/**
 * 允许的充值档位（微单位）。
 *
 * 为什么是白名单而不是「客户端传多少就充多少」：
 *   金额来自客户端，就必须当作不可信输入。白名单能挡住
 *   「改包成 0.01」、「改包成 1 个亿」以及浮点写法带来的取整歧义。
 *   档位同时是运营可配的价格表雏形，以后接会员套餐时在这里扩展。
 */
/** 自定义金额区间（货币单位，不是微单位） */
const MIN_TOPUP = 5
const MAX_TOPUP = 100000
const MIN_TOPUP_MICROS = MIN_TOPUP * 1_000_000
const MAX_TOPUP_MICROS = MAX_TOPUP * 1_000_000

const TOPUP_PRESETS = Object.freeze([
  50_000_000, // 50.00
  100_000_000, // 100.00
  200_000_000, // 200.00
  500_000_000, // 500.00
  1_000_000_000, // 1000.00
])

function currentUser(req) {
  return (req.session && req.session.user) || req.user || null
}

/**
 * POST /billing/topup  { amount: 100 }   （amount 为货币单位，不是微单位）
 *
 * 成功：{ ok: true, orderId, checkoutUrl }
 * 前端拿到 checkoutUrl 后整页跳转（支付渠道的托管收银台）。
 */
async function topup(req, res) {
  const user = currentUser(req)
  if (!user || !user._id) {
    return res.status(401).json({ ok: false, reason: 'not_logged_in' })
  }

  if (!Providers.isAvailable()) {
    return res.status(503).json({ ok: false, reason: 'provider_unavailable' })
  }

  const currency = Billing.currency()
  const raw = Number(req.body && req.body.amount)
  if (!Number.isFinite(raw) || raw <= 0) {
    return res.status(400).json({ ok: false, reason: 'invalid_amount' })
  }
  // 用 Money 的换算把「货币单位」变成「微单位」，避免自己乘 1e6
  const micros = Math.round(raw * Money.MICRO)
  // FIXED: 2026-11-12 支持自定义金额。
  // 之前只认 5 个预设档位，用户想充 88 元做不到。现在改成**区间校验**：
  //   下限 5、上限 100000、不接受 0/负数/NaN。
  // 仍然不接受「客户端说多少就多少」以外的字段（金额由服务端再乘一次汇率/落账），
  // 所以放宽下限的同时并不放松可信度 —— 金额本身就是用户自己付的钱。
  if (micros < MIN_TOPUP_MICROS || micros > MAX_TOPUP_MICROS) {
    return res.status(400).json({
      ok: false,
      reason: 'amount_out_of_range',
      min: toAmount(MIN_TOPUP_MICROS),
      max: toAmount(MAX_TOPUP_MICROS),
      currency,
    })
  }

  try {
    const order = await Billing.createTopup({
      userId: user._id,
      amountMicros: micros,
      currency,
    })
    return res.json({
      ok: true,
      orderId: order.orderId,
      checkoutUrl: order.checkoutUrl,
      amount: toAmount(order.amountMicros),
      currency: order.currency,
    })
  } catch (error) {
    const reason =
      error && error.code === 'billing_ledger_disabled'
        ? 'ledger_disabled'
        : 'checkout_failed'
    logger.error(
      { err: error, userId: String(user._id) },
      '[billing] 创建充值订单失败'
    )
    return res.status(500).json({ ok: false, reason })
  }
}

/**
 * POST /billing/webhook
 *
 * 支付渠道回调。要点：
 *   - 不要求登录（渠道不会带 cookie），因此要在登录白名单里
 *   - 关闭 CSRF（渠道拿不到 token）
 *   - 用 `req.rawBody` 验签（Server.js 里对这条路径保留了原始字节）
 */
async function webhook(req, res) {
  // FIXED: 2026-11-12 只接受「原始字节」。
  // 之前写成 `req.rawBody || req.body`：如果请求的 Content-Type 不是 json，
  // body-parser 不会解析、也不会设置 rawBody，于是这里把 `{}` 对象当报文去验签，
  // 结果恒为 invalid_signature —— 排查时会误以为是密钥不对。
  // 现在明确区分「拿不到原始字节」和「签名不对」。
  if (!req.rawBody) {
    logger.error(
      { contentType: req.headers['content-type'], url: req.originalUrl },
      '[billing] 回调缺少原始报文，无法验签'
    )
    return res
      .status(400)
      .json({ ok: false, reason: 'missing_raw_body' })
  }
  const result = await Billing.handleWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
  })
  return res.status(result.status).json(result.body)
}

/**
 * GET /billing/mock/checkout/:orderId
 *
 * 本地假收银台。只在 `BILLING_PROVIDER=fake` 时注册，
 * 生产环境这条路由根本不存在 —— 不是靠运行时判断，而是压根不挂。
 */
async function mockCheckout(req, res) {
  const user = currentUser(req)
  const order = await Checkout.getOrder(req.params.orderId)
  if (!order) return res.status(404).send('订单不存在')
  if (user && String(order.user_id) !== String(user._id)) {
    return res.status(403).send('无权查看该订单')
  }
  const amount = Money.formatAmount(order.amount_micros, order.currency)
  const paid = order.status === Checkout.STATUS.PAID
  // FIXED: 2026-11-12 表单 POST 必须带 CSRF token，否则 csurf 直接 403 Forbidden。
  // 收银台页面是控制器手写的 HTML，不走 pug 布局，拿不到 res.locals.csrfToken，
  // 所以这里显式取一次再塞进隐藏域。
  let csrfToken = ''
  try {
    csrfToken = res.locals.csrfToken || (req.csrfToken && req.csrfToken()) || ''
  } catch (csrfError) {
    csrfToken = res.locals.csrfToken || ''
  }
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>模拟收银台 - FlyLaTeX</title>
<style>
 body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fa;margin:0;
      display:flex;align-items:center;justify-content:center;min-height:100vh}
 .card{background:#fff;border-radius:12px;padding:32px 36px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:420px;width:92%}
 h1{font-size:18px;margin:0 0 4px}
 .amt{font-size:40px;font-weight:700;margin:18px 0}
 .muted{color:#8a94a6;font-size:13px}
 button{width:100%;padding:12px;border:0;border-radius:8px;background:#138a07;color:#fff;
        font-size:15px;cursor:pointer;margin-top:22px}
 button:disabled{background:#c8ced8;cursor:not-allowed}
 code{background:#f2f4f7;padding:2px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="card">
<h1>模拟收银台</h1>
<div class="muted">这是本地假支付渠道，不会真的扣钱。</div>
<div class="amt">${amount} ${order.currency}</div>
<div class="muted">订单 <code>${order._id}</code> · 状态 ${order.status}</div>
<form method="post" action="/billing/mock/pay/${order._id}">
  <input type="hidden" name="_csrf" value="${csrfToken}">
  <button type="submit"${paid ? ' disabled' : ''}>${paid ? '已支付' : '模拟支付成功'}</button>
</form>
</div></body></html>`)
}

/**
 * POST /billing/mock/pay/:orderId
 *
 * 模拟「用户在收银台付了钱」：服务端自己构造一个**带签名**的事件，
 * 走和真实渠道完全相同的 webhook 入口。
 * 这里刻意不复用 checkout.applyPaidEvent 直接入账 —— 那样就绕过了验签，
 * 等于 mock 阶段根本没验证过验签链路。
 */
async function mockPay(req, res) {
  const provider = Providers.current()
  if (provider.id !== 'fake') {
    return res.status(404).send('模拟支付未启用')
  }
  const order = await Checkout.getOrder(req.params.orderId)
  if (!order) return res.status(404).send('订单不存在')

  const { body, headers } = provider.buildSignedEvent({ order })
  const result = await Billing.handleWebhook({
    rawBody: Buffer.from(body),
    headers,
  })

  if (result.status !== 200) {
    return res.status(500).send('入账失败，请查看服务端日志')
  }
  return res.redirect(303, '/user/settings?topup=success')
}

/**
 * GET /api/billing/orders?limit=20
 * 设置页展示的「充值记录」（与账本流水互补：这里看订单状态，
 * 账本看钱的实际变动，两者条数不一定相同）。
 */
async function orders(req, res) {
  const user = currentUser(req)
  if (!user || !user._id) {
    return res.json({ ok: true, orders: [] })
  }
  const list = await Billing.listTopups(user._id, {
    limit: Number(req.query && req.query.limit) || DEFAULT_LIMIT,
  })
  return res.json({ ok: true, orders: list })
}

/**
 * GET /api/billing/plans
 * 会员套餐目录（含当前币种价格）。公开可读：未登录用户也要能看到价格。
 */
async function plans(req, res) {
  try {
    return res.json({
      ok: true,
      currency: Billing.currency(),
      plans: Billing.listPlans(),
    })
  } catch (error) {
    logger.error({ err: error }, '[billing] 读取套餐失败')
    return res.status(500).json({ ok: false, reason: 'plans_unavailable' })
  }
}

/**
 * POST /billing/subscribe  { planId: 'pro-year' }
 *
 * 会员下单。金额一律服务端查表，前端传价格会被忽略 ——
 * 这类接口只要相信了客户端一次，就等于把定价权交出去了。
 */
async function subscribe(req, res) {
  const user = currentUser(req)
  if (!user || !user._id) {
    return res.status(401).json({ ok: false, reason: 'not_logged_in' })
  }
  const planId = String((req.body && req.body.planId) || '')
  try {
    const order = await Billing.createMembershipOrder({
      userId: user._id,
      planId,
    })
    return res.json({
      ok: true,
      orderId: order.orderId,
      checkoutUrl: order.checkoutUrl,
      amount: toAmount(order.amountMicros),
      currency: order.currency,
    })
  } catch (error) {
    const reason =
      error && error.code === 'billing_unknown_plan'
        ? 'unknown_plan'
        : error && error.code === 'billing_provider_unavailable'
        ? 'provider_unavailable'
        : 'checkout_failed'
    logger.error(
      { err: error, userId: String(user._id), planId },
      '[billing] 会员下单失败'
    )
    return res.status(reason === 'unknown_plan' ? 400 : 500).json({
      ok: false,
      reason,
    })
  }
}

/**
 * GET /api/billing/membership
 * 当前会员状态（是否有效、到期时间、编译超时）。
 */
async function membership(req, res) {
  const user = currentUser(req)
  if (!user || !user._id) {
    return res.json({ ok: true, active: false })
  }
  try {
    const status = await Billing.membershipStatus(user._id)
    return res.json({ ok: true, ...status })
  } catch (error) {
    logger.error({ err: error }, '[billing] 读取会员状态失败')
    return res.json({ ok: false, active: false, reason: 'membership_unavailable' })
  }
}

module.exports = {
  ledger,
  plans,
  subscribe,
  membership,
  topup,
  webhook,
  mockCheckout,
  mockPay,
  orders,
  TOPUP_PRESETS,
  MIN_TOPUP,
  MAX_TOPUP,
}
