'use strict'

/**
 * 充值 / 扣费账本（对账的唯一真相来源）。
 *
 * 为什么不用「一个 balance 字段，改完就算」：
 *   对账时客户会问"这 20 块钱扣在哪了"，运营会问"本月收入和消耗对不对"。
 *   只留最终余额就永远回答不了。所以这里坚持**只追加**（append-only）：
 *   任何余额变化都必须有一条对应的账本行，且行一旦写入不再修改
 *   （只允许 pending → applied/rejected 的状态流转）。
 *
 * 两个集合，各司其职：
 *
 *   billing_accounts  每个用户一行，余额的「当前值」。
 *                     扣费要在它身上做**原子条件更新**（余额够才扣），
 *                     这是并发安全的关键 —— 一次 agent 请求会并发发起
 *                     多个 LLM 调用，先读后写必然超支。
 *
 *   billing_ledger    只追加的流水。kind 决定语义：
 *       grant    注册赠送（正数）
 *       topup    充值到账（正数）
 *       charge   LLM 消耗（负数）
 *       refund   退款 / 冲正（正数）
 *       adjust   人工调整（正负皆可，必须带 operator 与理由）
 *
 * 一致性策略（两阶段）：
 *   1. 先写 ledger 行 status='pending'（带唯一幂等键）
 *   2. 对 accounts 做原子更新
 *   3. 回写 ledger 行 status='applied' + balance_after_micros
 *   若第 2 步失败 → 标 rejected；若进程在第 2、3 步之间挂掉，
 *   留下一行 pending —— 对账脚本据此可以发现"钱动了但没记账"
 *   或者"记账了但钱没动"的疑点，这正是需要的可观测性。
 */

const { getCollectionInternal, ObjectId } = require('../../infrastructure/mongodb')
const logger = require('@overleaf/logger')
const Pricing = require('./pricing')

const ACCOUNTS = 'billing_accounts'
const LEDGER = 'billing_ledger'

const KINDS = Object.freeze({
  GRANT: 'grant',
  TOPUP: 'topup',
  CHARGE: 'charge',
  REFUND: 'refund',
  ADJUST: 'adjust',
})

const STATUS = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  REJECTED: 'rejected',
})

/** 账本保留策略：金额流水是财务凭证，不自动过期（与 llm_usage 不同）。 */
let collectionPromise = null
let indexesPromise = null

function collections() {
  if (!collectionPromise) {
    collectionPromise = Promise.all([
      getCollectionInternal(ACCOUNTS),
      getCollectionInternal(LEDGER),
    ]).then(([accounts, ledger]) => ({ accounts, ledger }))
  }
  return collectionPromise
}

async function ensureIndexes() {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const { accounts, ledger } = await collections()

      await accounts.createIndex(
        { user_id: 1 },
        { unique: true, name: 'user_id_unique' }
      )

      // 幂等键：注册赠送、支付回调重放、扣费重试都靠它去重。
      // sparse 是为了让不需要幂等的行（如人工 adjust）可以留空。
      await ledger.createIndex(
        { idempotency_key: 1 },
        { unique: true, sparse: true, name: 'idempotency_unique' }
      )
      // 主要读模式：某用户的流水，按时间倒序
      await ledger.createIndex({ user_id: 1, at: -1 })
      // 对账读模式：某时间段的全部流水
      await ledger.createIndex({ at: -1 })
      // 对账脚本要捞"悬而未决"的行
      await ledger.createIndex({ status: 1, at: -1 })
    })().catch(error => {
      logger.warn({ err: error }, '[billing] 索引创建失败')
      indexesPromise = null
    })
  }
  return indexesPromise
}

function currency() {
  const Settings = require('@overleaf/settings')
  return String((Settings.billing || {}).currency || 'USD').toUpperCase()
}

/**
 * 额度**拦截**是否启用：余额不足时是否拒绝调用。
 *
 * 注意与 `isLedgerEnabled()` 的区别 —— 两者故意分开：
 *   - ledgerEnabled：写不写账（赠送、扣费）
 *   - enabled     ：不够钱了要不要真的拦住
 * 先记账不拦截（shadow mode）是上线前的必要阶段：能比对“账本算出来的
 * 余额”与“实际消耗”是否一致，而且任何算错了都不会影响用户。
 */
function isEnabled() {
  const Settings = require('@overleaf/settings')
  return Boolean((Settings.billing || {}).enabled)
}

/** 账本（赠送 / 扣费流水）是否启用。缺省跟随 enabled。 */
function isLedgerEnabled() {
  const Settings = require('@overleaf/settings')
  const billing = Settings.billing || {}
  if (billing.ledgerEnabled === undefined) return Boolean(billing.enabled)
  return Boolean(billing.ledgerEnabled)
}

function toObjectId(userId) {
  if (userId instanceof ObjectId) return userId
  if (typeof userId === 'string' && ObjectId.isValid(userId)) {
    return new ObjectId(userId)
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 账户                                                               */
/* ------------------------------------------------------------------ */

/**
 * 取账户；不存在则创建（余额 0）。幂等。
 * @returns {Promise<object>} 账户文档
 */
async function ensureAccount(userId) {
  const _id = toObjectId(userId)
  if (!_id) throw new Error('billing.ensureAccount: 非法 userId')
  const { accounts } = await collections()
  await ensureIndexes()

  const now = new Date()
  try {
    await accounts.updateOne(
      { user_id: _id },
      {
        $setOnInsert: {
          user_id: _id,
          currency: currency(),
          balance_micros: 0,
          lifetime_in_micros: 0,
          lifetime_out_micros: 0,
          created_at: now,
        },
        $set: { updated_at: now },
      },
      { upsert: true }
    )
  } catch (error) {
    // 并发 upsert 撞唯一索引：说明别人刚建好，读出来即可
    if (error.code !== 11000) throw error
  }
  return accounts.findOne({ user_id: _id })
}

/** @returns {Promise<{balanceMicros:number, currency:string, userId:string}|null>} */
async function balance(userId) {
  const _id = toObjectId(userId)
  if (!_id) return null
  const { accounts } = await collections()
  const account = await accounts.findOne({ user_id: _id })
  if (!account) return { userId: String(_id), balanceMicros: 0, currency: currency() }
  return {
    userId: String(account.user_id),
    balanceMicros: account.balance_micros || 0,
    currency: account.currency || currency(),
  }
}

/** 当前余额是否够付这笔钱。 */
async function canAfford(userId, amountMicros) {
  if (!isEnabled()) return true
  const current = await balance(userId)
  if (!current) return false
  return current.balanceMicros >= Number(amountMicros || 0)
}

/* ------------------------------------------------------------------ */
/* 入账（正数）                                                       */
/* ------------------------------------------------------------------ */

/**
 * 记一笔入账。幂等：同一 idempotencyKey 重复调用只生效一次。
 *
 * @param {object} entry
 * @param {string|ObjectId} entry.userId
 * @param {'grant'|'topup'|'refund'|'adjust'} entry.kind
 * @param {number} entry.amountMicros     正数
 * @param {string} [entry.idempotencyKey]
 * @param {string} [entry.reference]      支付单号 / 发票号
 * @param {object} [entry.meta]
 * @returns {Promise<{applied:boolean, duplicate:boolean, balanceMicros:number|null}>}
 */
async function credit(entry) {
  const _id = toObjectId(entry.userId)
  if (!_id) throw new Error('billing.credit: 非法 userId')
  const amount = Math.round(Number(entry.amountMicros))
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('billing.credit: amountMicros 必须是正数')
  }

  const { accounts, ledger } = await collections()
  await ensureIndexes()
  await ensureAccount(_id)

  const now = new Date()
  const document = {
    user_id: _id,
    kind: entry.kind,
    amount_micros: amount,
    balance_after_micros: null,
    currency: currency(),
    status: STATUS.PENDING,
    reference: entry.reference || null,
    meta: entry.meta || null,
    at: now,
  }
  if (entry.idempotencyKey) {
    document.idempotency_key = entry.idempotencyKey
  }

  let inserted
  try {
    const result = await ledger.insertOne(document)
    inserted = result.insertedId
  } catch (error) {
    if (error.code === 11000) {
      // 幂等命中：不重复入账，返回当前余额供调用方回显
      const current = await balance(_id)
      return {
        applied: false,
        duplicate: true,
        balanceMicros: current ? current.balanceMicros : null,
      }
    }
    throw error
  }

  let updated
  try {
    updated = await accounts.findOneAndUpdate(
      { user_id: _id },
      {
        $inc: { balance_micros: amount, lifetime_in_micros: amount },
        $set: { updated_at: now },
      },
      { returnDocument: 'after' }
    )
  } catch (error) {
    await ledger.updateOne(
      { _id: inserted },
      { $set: { status: STATUS.REJECTED, rejected_reason: error.message } }
    )
    throw error
  }

  // mongodb driver v4 返回 { value }，v5+ 直接返回文档。两种都兼容。
  const account = updated && updated.value !== undefined ? updated.value : updated
  const balanceAfter = account ? account.balance_micros : null

  await ledger.updateOne(
    { _id: inserted },
    { $set: { status: STATUS.APPLIED, balance_after_micros: balanceAfter } }
  )

  return { applied: true, duplicate: false, balanceMicros: balanceAfter }
}

/* ------------------------------------------------------------------ */
/* 扣费（负数）                                                       */
/* ------------------------------------------------------------------ */

/**
 * 原子扣费。余额不足时不扣任何钱，返回 `insufficient_funds`。
 *
 * @param {object} entry
 * @param {string|ObjectId} entry.userId
 * @param {number} entry.amountMicros 正数（内部取负）
 * @param {string} [entry.idempotencyKey]
 * @param {object} [entry.meta] 模型、tokens、价格版本等
 * @returns {Promise<{ok:boolean, reason?:string, balanceMicros:number|null,
 *                    duplicate?:boolean}>}
 */
async function debit(entry) {
  const _id = toObjectId(entry.userId)
  if (!_id) throw new Error('billing.debit: 非法 userId')
  const amount = Math.round(Number(entry.amountMicros))
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('billing.debit: amountMicros 必须是正数')
  }

  const { accounts, ledger } = await collections()
  await ensureIndexes()
  await ensureAccount(_id)

  const now = new Date()
  const document = {
    user_id: _id,
    kind: KINDS.CHARGE,
    amount_micros: -amount,
    balance_after_micros: null,
    currency: currency(),
    status: STATUS.PENDING,
    reference: entry.reference || null,
    meta: entry.meta || null,
    at: now,
  }
  if (entry.idempotencyKey) {
    document.idempotency_key = entry.idempotencyKey
  }

  let inserted
  try {
    const result = await ledger.insertOne(document)
    inserted = result.insertedId
  } catch (error) {
    if (error.code === 11000) {
      const current = await balance(_id)
      return {
        ok: true,
        duplicate: true,
        balanceMicros: current ? current.balanceMicros : null,
      }
    }
    throw error
  }

  // 条件更新：balance >= amount 才扣。这一步是并发安全的全部关键。
  const updated = await accounts.findOneAndUpdate(
    { user_id: _id, balance_micros: { $gte: amount } },
    {
      $inc: { balance_micros: -amount, lifetime_out_micros: amount },
      $set: { updated_at: now },
    },
    { returnDocument: 'after' }
  )

  const account = updated && updated.value !== undefined ? updated.value : updated

  if (!account) {
    await ledger.updateOne(
      { _id: inserted },
      {
        $set: {
          status: STATUS.REJECTED,
          rejected_reason: 'insufficient_funds',
        },
      }
    )
    const current = await balance(_id)
    return {
      ok: false,
      reason: 'insufficient_funds',
      balanceMicros: current ? current.balanceMicros : 0,
    }
  }

  await ledger.updateOne(
    { _id: inserted },
    {
      $set: {
        status: STATUS.APPLIED,
        balance_after_micros: account.balance_micros,
      },
    }
  )

  return { ok: true, balanceMicros: account.balance_micros }
}

/* ------------------------------------------------------------------ */
/* 注册赠送                                                           */
/* ------------------------------------------------------------------ */

/**
 * 新用户注册赠送。幂等（同一用户只会成功一次）。
 *
 * 需求原文：「初始会给每个注册客户一定的额度（记录会有一条：赠送记录）」
 * —— 所以这里必须有 `kind: 'grant'` 的账本行，不能只是把余额调高。
 *
 * @returns {Promise<{granted:boolean, amountMicros:number}>}
 */
async function grantOnSignup(userId) {
  const Settings = require('@overleaf/settings')
  if (!isLedgerEnabled()) return { granted: false, amountMicros: 0 }

  const amount = Math.round(
    Number((Settings.billing || {}).signupGrantMicros || 0)
  )
  if (amount <= 0) return { granted: false, amountMicros: 0 }

  const _id = toObjectId(userId)
  if (!_id) return { granted: false, amountMicros: 0 }

  const result = await credit({
    userId: _id,
    kind: KINDS.GRANT,
    amountMicros: amount,
    idempotencyKey: `signup-grant:${String(_id)}`,
    meta: { reason: 'signup_grant' },
  })
  return { granted: result.applied, amountMicros: amount }
}

/* ------------------------------------------------------------------ */
/* 按 usage 扣费                                                      */
/* ------------------------------------------------------------------ */

/**
 * 给一次 LLM 调用记账并扣费。
 *
 * 注意：**未知模型不扣费也不报错**（Pricing 返回 unknown_model），
 * 只写一条 warn —— 因为此时调用已经成功了，不能反过来让用户请求失败；
 * 但要留下日志，否则永远发现不了"有模型漏配了价格"。
 *
 * @param {object} entry
 * @param {string} entry.userId
 * @param {string} entry.model
 * @param {object} entry.usage
 * @param {string} [entry.requestId] 上游 request id，用作幂等键的一部分
 * @param {string} [entry.source]
 * @returns {Promise<{charged:boolean, micros:number, reason?:string}>}
 */
async function chargeForUsage(entry) {
  const cost = Pricing.costFor(entry.model, entry.usage)
  if (!cost.ok) {
    logger.warn(
      { model: entry.model, reason: cost.reason },
      '[billing] 模型未配置价格，本次不扣费'
    )
    return { charged: false, micros: 0, reason: cost.reason }
  }
  if (cost.micros <= 0) {
    return { charged: false, micros: 0, reason: 'zero_cost' }
  }

  const idempotencyKey = entry.requestId
    ? `charge:${entry.requestId}`
    : undefined

  const result = await debit({
    userId: entry.userId,
    amountMicros: cost.micros,
    idempotencyKey,
    meta: Object.assign({ source: entry.source || 'llm' }, cost.breakdown),
  })

  return {
    charged: Boolean(result.ok),
    // duplicate 说明这一笔已经扣过，金额按 0 回显给调用方避免重复展示
    micros: result.duplicate ? 0 : cost.micros,
    reason: result.ok ? undefined : result.reason,
    balanceMicros: result.balanceMicros,
  }
}

/* ------------------------------------------------------------------ */
/* 查询                                                               */
/* ------------------------------------------------------------------ */

/**
 * 某用户的流水（倒序分页）。
 * @param {object} query
 * @param {string} query.userId
 * @param {number} [query.limit]
 * @param {string} [query.before] ISO 时间，向前翻页
 */
// FIXED: 2026-11-12 支持分页。
// 之前只有 `before` 游标 + limit，设置页没法「第 2 页」——
// 游标分页对无限滚动很合适，但用户要看的是「第几页 / 共几页」。
// 这里补 offset，并另给一个 total 供前端算页数。
async function listLedger({ userId, limit = 50, offset = 0, before }) {
  const _id = toObjectId(userId)
  if (!_id) return []
  const { ledger } = await collections()
  const filter = { user_id: _id }
  if (before) {
    const at = new Date(before)
    if (!Number.isNaN(at.getTime())) filter.at = { $lt: at }
  }
  return ledger
    .find(filter)
    .sort({ at: -1 })
    .skip(Math.max(Number(offset) || 0, 0))
    .limit(Math.min(Number(limit) || 50, 200))
    .toArray()
}

async function countLedger({ userId }) {
  const _id = toObjectId(userId)
  if (!_id) return 0
  const { ledger } = await collections()
  return ledger.countDocuments({ user_id: _id })
}

/**
 * 时间段汇总，供运营对账用。
 * @param {{from:Date, to:Date}} range
 */
async function summary({ from, to } = {}) {
  const { ledger } = await collections()
  const match = { status: STATUS.APPLIED }
  if (from || to) {
    match.at = {}
    if (from) match.at.$gte = new Date(from)
    if (to) match.at.$lte = new Date(to)
  }
  const rows = await ledger
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: '$kind',
          count: { $sum: 1 },
          amount: { $sum: '$amount_micros' },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray()
  return rows
}

module.exports = {
  countLedger,
  ACCOUNTS,
  LEDGER,
  KINDS,
  STATUS,
  isEnabled,
  isLedgerEnabled,
  currency,
  ensureAccount,
  ensureIndexes,
  balance,
  canAfford,
  credit,
  debit,
  grantOnSignup,
  chargeForUsage,
  listLedger,
  summary,
}
