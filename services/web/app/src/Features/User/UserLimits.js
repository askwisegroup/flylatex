// FIXED: 2026-11-15 普通用户磁盘配额 / 单文件大小限制的服务端强制入口
// 设计目标：
// - 只有「有用户上下文」的路径才检查，系统内部调用（userId 为空）保持原行为；
// - 使用短 TTL 缓存，避免一次上传多个文件时反复全量统计；
// - 任何统计异常都降级放行，避免因为 usage 统计失败导致用户完全不能上传。
const logger = require('@overleaf/logger')
const UserGetter = require('./UserGetter')
const UserVip = require('./UserVip')
const UserUsageController = require('./UserUsageController')
const {
  StorageQuotaExceededError,
  FileTooLargeError,
} = require('../Errors/Errors')

const LIMITS_CACHE_TTL_MS = 30 * 1000
const USAGE_CACHE_TTL_MS = 30 * 1000

const limitsCache = new Map()
const usageCache = new Map()
const pendingUsage = new Map()

function cacheKey(userId) {
  return String(userId)
}

function readCache(cache, key, ttlMs) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.cachedAt < ttlMs) {
    return hit.value
  }
  if (hit) {
    cache.delete(key)
  }
  return undefined
}

function writeCache(cache, key, value) {
  cache.set(key, { value, cachedAt: Date.now() })
}

async function getUserLimits(userId) {
  if (!userId) {
    // 没有用户上下文时按普通用户处理，保证匿名上传也不会绕过单文件大小限制。
    return UserVip.getLimitsForUser(null)
  }

  const key = cacheKey(userId)
  const cached = readCache(limitsCache, key, LIMITS_CACHE_TTL_MS)
  if (cached) {
    return cached
  }

  let user = null
  try {
    user = await UserGetter.promises.getUser(userId, {
      vipEndDate: 1,
      vipExpired: 1,
    })
  } catch (err) {
    logger.warn({ err, userId }, '[user-limits] failed to load user, fallback')
  }

  const limits = UserVip.getLimitsForUser(user)
  writeCache(limitsCache, key, limits)
  return limits
}

async function getUserUsage(userId) {
  const key = cacheKey(userId)
  const cached = readCache(usageCache, key, USAGE_CACHE_TTL_MS)
  if (cached) {
    return cached
  }
  if (pendingUsage.has(key)) {
    return pendingUsage.get(key)
  }

  const promise = UserUsageController.calculateUserUsage(userId)
    .then(usage => {
      writeCache(usageCache, key, usage)
      return usage
    })
    .finally(() => {
      pendingUsage.delete(key)
    })

  pendingUsage.set(key, promise)
  return promise
}

function invalidateUsage(userId) {
  usageCache.delete(cacheKey(userId))
}

function invalidateUser(userId) {
  limitsCache.delete(cacheKey(userId))
  usageCache.delete(cacheKey(userId))
}

/**
 * 校验「再写入 additionalBytes 后」是否还低于磁盘上限。
 * 统计失败时降级放行，避免影响正常使用。
 */
async function assertStorageAvailable(userId, additionalBytes = 0) {
  if (!userId) {
    return
  }
  const limits = await getUserLimits(userId)
  if (!limits.storageBytes) {
    return
  }

  let usage
  try {
    usage = await getUserUsage(userId)
  } catch (err) {
    logger.warn(
      { err, userId },
      '[user-limits] failed to calculate usage, allow upload'
    )
    return
  }

  const usedBytes = Number(usage?.totalSize) || 0
  const requestedBytes = Math.max(0, Number(additionalBytes) || 0)
  const nextBytes = usedBytes + requestedBytes
  if (nextBytes > limits.storageBytes) {
    throw new StorageQuotaExceededError({
      message: 'storage quota exceeded',
      info: {
        usedBytes,
        requestedBytes,
        limitBytes: limits.storageBytes,
      },
    })
  }
}

async function assertFileSizeAllowed(userId, size) {
  if (!userId) {
    // 系统内部导入（例如后台任务）没有用户上下文，保持原行为。
    return
  }
  const limits = await getUserLimits(userId)
  if (!limits.maxUploadSize) {
    return
  }
  if (Number(size) > limits.maxUploadSize) {
    throw new FileTooLargeError({
      message: 'file too large',
      info: {
        size: Number(size),
        limitBytes: limits.maxUploadSize,
      },
    })
  }
}

module.exports = {
  getUserLimits,
  getUserUsage,
  assertStorageAvailable,
  assertFileSizeAllowed,
  invalidateUsage,
  invalidateUser,
  _caches: { limitsCache, usageCache },
}
