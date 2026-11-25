'use strict'

/**
 * FlyLaTeX SSO · 极小的 KV 抽象
 *
 * ---------------------------------------------------------------------------
 * 为什么不用 Mongo
 * ---------------------------------------------------------------------------
 * SSO 要存的东西只有两类，都**短命**：
 *
 *   1. authorization code —— 60 秒、一次性、每次授权写一条；
 *   2. access token      —— 10 分钟、以校验为主。
 *
 * 两者的共同点是「天生适合 TTL」，Redis 的 `SETEX` / `GET` / `DEL` 正好
 * 一一对应。塞进 Mongo 反而要为「过期清理」和「一次性语义」各写一套定时任务。
 * 刻意**不复用** `models/Oauth{Application,AccessToken,AuthorizationCode}.js`：
 * 那三张表是 server-pro git-bridge 的语义（字段、生命周期都不同），
 * 混用会让两边都改不动，详见 docs/sso-provider-design.md §6。
 *
 * ---------------------------------------------------------------------------
 * 为什么不用 app/src/infrastructure/RateLimiter.js
 * ---------------------------------------------------------------------------
 * 它在**模块加载时**就 `RedisWrapper.client('ratelimiter')` 建立连接：
 *
 *     const rclient = RedisWrapper.client('ratelimiter')   // ← 顶层副作用
 *
 * 一旦 SSO 模块 require 它，本目录的单元测试就全都要有 Redis 才能跑起来。
 * 而我们只需要一个固定窗口计数，`bump()` 十几行就够了。
 *
 * ---------------------------------------------------------------------------
 * 两种实现
 * ---------------------------------------------------------------------------
 *   · `redisStore(client)` —— 生产。用 `@overleaf/redis-wrapper` 的 ioredis
 *     风格 promise API（`await client.setex(k, ttl, v)` / `get` / `del`），
 *     与 ZoteroController.js 里的用法一致。
 *   · `memoryStore()` —— 测试用，也是「没配 Redis」时的兜底（单进程）。
 *
 * 两种实现都只暴露四个方法，上层（Codes / Tokens）不关心背后是什么。
 */

/**
 * 固定窗口计数器的 key 前缀。与业务 key 分开，便于在 Redis 里单独清理。
 */
function counterKey(key) {
  return `sso:count:${key}`
}

/**
 * @param {object} client 已建好连接的 redis 客户端
 */
function redisStore(client) {
  return {
    async get(key) {
      const value = await client.get(key)
      return value == null ? null : String(value)
    },

    async setex(key, ttlSeconds, value) {
      await client.setex(key, ttlSeconds, value)
    },

    /**
     * 必须返回**真正删除的条数**（0 或 1）。
     * Codes.consume() 靠这个返回值做「一次性」的原子判定：
     * 两个并发请求都能 GET 到同一个 code，但只有一条 DEL 会拿到 1。
     */
    async del(key) {
      return Number(await client.del(key))
    },

    async bump(key, ttlSeconds) {
      const full = counterKey(key)
      const count = Number(await client.incr(full))
      // 只在第一次自增时设过期，避免每请求都续期把窗口变成「滑动的」。
      if (count === 1) await client.expire(full, ttlSeconds)
      return count
    },
  }
}

/**
 * 单进程内存实现。刻意也做 TTL：否则测试里跑完不清理会互相污染。
 */
function memoryStore() {
  /** @type {Map<string, {value: string, expiresAt: number}>} */
  const data = new Map()
  /** @type {Map<string, {count: number, expiresAt: number}>} */
  const counters = new Map()

  function live(table, key) {
    const entry = table.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      table.delete(key)
      return null
    }
    return entry
  }

  return {
    async get(key) {
      const entry = live(data, key)
      return entry ? entry.value : null
    },

    async setex(key, ttlSeconds, value) {
      data.set(key, {
        value: String(value),
        expiresAt: Date.now() + ttlSeconds * 1000,
      })
    },

    async del(key) {
      const entry = live(data, key)
      if (!entry) return 0
      data.delete(key)
      return 1
    },

    async bump(key, ttlSeconds) {
      const full = counterKey(key)
      const entry = live(counters, full)
      if (!entry) {
        counters.set(full, {
          count: 1,
          expiresAt: Date.now() + ttlSeconds * 1000,
        })
        return 1
      }
      entry.count += 1
      return entry.count
    },
  }
}

module.exports = { redisStore, memoryStore }
