'use strict'

/**
 * 支付渠道抽象。
 *
 * 需求：「先用 mock 服务把整个充值流程跑通，之后能直接换成 a third-party payment gateway」。
 *
 * 所以 mock **不是**一个「点一下就加余额」的后门，而是一个实现了同一套接口的
 * provider。它产出的收银台页面会按同样的格式、同样的签名算法回调同一个
 * webhook 端点。这样：
 *
 *   - 验签、事件解析、状态机、幂等入账这些**真正的风险点**在 mock 阶段就被跑过；
 *   - 换 a third-party payment gateway 时只改 `BILLING_PROVIDER` 和几个凭据，业务代码零改动；
 *   - 不存在「mock 分支」——不是 `if (provider === 'fake')`，而是同一份调用代码。
 *
 * 接口（每个 provider 都必须实现，缺一个宁可启动时报错也不要静默降级）：
 *
 *   id                              'fingerprint'，用于日志与账本记录
 *   isConfigured()                  boolean，凭据是否齐全
 *   createCheckout({ order })       → { checkoutUrl, providerRef }
 *   retrieve(providerRef)           → { status, amountMinor, currency, orderRef }
 *   verifyWebhook({ rawBody, headers }) → { ok, event }（失败返回 ok:false，不抛）
 *   parseEvent(event)               → { eventType, intentId, status, amountMinor, currency, orderRef }
 *
 * `status` 统一成三个值：'pending' | 'succeeded' | 'failed'。
 * 渠道自己的状态机（REQUIRES_CUSTOMER_ACTION / PENDING_REVIEW / …）不向上暴露，
 * 否则每个调用点都要重新理解一遍别人的状态。
 */

const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')

const REGISTRY = {
  // 社区版只带 none / fake 两个桩：真实支付渠道属于部署方自有集成，不在本仓库。
  fake: () => require('./fake'),
}

const NONE = Object.freeze({
  id: 'none',
  isConfigured: () => false,
  createCheckout() {
    throw new Error('billing_provider_not_configured')
  },
  retrieve() {
    throw new Error('billing_provider_not_configured')
  },
  verifyWebhook() {
    return { ok: false, reason: 'billing_provider_not_configured' }
  },
  parseEvent() {
    throw new Error('billing_provider_not_configured')
  },
})

function configuredId() {
  const raw = (Settings.billing && Settings.billing.provider) || 'none'
  return String(raw).trim().toLowerCase()
}

/**
 * 取当前生效的 provider。
 *
 * 未知名字**不静默回退**到 none —— 配置写错了应该立刻看得出来，
 * 否则线上会表现为「充值按钮点了没反应」，排查成本极高。
 */
function current() {
  const id = configuredId()
  if (!id || id === 'none') return NONE

  const factory = REGISTRY[id]
  if (!factory) {
    logger.error(
      { provider: id, known: Object.keys(REGISTRY) },
      '[billing] 未知的支付渠道，充值将不可用'
    )
    return NONE
  }

  const provider = factory()
  if (!provider.isConfigured()) {
    logger.warn(
      { provider: id },
      '[billing] 支付渠道凭据不全，充值将不可用'
    )
    return Object.assign({}, provider, NONE, { id: provider.id })
  }
  return provider
}

/** 供设置页/前端显示：当前能不能充值 */
function isAvailable() {
  return current().id !== 'none'
}

module.exports = {
  current,
  isAvailable,
  configuredId,
  REGISTRY,
  NONE,
}
