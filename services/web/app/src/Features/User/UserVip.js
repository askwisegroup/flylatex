// FIXED: 2026-11-15 统一 VIP 判定与普通用户 / VIP 的资源上限
// 说明：NeAccountSync 里已经有一套「根据 NE 账号写入 vipEndDate」的逻辑，
// 这里只负责「读取数据库里的 vipEndDate / vipExpired 并给出上限」，
// 不改动登录同步流程，避免影响现有 VIP 升级 / 过期降级。
const Settings = require('@overleaf/settings')

const MB = 1024 * 1024

// 兜底值：即使部署方没有合并新的 config，也不会让限制失效或变成 0。
const FALLBACK_NORMAL_LIMITS = {
  collaborators: 5,
  projects: 50,
  storageBytes: 256 * MB,
  maxUploadSize: 10 * MB,
}

const FALLBACK_VIP_LIMITS = {
  collaborators: -1,
  projects: null,
  storageBytes: 2 * 1024 * MB,
  maxUploadSize: 0,
  agentCompileTimeout: 600,
}

function toDate(value) {
  if (!value) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date
}

/**
 * 账号级 VIP 判定：vipEndDate 有效且没有被标记过期。
 * 与 UserPagesController / NeAccountSync 的口径保持一致。
 */
function isVipUser(user) {
  if (!user || user.vipExpired === true) {
    return false
  }
  const end = toDate(user.vipEndDate)
  return end != null && end.getTime() > Date.now()
}

function getVipStatus(user) {
  const end = toDate(user?.vipEndDate)
  const isVip = isVipUser(user)
  return {
    isVip,
    isExpired: user?.vipExpired === true,
    vipEndDate: end,
    daysRemaining: end
      ? Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null,
  }
}

/**
 * 返回某个用户的资源上限。
 * user 可以是 Mongoose 文档、lean 对象，也可以只有 vipEndDate / vipExpired 两个字段。
 */
function getLimitsForUser(user) {
  const isVip = isVipUser(user)
  const configured =
    (isVip ? Settings.userLimits?.vip : Settings.userLimits?.normal) || {}
  const limits = {
    ...(isVip ? FALLBACK_VIP_LIMITS : FALLBACK_NORMAL_LIMITS),
    ...configured,
    isVip,
  }

  // VIP 的 maxUploadSize 配置为 0 时，沿用部署方已有的全局上限。
  if (isVip && !limits.maxUploadSize) {
    limits.maxUploadSize = Settings.maxUploadSize || 50 * MB
  }

  return limits
}

module.exports = {
  isVipUser,
  getVipStatus,
  getLimitsForUser,
}
