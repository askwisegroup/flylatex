'use strict'

/**
 * FlyLaTeX SSO · authorization code
 *
 * ---------------------------------------------------------------------------
 * code 的三条硬规则
 * ---------------------------------------------------------------------------
 * 1. **一次性**。重放必须失败，且失败要发生在「已经确认这个 code 属于谁之前」，
 *    否则重放者能靠错误信息探测 code 是否存在。
 * 2. **60 秒**。够浏览器跳一下 + 客户端后端换 token，再长就是纯风险窗口。
 * 3. **绑死 client_id + redirect_uri + code_challenge**。换 token 时三者都要
 *    重新比对，任何一项不符即 `invalid_grant`。
 *
 * ---------------------------------------------------------------------------
 * 一次性是怎么做到原子的
 * ---------------------------------------------------------------------------
 * 只用 `GET` 不够（两个并发请求都会读到），只用 `DEL` 也不够（读不到内容）。
 * 做法是：
 *
 *     const raw = await store.get(key)     // 谁都可能读到
 *     const removed = await store.del(key) // 只有一条能拿到 1
 *     if (removed !== 1) → invalid_grant
 *
 * 并发时两个请求都读到同一个 `raw`，但 DEL 是原子的，只有一个返回 1。
 * 这比 `GETDEL` 更可移植（Redis 6.2 之前没有），也不需要 Lua 脚本。
 *
 * 代价是「失败的校验也会烧掉 code」—— 这是**故意的**：RFC 6749 §4.1.2 要求
 * 客户端在 code 使用失败后放弃它。让错误立刻失效，比留着一个「校验不过但还
 * 有效」的 code 安全。
 */

const crypto = require('node:crypto')
const OAuthError = require('./OAuthError')

/** code 存活时间（秒）。 */
const CODE_TTL_SECONDS = 60

/** RFC 7636 §4.1：code_verifier 是 43~128 个 unreserved 字符。 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/

/**
 * RFC 7636 §4.2：S256 challenge = BASE64URL(SHA256(ASCII(verifier)))，恒为 43 字符。
 * 校验格式而不是直接算，是为了在客户端把 verifier 和 challenge 搞反时
 * 给出可读的错误，而不是让用户看到「授权失败」四个字。
 */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

/** PKCE S256：由 verifier 算出 challenge。 */
function s256(verifier) {
  return crypto
    .createHash('sha256')
    .update(String(verifier))
    .digest('base64url')
}

/**
 * code 本身是 32 字节随机数（43 字符 base64url），
 * Redis key 用它的 SHA-256 —— 这样即使有人在 Redis 里翻 key，
 * 也拿不到能直接用的 code。
 */
function codeKey(code) {
  return `sso:code:${sha256Hex(code)}`
}

function isVerifier(value) {
  return typeof value === 'string' && VERIFIER_PATTERN.test(value)
}

function isChallenge(value) {
  return typeof value === 'string' && CHALLENGE_PATTERN.test(value)
}

/**
 * @param {{store: object, ttlSeconds?: number}} deps
 */
function createCodeService({ store, ttlSeconds = CODE_TTL_SECONDS }) {
  if (!store) throw new Error('createCodeService requires a store')

  return {
    /**
     * 签发 code。返回的是**明文 code**，只在此刻存在，之后只剩哈希。
     *
     * @param {{userId: string, clientId: string, redirectUri: string,
     *          scopes: string[], codeChallenge?: string|null,
     *          codeChallengeMethod?: string|null}} input
     * @returns {Promise<string>}
     */
    async issue(input) {
      const code = crypto.randomBytes(32).toString('base64url')
      const payload = {
        // 只存 _id，不存任何用户资料：60 秒后这份数据就可能被人翻出来，
        // 存得越少越安全。换取 token 时再按 userId 回表。
        userId: String(input.userId),
        clientId: String(input.clientId),
        redirectUri: String(input.redirectUri),
        scopes: Array.isArray(input.scopes) ? input.scopes : [],
        codeChallenge: input.codeChallenge || null,
        codeChallengeMethod: input.codeChallenge ? 'S256' : null,
      }
      await store.setex(codeKey(code), ttlSeconds, JSON.stringify(payload))
      return code
    },

    /**
     * 消费 code。成功返回 `{ userId, scopes }`，否则抛 OAuthError。
     *
     * @param {{code: string, clientId: string, redirectUri: string,
     *          codeVerifier?: string}} input
     * @returns {Promise<{userId: string, scopes: string[]}>}
     */
    async consume(input) {
      const code = input && input.code
      if (typeof code !== 'string' || code === '') {
        throw new OAuthError('invalid_grant', '缺少 code')
      }

      const key = codeKey(code)
      const raw = await store.get(key)
      if (raw == null) {
        throw new OAuthError('invalid_grant', 'code 无效或已过期')
      }

      const removed = await store.del(key)
      if (removed !== 1) {
        // 走到这里说明有人和我们同时拿着这个 code —— 只可能是窃取或重放。
        throw new OAuthError('invalid_grant', 'code 已被使用')
      }

      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new OAuthError('invalid_grant', 'code 内容损坏')
      }

      if (payload.clientId !== String(input.clientId)) {
        throw new OAuthError('invalid_grant', 'code 不属于该客户端')
      }
      if (payload.redirectUri !== String(input.redirectUri)) {
        throw new OAuthError('invalid_grant', 'redirect_uri 与授权时不一致')
      }

      if (payload.codeChallenge) {
        if (!input.codeVerifier) {
          throw new OAuthError('invalid_grant', '缺少 code_verifier')
        }
        if (!isVerifier(input.codeVerifier)) {
          throw new OAuthError('invalid_grant', 'code_verifier 格式非法')
        }
        if (s256(input.codeVerifier) !== payload.codeChallenge) {
          throw new OAuthError('invalid_grant', 'code_verifier 校验失败')
        }
      }

      return { userId: payload.userId, scopes: payload.scopes || [] }
    },
  }
}

module.exports = {
  CODE_TTL_SECONDS,
  createCodeService,
  s256,
  isVerifier,
  isChallenge,
  codeKey,
}
