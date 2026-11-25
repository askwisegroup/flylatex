'use strict'

/**
 * FlyLaTeX SSO · T2 第一跳：`GET /sso/authorize`
 *
 * ---------------------------------------------------------------------------
 * 这个端点最重要的性质：**在确认 redirect_uri 可信之前，一个字都不能跳**
 * ---------------------------------------------------------------------------
 * OAuth2 里所有「参数校验失败就跳回去带上 error」的写法，都建立在一个前提上：
 * redirect_uri 已经确认属于这个 client_id。顺序反了就是开放重定向 ——
 * 攻击者构造
 *
 *     /sso/authorize?client_id=word2latex&redirect_uri=https://evil.com
 *                     &response_type=bogus
 *
 * 我们「体贴地」跳回去带 `error=unsupported_response_type`，用户就被送到了
 * evil.com，而且是从 www.example.com 跳过去的（钓鱼页可以显示「来自 FlyLaTeX」）。
 *
 * 所以顺序固定为：
 *   ① client_id 存在吗   → 否则 400 纯文本，不跳
 *   ② redirect_uri 全等吗 → 否则 400 纯文本，不跳
 *   ③ 以上都通过，redirect_uri 可信 → 后面所有错误才允许跳回去（带 state）
 *
 * ---------------------------------------------------------------------------
 * 为什么强制 state
 * ---------------------------------------------------------------------------
 * `state` 表面上是给客户端防 CSRF 用的，服务器校验不了它的内容。但**要求它
 * 存在**能挡掉一整类登录 CSRF：
 *
 *   攻击者用自己的浏览器登录 FlyLaTeX，拿到 client=X 的 code；
 *   再诱骗受害者访问 X 的回调地址带上这个 code；
 *   受害者就被登录进了**攻击者的 X 账号**，接着把文档传进攻击者的空间。
 *
 * 客户端只要老老实实比对 state 就挡住了；而我们要求每个请求都带 state，
 * 就是在逼客户端老实。第一方应用多写一行 `crypto.randomUUID()` 而已。
 *
 * ---------------------------------------------------------------------------
 * 未登录怎么处理
 * ---------------------------------------------------------------------------
 * 不在本文件里做。`requireLogin()` 由 router.js 挂在这一跳前面 ——
 * 它会把**完整 URL（含 query）**写进 `session.postLoginRedirect`
 * （已用 UrlHelper 验证：`/sso/authorize?...` 连同 query 原样保留），
 * 登录回来后 `finishLogin()` 送回这里，用户完全无感。
 */

const Codes = require('./Codes')

/**
 * 把参数拼到已注册的 redirect_uri 上。
 *
 * 用 `URL` + `searchParams` 而不是字符串拼接：注册的地址可能自带 query
 * （`?from=sso`），手拼会把 `?` 变成第二个 `?`。
 */
function buildRedirect(redirectUri, params) {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, value)
  }
  return url.toString()
}

/** redirect_uri 还没确认可信时，只能纯文本回复，绝不能构造任何跳转。 */
function rejectPlain(res, description) {
  res.status(400).type('text/plain; charset=utf-8')
  res.send(`SSO 授权请求无效：${description}`)
}

/**
 * @param {{registry: object, codes: ReturnType<typeof Codes.createCodeService>,
 *          getUser: (req: object) => object|null}} deps
 */
function createAuthorizeHandler({ registry, codes, getUser }) {
  if (!registry) throw new Error('createAuthorizeHandler requires a registry')
  if (!codes) throw new Error('createAuthorizeHandler requires a code service')
  if (typeof getUser !== 'function') {
    throw new Error('createAuthorizeHandler requires getUser()')
  }

  return function authorizeHandler(req, res, next) {
    // 返回 promise 是给测试用的（express 会忽略返回值），这样测试可以 await
    // 而不用靠 setTimeout 猜「异步做完了没有」。
    return run().catch(next)

    async function run() {
      const query = req.query || {}

      // ① client_id —— 未知客户端不可能有可信的 redirect_uri
      const client = registry.get(query.client_id)
      if (!client) {
        return rejectPlain(res, '未知的 client_id')
      }

      // ② redirect_uri —— 只认全等（loopback 例外见 Clients.js）
      if (!registry.verifyRedirectUri(client, query.redirect_uri)) {
        return rejectPlain(res, 'redirect_uri 未注册')
      }

      // ③ 从此 redirect_uri 可信，错误可以带着 state 跳回去
      const state = typeof query.state === 'string' ? query.state : ''
      const back = params =>
        res.redirect(buildRedirect(query.redirect_uri, { ...params, state }))

      if (!state) {
        // state 缺失时没法跳（跳过去也无法让客户端校验），只能明文拒绝。
        return rejectPlain(
          res,
          '缺少 state（本服务器要求所有授权请求带 state）'
        )
      }

      if (query.response_type !== 'code') {
        return back({ error: 'unsupported_response_type' })
      }

      const scopes = registry.resolveScopes(client, query.scope)
      if (!scopes) {
        return back({
          error: 'invalid_scope',
          error_description: '请求的 scope 超出该应用被授权的范围',
        })
      }

      // PKCE：对强制 PKCE 的客户端，缺 challenge 直接拒；
      // 无论如何都只支持 S256（plain 等于没有 PKCE，RFC 7636 §7.2）。
      if (query.code_challenge) {
        if (query.code_challenge_method !== 'S256') {
          return back({
            error: 'invalid_request',
            error_description: '仅支持 code_challenge_method=S256',
          })
        }
        if (!Codes.isChallenge(query.code_challenge)) {
          return back({
            error: 'invalid_request',
            error_description: 'code_challenge 格式非法',
          })
        }
      } else if (client.requirePkce) {
        return back({
          error: 'invalid_request',
          error_description: '该应用必须使用 PKCE（code_challenge）',
        })
      }

      // 同意页属于 M3。在那之前，非 trusted 的客户端**直接拒绝**而不是静默放行：
      // 用户从未看到「你正在把身份交给谁」，那就不叫授权。
      if (!client.trusted) {
        return back({
          error: 'access_denied',
          error_description: '该应用尚未通过审核（授权同意页尚未开放）',
        })
      }

      const user = getUser(req)
      if (!user || user._id == null) {
        // 正常情况下 requireLogin() 已经拦住了。走到这里说明中间件顺序错了，
        // 这属于配置 bug，不能让浏览器看到一个空跳转。
        return next(new Error('authorize reached without a logged-in user'))
      }

      const code = await codes.issue({
        userId: user._id,
        clientId: client.id,
        redirectUri: query.redirect_uri,
        scopes,
        codeChallenge: query.code_challenge || null,
        codeChallengeMethod: query.code_challenge_method || null,
      })

      // 302 而不是 303：浏览器端拿到 code 就该立刻发起客户端自己的请求，
      // 用 302 保持与绝大多数 OAuth 服务器的行为一致（某些老客户端库只认 302）。
      return back({ code })
    }
  }
}

module.exports = { createAuthorizeHandler, buildRedirect, rejectPlain }
