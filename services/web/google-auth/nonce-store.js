'use strict'

/**
 * 一次性 nonce 存储（防 ID Token 重放）。
 *
 * 为什么不用原型的 MemoryStore：那是一个进程内 Map。web 服务是多进程 /
 * 多实例（pm2 cluster + 多容器），/nonce 落在 A 进程、/verify 落到 B 进程时，
 * 用户会看到一个毫无解释的 `nonce_required` —— 而且只在生产环境出现。
 *
 * 用 Redis 存，并用 Lua 保证「取出即删」是原子的：多次并发提交同一个
 * credential 时，只有第一次能拿到 nonce，其余全部失败。
 *
 * 提供 `createMemoryStore()` 是为了单测（RedisWrapper 在单测里会主动抛错）。
 */

const crypto = require('crypto')

const KEY_PREFIX = 'google-auth:nonce:'
const DEFAULT_TTL_SECONDS = 1800

// KEYS[1] = nonce key → 返回旧值并删除
const TAKE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`

function randomId() {
  // 32 字节 base64url ≈ 43 字符，远高于 google nonce 的实际需要。
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * @param {object} client ioredis 兼容客户端（需要 set / eval）
 * @param {object} [options]
 * @param {number} [options.ttlSeconds]
 * @param {string} [options.prefix] 便于多环境共用同一 Redis 时隔离
 */
function createRedisNonceStore(client, options = {}) {
  const ttlSeconds = options.ttlSeconds || DEFAULT_TTL_SECONDS
  const prefix = options.prefix || KEY_PREFIX

  return {
    /**
     * 发放一个 nonce，返回给浏览器。服务端只保存它本身，
     * 不保存任何用户信息 —— 此时用户还没被识别出来。
     */
    async issue() {
      const nonce = randomId()
      await client.set(prefix + nonce, '1', 'EX', ttlSeconds)
      return { nonce, expiresIn: ttlSeconds }
    },

    /**
     * 取出并删除。返回空字符串表示「不存在 / 已用过 / 已过期」。
     * @returns {Promise<string>}
     */
    async take(nonce) {
      if (!nonce || typeof nonce !== 'string') return ''
      try {
        const value = await client.eval(TAKE_SCRIPT, 1, prefix + nonce)
        return value ? '1' : ''
      } catch (error) {
        // eval 在某些托管的 Redis（禁 Lua）上会不可用。
        // 退化为非原子 get+del：仍然保证"用过即失效"，
        // 只放弃"并发首胜"。登录场景下这个退化是可接受的。
        const value = await client.get(prefix + nonce)
        if (!value) return ''
        await client.del(prefix + nonce)
        return '1'
      }
    },
  }
}

/** 单测与本地开发用的内存实现。 */
function createMemoryStore(options = {}) {
  const ttlMs = (options.ttlSeconds || DEFAULT_TTL_SECONDS) * 1000
  const map = new Map()

  return {
    async issue() {
      const nonce = randomId()
      map.set(nonce, { at: Date.now() })
      return { nonce, expiresIn: Math.floor(ttlMs / 1000) }
    },
    async take(nonce) {
      const entry = map.get(nonce)
      if (!entry) return ''
      map.delete(nonce) // 一次性：无论是否过期都删除
      if (Date.now() - entry.at > ttlMs) return ''
      return '1'
    },
    /** 仅供测试观察 */
    _size() {
      return map.size
    },
  }
}

module.exports = {
  KEY_PREFIX,
  DEFAULT_TTL_SECONDS,
  createRedisNonceStore,
  createMemoryStore,
  randomId,
}
