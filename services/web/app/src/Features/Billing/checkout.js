'use strict'

/**
 * 充值订单：把「支付渠道」和「账本」粘在一起。
 *
 * 一次充值 = 一行 billing_orders：
 *   created → (provider 收银台) → 收到成功事件 → paid
 *   任何一步失败 → failed / expired，绝不停在中间态而没人知道。
 *
 * 三条硬规则（都是真金白银换来的）：
 *
 * 1. **入账金额取自订单，不取自回调。**
 *    回调里的 amount 只用于交叉校验。否则一个能伪造回调的人（或渠道 bug）
 *    就能用 1 元买到 10000 元额度。校验不一致时拒绝入账并报错，
 *    宁可让用户重付，也不留下一个对不上的余额。
 *
 * 2. **一个订单最多入账一次。**
 *    两层保护：先在订单上做原子 claim（status: created → processing），
 *    再用账本幂等键 `topup:order:<orderId>`。渠道重投、人工补单、
 *    用户同时开两个标签页，都只会入账一次。
 *
 * 3. **钱的事不接受「大概」。**
 *    币种不一致、金额不一致、订单已过期，一律拒付并留日志，
 *    不静默取整、不静默换算。
 */

const { getCollectionInternal, ObjectId } = require('../../infrastructure/mongodb')
const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')
const Ledger = require('./ledger')
const Money = require('./providers/money')
const Providers = require('./providers')

const COLLECTION = 'billing_orders'

const STATUS = Object.freeze({
  CREATED: 'created',
  PROCESSING: 'processing',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
})

// 单笔充值上限（微单位）。防止接口被打成「充值 1 个亿」。
// 10000 个货币单位 = 10_000_000_000 微
// FIXED: 2026-11-12 单笔上限由 10000 放宽到 100000（产品要求）
const MAX_TOPUP_MICROS = 100_000_000_000

let collectionPromise = null
let indexesPromise = null

async function collection() {
  if (!collectionPromise) {
    collectionPromise = getCollectionInternal(COLLECTION)
  }
  const col = await collectionPromise
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      col.createIndex({ user_id: 1, created_at: -1 }),
      col.createIndex({ status: 1, created_at: 1 }),
      // 渠道引用唯一：同一个渠道订单 id 不可能对应两个订单
      col.createIndex(
        { provider_ref: 1 },
        { unique: true, sparse: true, name: 'provider_ref_unique' }
      ),
    ]).catch(error => {
      logger.error({ err: error }, '[billing] 创建订单索引失败')
    })
  }
  await indexesPromise
  return col
}

function currency() {
  return String((Settings.billing && Settings.billing.currency) || 'SGD').toUpperCase()
}

function toObjectId(value) {
  if (!value) return null
  if (value instanceof ObjectId) return value
  if (ObjectId.isValid(value)) return new ObjectId(String(value))
  return null
}

/**
 * 创建充值订单并向渠道下单。
 *
 * 先落库再调渠道：如果渠道调用失败，我们会留下一行 failed 订单，
 * 而不是「用户点过但系统里查不到」的幽灵记录。
 *
 * @returns {{ orderId, checkoutUrl, provider, amountMicros, currency }}
 */
async function createTopup({
  userId,
  amountMicros,
  currency: curr,
  title,
  // FIXED: 2026-11-12 区分两类订单：充值（LLM 额度）与会员（能力）。
  // 两者共用支付渠道、共用订单表、共用回调，只有「入账动作」不同。
  kind = 'credit',
  planId = null,
} = {}) {
  const _id = toObjectId(userId)
  if (!_id) throw new Error('billing.createTopup: 非法 userId')

  const amount = Math.round(Number(amountMicros))
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('billing.createTopup: 金额必须为正')
  }
  if (amount > MAX_TOPUP_MICROS) {
    throw new Error('billing.createTopup: 金额超过单笔上限')
  }
  const code = String(curr || currency()).toUpperCase()
  if (code !== currency()) {
    // 只接受账本币种，避免「付 SGD 记 CNY」这种无法对账的组合
    throw new Error('billing.createTopup: 币种与账本不一致')
  }

  const provider = Providers.current()
  if (provider.id === 'none') {
    throw new Error('billing.createTopup: 未配置支付渠道')
  }

  const col = await collection()
  const now = new Date()
  const insert = await col.insertOne({
    user_id: _id,
    amount_micros: amount,
    currency: code,
    provider: provider.id,
    provider_ref: null,
    checkout_url: null,
    title: title || null,
    kind,
    plan_id: planId,
    status: STATUS.CREATED,
    created_at: now,
    updated_at: now,
  })
  const orderId = String(insert.insertedId)

  let checkout
  try {
    checkout = await provider.createCheckout({
      order: {
        id: orderId,
        amountMicros: amount,
        currency: code,
        title,
        description: `FlyLaTeX credit top-up (order ${orderId})`,
      },
    })
  } catch (error) {
    await col.updateOne(
      { _id: insert.insertedId },
      {
        $set: {
          status: STATUS.FAILED,
          failed_reason: error.message,
          updated_at: new Date(),
        },
      }
    )
    logger.error(
      { err: error, orderId, provider: provider.id },
      '[billing] 渠道下单失败'
    )
    throw error
  }

  await col.updateOne(
    { _id: insert.insertedId },
    {
      $set: {
        provider_ref: checkout.providerRef || null,
        checkout_url: checkout.checkoutUrl || null,
        updated_at: new Date(),
      },
    }
  )

  return {
    orderId,
    checkoutUrl: checkout.checkoutUrl,
    provider: provider.id,
    amountMicros: amount,
    currency: code,
  }
}

/** 按 id 找订单；同时接受我们自己生成的订单号和渠道引用 */
async function findOrder(ref) {
  if (!ref) return null
  const col = await collection()
  const _id = toObjectId(ref)
  if (_id) {
    const byId = await col.findOne({ _id })
    if (byId) return byId
  }
  return col.findOne({ provider_ref: String(ref) })
}

/**
 * 收到「支付成功」事件后入账。
 *
 * 关键顺序：定位订单 → 金额/币种交叉校验 → 原子占位 → 账本入账 → 回写订单。
 * 任何一步不满足都直接返回，靠 reason 区分是「正常重复」还是「需要人工介入」。
 */
async function applyPaidEvent({ event, provider } = {}) {
  const parsed = provider && provider.parseEvent ? provider.parseEvent(event) : null
  const orderRef = (parsed && parsed.orderRef) || null
  const intentId = (parsed && parsed.intentId) || null

  const order = await findOrder(orderRef) || (await findOrder(intentId))
  if (!order) {
    logger.error(
      { orderRef, intentId, eventId: parsed && parsed.eventId },
      '[billing] 收到支付成功事件但找不到对应订单'
    )
    return { credited: false, reason: 'order_not_found' }
  }

  const col = await collection()

  if (order.status === STATUS.PAID) {
    // 渠道重投：正常情况，返回当前余额即可
    return { credited: false, duplicate: true, reason: 'already_paid', order }
  }

  if (order.status === STATUS.EXPIRED || order.status === STATUS.FAILED) {
    logger.error(
      { orderId: String(order._id), status: order.status },
      '[billing] 已失效的订单收到支付成功事件，需要人工核对'
    )
    return { credited: false, reason: 'order_not_open', order }
  }

  // --- 交叉校验：金额以订单为准，回调只用来验 ---
  if (parsed && parsed.currency) {
    if (String(parsed.currency).toUpperCase() !== order.currency) {
      logger.error(
        {
          orderId: String(order._id),
          orderCurrency: order.currency,
          eventCurrency: parsed.currency,
        },
        '[billing] 币种不一致，拒绝入账'
      )
      return { credited: false, reason: 'currency_mismatch', order }
    }
  }
  if (parsed && parsed.amountMinor != null) {
    const eventMicros = Money.toMicros(parsed.amountMinor, order.currency)
    if (eventMicros !== order.amount_micros) {
      logger.error(
        {
          orderId: String(order._id),
          orderMicros: order.amount_micros,
          eventMicros,
        },
        '[billing] 金额不一致，拒绝入账'
      )
      return { credited: false, reason: 'amount_mismatch', order }
    }
  }

  // --- 原子占位：并发/重复回调只能有一个赢 ---
  const now = new Date()
  const claimed = await col.findOneAndUpdate(
    { _id: order._id, status: STATUS.CREATED },
    {
      $set: {
        status: STATUS.PROCESSING,
        provider_event_id: (parsed && parsed.eventId) || null,
        provider_intent_id: intentId || null,
        updated_at: now,
      },
    },
    { returnDocument: 'after' }
  )
  const claimedOrder =
    claimed && claimed.value !== undefined ? claimed.value : claimed
  if (!claimedOrder) {
    // 另一个请求正在处理，或刚好已入账
    return { credited: false, duplicate: true, reason: 'claim_lost', order }
  }

  // 会员订单：钱不进 LLM 余额，改为激活/续期会员（VIP 权益）
  if (order.kind === 'membership') {
    const Membership = require('./membership')
    try {
      const activation = await Membership.activate({
        userId: order.user_id,
        planId: order.plan_id,
        orderId: String(order._id),
      })
      await col.updateOne(
        { _id: order._id },
        {
          $set: {
            status: STATUS.PAID,
            updated_at: new Date(),
            membership_expires_at: activation.expiresAt,
          },
        }
      )
      return {
        credited: false,
        duplicate: Boolean(activation.alreadyApplied),
        membership: activation,
        order,
      }
    } catch (error) {
      await col.updateOne(
        { _id: order._id },
        { $set: { status: STATUS.CREATED, updated_at: new Date() } }
      )
      logger.error(
        { err: error, orderId: String(order._id) },
        '[billing] 会员激活失败，订单退回待重试'
      )
      throw error
    }
  }

  let creditResult
  try {
    creditResult = await Ledger.credit({
      userId: order.user_id,
      kind: 'topup',
      amountMicros: order.amount_micros,
      // 一个订单一个键：渠道重投、人工补单都不会重复入账
      idempotencyKey: `topup:order:${String(order._id)}`,
      reference: {
        type: 'billing_order',
        orderId: String(order._id),
        providerEventId: (parsed && parsed.eventId) || null,
        providerIntentId: intentId || null,
      },
      meta: {
        provider: order.provider,
        provider_ref: order.provider_ref,
      },
    })
  } catch (error) {
    // 入账失败：把订单退回可重试状态，别留在 processing
    await col.updateOne(
      { _id: order._id, status: STATUS.PROCESSING },
      {
        $set: {
          status: STATUS.CREATED,
          failed_reason: error.message,
          updated_at: new Date(),
        },
      }
    )
    logger.error({ err: error, orderId: String(order._id) }, '[billing] 入账失败')
    throw error
  }

  await col.updateOne(
    { _id: order._id },
    {
      $set: {
        status: STATUS.PAID,
        paid_at: new Date(),
        updated_at: new Date(),
        credited_micros: order.amount_micros,
      },
    }
  )

  logger.info(
    {
      orderId: String(order._id),
      userId: String(order.user_id),
      amountMicros: order.amount_micros,
      duplicate: Boolean(creditResult && creditResult.duplicate),
    },
    '[billing] 充值入账'
  )

  return {
    credited: true,
    duplicate: Boolean(creditResult && creditResult.duplicate),
    order,
    balanceMicros: creditResult && creditResult.balanceMicros,
  }
}

/** 用户在设置页看到的充值记录 */
async function listOrders(userId, { limit = 20 } = {}) {
  const _id = toObjectId(userId)
  if (!_id) return []
  const col = await collection()
  const rows = await col
    .find({ user_id: _id })
    .sort({ created_at: -1 })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 100))
    .toArray()
  return rows.map(row => ({
    orderId: String(row._id),
    amountMicros: row.amount_micros,
    amount: Money.formatAmount(row.amount_micros, row.currency),
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
  }))
}

async function getOrder(orderId) {
  const col = await collection()
  const _id = toObjectId(orderId)
  if (!_id) return null
  return col.findOne({ _id })
}

module.exports = {
  STATUS,
  COLLECTION,
  MAX_TOPUP_MICROS,
  createTopup,
  applyPaidEvent,
  findOrder,
  getOrder,
  listOrders,
  currency,
}
