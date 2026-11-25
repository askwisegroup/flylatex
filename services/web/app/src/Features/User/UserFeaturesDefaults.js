'use strict'

/**
 * FIXED: 2026-10-23 读取时补齐 users.features 的缺失字段
 *
 * 背景：
 *   `users.features` 是注册时写入用户文档的**快照**，不会随
 *   `Settings.defaultFeatures` 的变化而更新。UserGetter 走原生 MongoDB 驱动，
 *   不像 Mongoose 那样补 schema 默认值，因此：
 *
 *   - 2025-06 之前注册的用户停留在 `compileTimeout: 180`（3 分钟）
 *   - 早期文档的 features 可能只有 compileTimeout，其余开关缺失
 *     （dropbox / github / versioning / templates / trackChanges / references 等）
 *   缺失字段在业务代码里是 `undefined`，一律按「关闭」处理，
 *   于是这些功能对老用户被**静默关闭**。
 *
 * 本模块在读取结果上补齐 **缺失** 字段：
 *   - 只补 `undefined`，绝不覆盖已有值（包括 180、600 这类人工/VIP 设定）
 *   - 只影响进程内返回对象，**不写库**
 *   - 未投影 features 的查询完全不受影响
 */

const settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')

let warnedNotConfigured = false

/** 该查询是否把 features 投影进来了 */
function _projectionIncludesFeatures(projection) {
  if (!projection || Object.keys(projection).length === 0) {
    // 空投影 = 返回整份文档
    return true
  }
  return Boolean(projection.features)
}

function _defaultFeatures() {
  const defaults = settings && settings.defaultFeatures
  if (!defaults || typeof defaults !== 'object') {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true
      logger.warn(
        {},
        'feature-defaults: Settings.defaultFeatures 不可用，跳过 features 归一化'
      )
    }
    return null
  }
  return defaults
}

/**
 * 就地补齐缺失的 features 字段。
 *
 * 只补 `undefined`：已有值（180 / 600 / 人工设定）一律保留。
 * 注意：这里改的是内存中的查询结果，不会写回数据库。
 *
 * @param {object} user 数据库读出的用户文档（会被修改）
 * @param {object} projection 本次查询的投影
 * @returns {object} 同一个 user 对象
 */
function normalizeUserFeatures(user, projection) {
  if (!user) return user
  if (!_projectionIncludesFeatures(projection)) return user

  const defaults = _defaultFeatures()
  if (!defaults) return user

  const features = user.features
  if (
    features !== undefined &&
    (features === null || typeof features !== 'object')
  ) {
    // 结构异常，不猜测，原样返回
    return user
  }

  const filled = features ? Object.assign({}, features) : {}
  let changed = false
  for (const key of Object.keys(defaults)) {
    if (filled[key] === undefined && defaults[key] !== undefined) {
      filled[key] = defaults[key]
      changed = true
    }
  }

  if (!changed && features) return user
  user.features = filled
  return user
}

/** 批量版本，供 find(...).toArray() 的查询使用 */
function normalizeUsersFeatures(users, projection) {
  if (!Array.isArray(users)) return users
  for (const user of users) {
    normalizeUserFeatures(user, projection)
  }
  return users
}

module.exports = {
  normalizeUserFeatures,
  normalizeUsersFeatures,
}
