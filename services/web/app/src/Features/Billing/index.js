'use strict'

/**
 * 计费能力对外门面。
 *
 * 调用方只依赖这个文件，不直接 require ledger / pricing / provider ——
 * 这样以后换支付渠道（或加第二个渠道）不需要改调用点。
 *
 * ⚠️ 所有写操作在 `billing.enabled === false` 时都是 **no-op**：
 *    中国站当前没有计费，不能因为引进了这套模块就让登录/对话失败。
 *    读操作仍然可用（返回 0 余额），便于灰度时观察。
 */

const Ledger = require('./ledger')
const Pricing = require('./pricing')
const Checkout = require('./checkout')
const Providers = require('./providers')
const Webhook = require('./webhook')
const Plans = require('./plans')
const Membership = require('./membership')

function isEnabled() {
  return Ledger.isEnabled()
}

function isLedgerEnabled() {
  return Ledger.isLedgerEnabled()
}

const Billing = {
  isEnabled,
  isLedgerEnabled,
  currency: Ledger.currency,

  /* ---- 读 ---- */
  balance: Ledger.balance,
  canAfford: Ledger.canAfford,
  listLedger: Ledger.listLedger,
  countLedger: Ledger.countLedger,
  summary: Ledger.summary,

  /* ---- 写 ---- */
  ensureAccount: Ledger.ensureAccount,
  credit: Ledger.credit,
  debit: Ledger.debit,

  /**
   * 首次登录赠送额度。
   *
   * 需求：「先给每个第一次登录的用户存 100 元」。
   * 所以这里只看 `signupGrantMicros` 与账本开关，**不看** 支付渠道
   * 是否开通 —— 赠送是账本操作，不是支付操作。
   *
   * 幂等键 `signup-grant:<userId>` 保证同一用户永生只发一次；
   * 因此可以放心地在**每次登录**时调用（老账号也会在升级后首次登录拿到）。
   */
  async onUserRegistered(user) {
    if (!isLedgerEnabled() || !user || !user._id) return { granted: false }
    try {
      return await Ledger.grantOnSignup(user._id)
    } catch (error) {
      const logger = require('@overleaf/logger')
      logger.error(
        { err: error, userId: String(user._id) },
        '[billing] 登录赠送失败，需人工补发'
      )
      return { granted: false, error: error.message }
    }
  },

  /**
   * 给一次 LLM 调用记账扣费。永不抛错 —— 这里出错不能让用户的对话失败。
   */
  async chargeForUsage(entry) {
    if (!isLedgerEnabled()) {
      return { charged: false, micros: 0, reason: 'ledger_disabled' }
    }
    try {
      return await Ledger.chargeForUsage(entry)
    } catch (error) {
      const logger = require('@overleaf/logger')
      logger.error(
        { err: error, userId: entry && entry.userId, model: entry && entry.model },
        '[billing] 扣费失败，需人工对账'
      )
      return { charged: false, micros: 0, reason: 'ledger_error' }
    }
  },

  /* ---- 充值（支付渠道 + 订单） ---- */

  /** 当前生效的支付渠道指纹：'none' 表示充值不可用 */
  providerId() {
    return Providers.current().id
  },

  /** 设置页用来决定「充值」按钮是可点还是灰的 */
  canTopUp() {
    return Providers.isAvailable()
  },

  /**
   * 创建充值订单并拿到渠道收银台地址。
   * 抛错由上层（HTTP 层）翻译成 4xx/5xx，这里不吞。
   */
  async createTopup(entry) {
    if (!isLedgerEnabled()) {
      // 不写账本却让人付钱，是最糟糕的组合：钱收了但记不上
      const error = new Error('billing_ledger_disabled')
      error.code = 'billing_ledger_disabled'
      throw error
    }
    return Checkout.createTopup(entry)
  },

  /** 充值记录（设置页只读） */
  async listTopups(userId, options) {
    if (!isLedgerEnabled()) return []
    try {
      return await Checkout.listOrders(userId, options)
    } catch (error) {
      const logger = require('@overleaf/logger')
      logger.error({ err: error }, '[billing] 读取充值记录失败')
      return []
    }
  },

  /** 支付渠道回调。永不抛错：返回值直接决定 HTTP 状态码。 */
  handleWebhook(args) {
    return Webhook.handleRawEvent(args)
  },

  /* ---- 会员（订阅）：卖能力，与 LLM 余额无关 ---- */

  /** 套餐目录（含当前币种价格）。前端直接渲染，不用再算价格。 */
  listPlans() {
    return Plans.listTiers(Ledger.currency())
  },

  /**
   * 创建会员订单并拿到收银台地址。
   * 金额由**服务端**按 planId 查表得到，绝不接受前端传价格。
   */
  async createMembershipOrder({ userId, planId }) {
    if (!Providers.isAvailable()) {
      const error = new Error('billing_provider_unavailable')
      error.code = 'billing_provider_unavailable'
      throw error
    }
    const plan = Plans.getPlan(planId)
    if (!plan) {
      const error = new Error('billing_unknown_plan')
      error.code = 'billing_unknown_plan'
      throw error
    }
    const amountMicros = Plans.priceFor(plan.period, Ledger.currency())
    return Checkout.createTopup({
      userId,
      amountMicros,
      currency: Ledger.currency(),
      title: plan.name,
      kind: 'membership',
      planId: plan.id,
    })
  },

  /** 当前会员状态：是否有效、到期时间、编译超时 */
  async membershipStatus(userId) {
    return Membership.status(userId)
  },

  /* ---- 测试用内部句柄 ---- */
  /** 供测试替换实现 */
  _ledger: Ledger,
  _pricing: Pricing,
  _checkout: Checkout,
  _providers: Providers,
  _webhook: Webhook,
}

module.exports = Billing
