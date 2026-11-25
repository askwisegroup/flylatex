'use strict'

/**
 * FlyLaTeX SSO · T2 第二跳：`POST /sso/token`
 *
 * ---------------------------------------------------------------------------
 * 这个端点是**服务器到服务器**的，所以三条规矩和别的端点不一样
 * ---------------------------------------------------------------------------
 * 1. **不能有 CSRF 校验**。请求来自客户端后端（word2latex 的 Next.js 进程），
 *    既没有浏览器 cookie 也没有 CSRF token。所以它必须挂在 `publicApiRouter`
 *    上 —— `webRouter` 全体套了 `webRouter.csrf.middleware`，挂错就直接 403。
 *    （这不是「关掉 CSRF 换个方便」，而是 CSRF 这个概念在这里不适用：
 *    请求的授权凭据是 client_secret + code_verifier，不是用户的 cookie。）
 *
 * 2. **不能依赖 session**。同一个理由：服务端请求不带用户 cookie。
 *    code 本身就承载了「是谁」的信息。
 *
 * 3. **响应必须 `Cache-Control: no-store`**。token 被任何中间层缓存都等于泄漏。
 *
 * ---------------------------------------------------------------------------
 * 为什么 client 认证支持两种传法
 * ---------------------------------------------------------------------------
 * RFC 6749 §2.3.1 规定用 HTTP Basic（`client_id:client_secret` 各自 URL 编码后
 * Base64）；实际世界里大量客户端用 body 里的 `client_id` + `client_secret`。
 * 两种都收，是因为我们的第一方客户端是手写的，而以后接 MCP / 桌面端 / 第三方
 * 时几乎一定会遇到只支持其中一种的库。收两种不会降低安全性 —— 两种都在
 * TLS 通道内，差别只是放在哪个字段。
 *
 * ---------------------------------------------------------------------------
 * 为什么先烧 code 再校验 verifier
 * ---------------------------------------------------------------------------
 * 见 Codes.js：失败的换 token 尝试也应该让 code 立刻失效。宁可让用户重走一次
 * 授权（60 秒的事），也不要留一个「校验不过但还有效」的 code。
 */

const OAuthError = require('./OAuthError')

/** 每个客户端每分钟允许的换 token 次数。 */
const TOKEN_RATE_LIMIT = 30
const TOKEN_RATE_WINDOW_SECONDS = 60

function noStore(res) {
  res.set('Cache-Control', 'no-store')
  res.set('Pragma', 'no-cache')
  return res
}

/**
 * 从 Basic 头或 body 里取出客户端凭据。
 *
 * RFC 6749 §2.3.1 要求 Basic 里的 id/secret 先做 `application/x-www-form-urlencoded`
 * 再 Base64 —— 所以这里要 decodeURIComponent 一次，否则含特殊字符的 secret
 * （我们生成的 secret 就含 `&` 和 `^`）会校验失败。
 */
function readClientCredentials(req) {
  const body = req.body || {}
  const header = req.headers && req.headers.authorization
  if (typeof header === 'string' && /^basic /i.test(header)) {
    let decoded = ''
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
    } catch {
      return { clientId: '', clientSecret: '', fromBasic: true }
    }
    const separator = decoded.indexOf(':')
    if (separator === -1) {
      return { clientId: '', clientSecret: '', fromBasic: true }
    }
    const decode = value => {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
    return {
      clientId: decode(decoded.slice(0, separator)),
      clientSecret: decode(decoded.slice(separator + 1)),
      fromBasic: true,
    }
  }

  return {
    clientId: body.client_id ? String(body.client_id) : '',
    clientSecret: body.client_secret ? String(body.client_secret) : '',
    fromBasic: false,
  }
}

/**
 * @param {{registry: object, codes: ReturnType<typeof import('./Codes').createCodeService>,
 *          tokens: ReturnType<typeof import('./Tokens').createTokenService>,
 *          store: object,
 *          rateLimit?: number, rateWindowSeconds?: number}} deps
 */
function createTokenHandler({
  registry,
  codes,
  tokens,
  store,
  rateLimit = TOKEN_RATE_LIMIT,
  rateWindowSeconds = TOKEN_RATE_WINDOW_SECONDS,
}) {
  if (!registry) throw new Error('createTokenHandler requires a registry')
  if (!codes) throw new Error('createTokenHandler requires a code service')
  if (!tokens) throw new Error('createTokenHandler requires a token service')
  if (!store) throw new Error('createTokenHandler requires a store')

  return function tokenHandler(req, res, next) {
    // 注意：OAuthError **不能**交给 next() ——
    // publicApiRouter 后面跟的是 ErrorController.handleApiError，它会把任何
    // 错误包装成 500。而 invalid_grant 必须是 400 + `{error,error_description}`，
    // 否则客户端库会把它当服务器故障反复重试。
    return run().catch(error => {
      if (error instanceof OAuthError) {
        noStore(res)
        return res.status(error.status).json(error.toJSON())
      }
      return next(error)
    })

    async function run() {
      const body = req.body || {}

      // grant_type 不合格先拒，避免无谓地碰 code（每次都烧掉一个 code 太贵）。
      if (body.grant_type !== 'authorization_code') {
        throw new OAuthError(
          'unsupported_grant_type',
          '仅支持 authorization_code'
        )
      }

      const { clientId, clientSecret } = readClientCredentials(req)
      const client = registry.get(clientId)
      if (!client) {
        throw new OAuthError('invalid_client', '未知的 client_id', 401)
      }

      // 限流按 client_id 计数：需要防的是「拿一个 client 的 id 去暴力猜 secret」，
      // 不是防用户。按 IP 计会把同一个出口 NAT 后的所有请求算在一起。
      const hits = await store.bump(`token:${client.id}`, rateWindowSeconds)
      if (hits > rateLimit) {
        throw new OAuthError(
          'temporarily_unavailable',
          '请求过于频繁，请稍后重试',
          429
        )
      }

      if (client.secret) {
        if (!registry.verifySecret(client, clientSecret)) {
          throw new OAuthError('invalid_client', 'client_secret 不正确', 401)
        }
      } else if (!body.code_verifier) {
        // public client（无 secret）只能靠 PKCE 证明「我就是发起授权的那一方」。
        // 没有 verifier 的 public client 请求等于任何人都能换 token。
        throw new OAuthError(
          'invalid_client',
          'public client 必须使用 PKCE',
          401
        )
      }

      if (!body.code) {
        throw new OAuthError('invalid_request', '缺少 code')
      }
      if (!body.redirect_uri) {
        throw new OAuthError('invalid_request', '缺少 redirect_uri')
      }

      const granted = await codes.consume({
        code: body.code,
        clientId: client.id,
        redirectUri: String(body.redirect_uri),
        codeVerifier: body.code_verifier
          ? String(body.code_verifier)
          : undefined,
      })

      const issued = await tokens.issue({
        userId: granted.userId,
        clientId: client.id,
        scopes: granted.scopes,
      })

      noStore(res)
      return res.status(200).json({
        access_token: issued.accessToken,
        token_type: issued.tokenType,
        expires_in: issued.expiresIn,
        scope: issued.scope,
      })
    }
  }
}

module.exports = {
  createTokenHandler,
  readClientCredentials,
  TOKEN_RATE_LIMIT,
  TOKEN_RATE_WINDOW_SECONDS,
}
