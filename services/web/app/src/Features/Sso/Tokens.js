'use strict'

/**
 * FlyLaTeX SSO · access token
 *
 * ---------------------------------------------------------------------------
 * 为什么是不透明 token 而不是 JWT
 * ---------------------------------------------------------------------------
 * JWT 的好处是「无状态、不查库」，代价是**撤不回来**：签发出去 10 分钟之内，
 * 除非再维护一份黑名单（于是又不无状态了），否则用户被禁用、应用被下架都
 * 拦不住。
 *
 * 这里选不透明 token，因为我们的校验侧本来就只有 `/sso/userinfo` 一个端点、
 * 一个 Redis 查询，无状态带来的那点吞吐毫无意义；而「以后想撤就能撤」
 * （删 key、按用户批量删、按客户端批量删）是实实在在的能力。
 *
 * 存储只存 **SHA-256**，和 code 一样：Redis 里翻出来的东西不能直接当凭据用。
 *
 * 10 分钟 TTL 的理由：客户端拿到 token 后一般**立刻**调一次 `/sso/userinfo`
 * 就丢掉（word2latex 就是这样，它真正要的是本地 session）。TTL 短到
 * 泄漏了也来不及用，长到足够客户端在慢网络上重试。
 */

const crypto = require('node:crypto')

/** token 存活时间（秒）。 */
const TOKEN_TTL_SECONDS = 600

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function tokenKey(token) {
  return `sso:token:${sha256Hex(token)}`
}

/**
 * @param {{store: object, ttlSeconds?: number}} deps
 */
function createTokenService({ store, ttlSeconds = TOKEN_TTL_SECONDS }) {
  if (!store) throw new Error('createTokenService requires a store')

  return {
    /**
     * @param {{userId: string, clientId: string, scopes: string[]}} input
     * @returns {Promise<{accessToken: string, tokenType: string,
     *                    expiresIn: number, scope: string}>}
     */
    async issue(input) {
      const accessToken = crypto.randomBytes(32).toString('base64url')
      const scopes = Array.isArray(input.scopes) ? input.scopes : []
      const payload = {
        userId: String(input.userId),
        clientId: String(input.clientId),
        scopes,
      }
      await store.setex(
        tokenKey(accessToken),
        ttlSeconds,
        JSON.stringify(payload)
      )
      return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ttlSeconds,
        scope: scopes.join(' '),
      }
    },

    /**
     * 校验 token。无效/过期一律返回 null —— 调用方只需要一个「是/否」，
     * 细分「过期」还是「伪造」只会给攻击者提供探测信号。
     *
     * @param {string} accessToken
     * @returns {Promise<{userId: string, clientId: string, scopes: string[]}|null>}
     */
    async verify(accessToken) {
      if (typeof accessToken !== 'string' || accessToken === '') return null
      const raw = await store.get(tokenKey(accessToken))
      if (raw == null) return null
      try {
        const payload = JSON.parse(raw)
        if (!payload || !payload.userId) return null
        return {
          userId: String(payload.userId),
          clientId: String(payload.clientId),
          scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
        }
      } catch {
        return null
      }
    },
  }
}

module.exports = { TOKEN_TTL_SECONDS, createTokenService, tokenKey }
