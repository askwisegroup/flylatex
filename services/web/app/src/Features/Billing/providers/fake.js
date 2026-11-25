'use strict'

/**
 * 本地假支付渠道（`BILLING_PROVIDER=fake`）。
 *
 * 存在的理由：真实收单要开商户号、过 KYC、配公网 HTTPS 回调地址，
 * 但「下单 → 收银台 → 回调 → 验签 → 幂等入账 → 余额可见」这条链路
 * 必须在开发阶段就能完整跑通、能写测试、能压测。
 *
 * 设计上刻意**不做**的事：
 *   1. 不做「点一下就加钱」的后门接口。它产出一个收银台页面，
 *      由用户点「模拟支付」，再由我们的服务端**自己发起一次带签名的 webhook**。
 *   2. 不绕过验签。事件用与真实支付渠道相同的 HMAC 方案签名，
 *      走同一个 `verifyWebhook()` 入口。密钥不对就入不了账 ——
 *      这个分支必须和线上共用，否则上线当天才发现验签根本没跑过。
 *   3. 不产生「fake 专用」的账本字段。入账后账本里只有 `topup`，
 *      渠道指纹记在 order 上，对账逻辑一致。
 *
 * 事件格式照第三方支付渠道的通用信封：
 *   { id, name: 'payment_intent.succeeded', data: { object: { id, amount, currency, status } } }
 */

const crypto = require('crypto')
const Settings = require('@overleaf/settings')
const Money = require('./money')

const EVENT_SUCCEEDED = 'payment_intent.succeeded'

function config() {
  return (Settings.billing && Settings.billing.gateway) || {}
}

/** 没配 webhookSecret 时给一个固定值，让本地/CI 也能跑 */
function webhookSecret() {
  return config().webhookSecret || 'mock-webhook-secret'
}

function isConfigured() {
  // 假渠道永远可用：它不需要任何凭据
  return true
}

/**
 * 创建「托管收银台」。
 * providerRef 就是订单 id —— 回调时靠它找到订单，不需要额外的映射表。
 */
async function createCheckout({ order }) {
  return {
    checkoutUrl: `/billing/mock/checkout/${encodeURIComponent(order.id)}`,
    providerRef: `mock_${order.id}`,
  }
}

/** 假渠道不主动查询：状态完全由回调驱动。 */
async function retrieve() {
  return null
}

/**
 * 与真实渠道适配器相同的验签实现。
 *
 * 注意这里是**独立实现**而不是 require 对方：
 * 如果共用一份，mock 阶段的验签测试就变成了「自己验自己」，
 * 真实渠道换实现时不会失败。宁可两份代码各自被测住。
 */
function verifyWebhook({ rawBody, headers } = {}) {
  const secret = webhookSecret()
  const h = headers || {}
  const timestamp = h['x-timestamp'] || h['X-Timestamp']
  const signature = h['x-signature'] || h['X-Signature']
  if (!timestamp || !signature) return { ok: false, reason: 'missing_signature' }

  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))
  const digest = crypto
    .createHmac('sha256', secret)
    .update(String(timestamp))
    .update(payload)
    .digest()
  const got = String(signature).trim()
  const ok =
    got === digest.toString('hex') ||
    got === digest.toString('base64') ||
    // 第三种：直接对 body 签名（不拼 timestamp）。
    // 留给「本地懒一点的手工 curl」，仍然必须知道 secret 才能伪造。
    got ===
      crypto.createHmac('sha256', secret).update(payload).digest('hex')
  if (!ok) return { ok: false, reason: 'invalid_signature' }

  let event
  try {
    event = JSON.parse(payload.toString('utf8'))
  } catch (error) {
    return { ok: false, reason: 'invalid_json' }
  }
  return { ok: true, event }
}

function parseEvent(event) {
  const object = (event && event.data && event.data.object) || {}
  const eventName = (event && (event.name || event.type)) || ''
  return {
    eventId: (event && event.id) || null,
    eventType: eventName,
    isSucceeded: eventName === EVENT_SUCCEEDED || object.status === 'SUCCEEDED',
    intentId: object.id || null,
    orderRef: (object.metadata && object.metadata.order_id) || null,
    amountMinor: object.amount,
    currency: object.currency,
  }
}

/**
 * 造一个支付渠道形状的事件 + 它的签名。
 *
 * 只给 mock 收银台页面和测试用。真实渠道不存在这个函数，
 * 所以它出现在真实渠道的返回里就该被判红 —— 这是刻意的隔离。
 */
function buildSignedEvent({ order, eventId, status = 'SUCCEEDED' }) {
  // FIXED: 2026-11-12 兼容两种订单对象：控制器/测试里传的是驼峰（amountMicros/id），
  // 从 mongo 读出来的原始文档是下划线（amount_micros/_id）。
  // 之前只认驼峰，Mock 收银台走到的正是原始文档 → Money 收到 undefined 抛
  // invalid_micros，表现为「点了模拟支付没反应」。
  const amountMicros = order.amountMicros ?? order.amount_micros
  const orderId = String(order.id ?? order._id)
  const { amountMinor, currency } = Money.toMinorUnits(
    amountMicros,
    order.currency
  )
  const timestamp = Math.floor(Date.now() / 1000)
  const event = {
    id: eventId || `evt_mock_${orderId}`,
    name: EVENT_SUCCEEDED,
    created_at: new Date().toISOString(),
    data: {
      object: {
        id: `pi_mock_${orderId}`,
        object: 'payment_intent',
        amount: amountMinor,
        currency,
        status,
        metadata: { order_id: orderId },
      },
    },
  }
  const body = JSON.stringify(event)
  const signature = crypto
    .createHmac('sha256', webhookSecret())
    .update(String(timestamp))
    .update(Buffer.from(body))
    .digest('hex')
  return {
    body,
    headers: { 'x-timestamp': String(timestamp), 'x-signature': signature },
  }
}

module.exports = {
  id: 'fake',
  isConfigured,
  createCheckout,
  retrieve,
  verifyWebhook,
  parseEvent,
  buildSignedEvent,
  _internal: { webhookSecret, EVENT_SUCCEEDED },
}
