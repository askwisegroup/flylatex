'use strict'

/**
 * FlyLaTeX SSO · T2 第三跳：`GET /sso/userinfo`
 *
 * 响应体与 T0 的 `GET /sso/session` **完全同形**（同一份 Claims.buildClaims），
 * 差别只在于「凭什么相信你是谁」：
 *
 *   /sso/session   ← 同源 cookie
 *   /sso/userinfo  ← `Authorization: Bearer <access_token>`
 *
 * 这样下游只需要写一种解析逻辑：拿到 JSON 就当 claims 用，不必判断
 * 「这份身份是从 session 来的还是从 token 来的」。
 *
 * 401 的写法按 RFC 6750 §3：带上 `WWW-Authenticate: Bearer error="invalid_token"`。
 * 少了这个头，严格遵守规范的客户端库会把它当成网络错误重试到死。
 */

const Claims = require('./Claims')

function noStore(res) {
  res.set('Cache-Control', 'no-store')
  res.set('Pragma', 'no-cache')
  return res
}

/**
 * 取 Bearer token。
 *
 * `express-bearer-token` 已把 `Authorization: Bearer xxx` 解析到 `req.token`，
 * 但它挂在 app 级别，单元测试里没有。所以这里保留一个手写兜底 ——
 * 两处都能取到，且都不会把 token 写进日志。
 */
function readBearerToken(req) {
  if (req.token) return String(req.token)
  const header = req.headers && req.headers.authorization
  if (typeof header === 'string' && /^bearer /i.test(header)) {
    return header.slice(7).trim()
  }
  return ''
}

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Bearer error="invalid_token"')
  noStore(res)
  return res.status(401).json({
    error: 'invalid_token',
    error_description: 'access_token 无效或已过期',
  })
}

/**
 * @param {{tokens: ReturnType<typeof import('./Tokens').createTokenService>,
 *          loadUser: (userId: string) => Promise<object|null>}} deps
 */
function createUserInfoHandler({ tokens, loadUser }) {
  if (!tokens) throw new Error('createUserInfoHandler requires a token service')
  if (typeof loadUser !== 'function') {
    throw new Error('createUserInfoHandler requires loadUser()')
  }

  return function userInfoHandler(req, res, next) {
    return run().catch(next)

    async function run() {
      const payload = await tokens.verify(readBearerToken(req))
      if (!payload) return unauthorized(res)

      const user = await loadUser(payload.userId)
      if (!user) {
        // token 有效但用户已被删除 / 停用：当无效处理，不给任何细节。
        return unauthorized(res)
      }

      noStore(res)
      // 注意：这里传的是数据库里的 user，不是 session user —— 但 claims
      // 仍然只能经 buildClaims 逐字段产出，任何位置都不允许 spread。
      return res.status(200).json(Claims.buildClaims(user, payload.scopes))
    }
  }
}

module.exports = { createUserInfoHandler, readBearerToken }
