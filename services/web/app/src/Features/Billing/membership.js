'use strict'

/**
 * 会员（订阅）状态。
 *
 * 与 LLM 额度是**两本独立的账**：
 *   会员 → 卖能力（编译超时 600s、协作人数不限、VIP 标识）
 *   LLM  → 卖用量（按 token 扣余额）
 * 所以这里不碰 `billing_accounts`，只写用户文档上的 VIP 字段。
 *
 * 为什么复用 NeAccountSync.buildVipFields：
 *   站内会员与 NE 会员在用户文档上是同一组字段（vipEndDate / vipExpired /
 *   features.compileTimeout / features.collaborators）。如果这里另写一套，
 *   迟早出现「NE 会员 600 秒、站内会员 300 秒」这种不一致。
 *   复用同一函数 = 权益落地只有一处口径。
 */

const logger = require('@overleaf/logger')
const { getCollectionInternal, ObjectId } = require('../../infrastructure/mongodb')
// models/User 导出的是 { User, UserSchema }，不是模型本身。
// 直接 require 后当模型用会得到 "findById is not a function"。
const { User } = require('../../models/User')
const NeAccountSync = require('../Authentication/NeAccountSync')
const Plans = require('./plans')

const MEMBERSHIPS = 'billing_memberships'

function getCollection() {
  return getCollectionInternal(MEMBERSHIPS)
}

/**
 * 月份加法：1 月 31 日 + 1 个月应该是 2 月末，不是 3 月 3 日。
 */
function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDay))
  return d
}

// 索引只建一次：每次 activate 都执行 createIndex 会白白多一次往返
let indexesReady = null
function ensureIndexesOnce() {
  if (!indexesReady) {
    indexesReady = ensureIndexes().catch(error => {
      indexesReady = null
      throw error
    })
  }
  return indexesReady
}

async function ensureIndexes() {
  const col = await getCollection()
  // 一个订单只能激活一次：回调重投、运营重放都靠它兜住
  await col.createIndex({ order_id: 1 }, { unique: true, sparse: true })
  await col.createIndex({ user_id: 1, expires_at: -1 })
}

/**
 * 激活/续期会员。幂等键是 orderId。
 *
 * 续期从「当前到期时间」往后加，而不是从现在加 —— 否则提前续费会吞掉剩余天数。
 */
async function activate({ userId, planId, orderId }) {
  const plan = Plans.getPlan(planId)
  if (!plan) throw new Error('membership.activate: 未知套餐 ' + planId)

  const _id = new ObjectId(String(userId))
  await ensureIndexesOnce()
  const col = await getCollection()

  const existing = orderId
    ? await col.findOne({ order_id: String(orderId) })
    : null
  if (existing) {
    return { alreadyApplied: true, expiresAt: existing.expires_at }
  }

  const user = await User.findById(_id).exec()
  if (!user) throw new Error('membership.activate: 用户不存在')

  const now = new Date()
  const current = user.vipEndDate ? new Date(user.vipEndDate) : null
  const base = current && current > now ? current : now
  const expiresAt = addMonths(base, plan.months)

  // 复用 NE 的字段计算：只写点路径，不整体替换 features
  const { fields } = NeAccountSync.buildVipFields(user, {
    isVip: true,
    vipEndDate: expiresAt,
  })
  fields.vipExpired = false
  fields.vipEndDate = expiresAt
  await User.updateOne({ _id: user._id }, { $set: fields }).exec()

  await col.insertOne({
    user_id: _id,
    order_id: orderId ? String(orderId) : null,
    plan_id: plan.id,
    months: plan.months,
    started_at: now,
    expires_at: expiresAt,
    created_at: now,
  })

  logger.info(
    { userId: String(_id), planId: plan.id, expiresAt },
    '[membership] 会员已激活/续期'
  )
  return { alreadyApplied: false, expiresAt }
}

/**
 * 当前会员状态（读用户文档，而不是读流水 —— 到期判断以用户字段为准）。
 */
async function status(userId) {
  const user = await User.findById(new ObjectId(String(userId)))
    .select('vipEndDate vipExpired features')
    .exec()
  if (!user) return { active: false, expiresAt: null, daysLeft: null }
  const expiresAt = user.vipEndDate ? new Date(user.vipEndDate) : null
  const active = Boolean(expiresAt && expiresAt > new Date() && user.vipExpired !== true)
  return {
    active,
    expiresAt,
    daysLeft: expiresAt
      ? Math.ceil((expiresAt.getTime() - Date.now()) / 86400000)
      : null,
    compileTimeout:
      user.features && user.features.compileTimeout != null
        ? Number(user.features.compileTimeout)
        : null,
  }
}

async function history(userId, { limit = 20 } = {}) {
  const col = await getCollection()
  return col
    .find({ user_id: new ObjectId(String(userId)) })
    .sort({ created_at: -1 })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 50))
    .toArray()
}

module.exports = {
  MEMBERSHIPS,
  ensureIndexes,
  activate,
  status,
  history,
  addMonths,
}
