'use strict'

/**
 * FlyLaTeX SSO · T0 前门：`GET /sso/session`
 *
 * ---------------------------------------------------------------------------
 * 这是给「同源」应用用的一条**零 token** 身份接口
 * ---------------------------------------------------------------------------
 * 白板（:3080）、运营系统、TikZ 资源库这些应用和本站同在 www.example.com 下，
 * 浏览器本来就会把 `sharelatex.sid` 带给它们。它们不需要 OAuth、不需要 API key、
 * 不需要后端共享密钥 —— 只要一次同源 fetch：
 *
 *   const res = await fetch('/sso/session', { credentials: 'include' })
 *   if (res.status === 401) location.href = (await res.json()).loginUrl
 *   else { const { user } = await res.json(); ... }   // user.sub 就是稳定身份
 *
 * 为什么这是首选而不是让所有人都走 OAuth：同源应用天然**无状态**。它每次请求
 * 都问一遍，所以 FlyLaTeX 一登出，它下一请求就拿到 401 —— 不存在「FlyLaTeX 退了、
 * 白板还认识你」这种用户割裂。OAuth 那条路（T2）要维护自己的 session 和登出
 * 广播，只在跨域 / 桌面端 / MCP 这些场景才值得付这个代价。
 *
 * ---------------------------------------------------------------------------
 * 安全边界（三条，改代码前先读）
 * ---------------------------------------------------------------------------
 * 1. **绝不下发 CORS 头**。没有 `Access-Control-Allow-Origin`，跨域 JS 读不到
 *    响应体，也就不存在「诱导用户浏览器访问 /sso/session 再偷走身份」的 CSRF 读取。
 *    谁要用这个接口，谁就必须和本站同源。
 * 2. **只输出 claims 白名单**（见 ./Claims.js），不透传 session。
 * 3. `Cache-Control: no-store` + `Vary: Cookie`：身份响应绝不能被任何中间层缓存，
 *    否则 A 用户可能拿到 B 的身份。
 */

// NOTE: 本文件在 app/src/Features/Sso/，所以：
//   ../Xxx            → app/src/Features/Xxx（Authentication / Helpers 在这里）
//   ../../infrastructure → app/src/infrastructure
// 2026-11-22 线上 500 就是因为这里写成了 ../infrastructure/RedisWrapper。
// 这些 require 是懒执行的，单元测试全绿也挡不住 —— 现在由 requires.test.js 静态检查。
const SessionManager = require('../Authentication/SessionManager')
const UrlHelper = require('../Helpers/UrlHelper')
const Claims = require('./Claims')

/**
 * 同源应用要拿到的 claim 全集。
 *
 * T0 是「本站自己的前端在问自己是谁」，不需要用户逐步授权，所以直接给全量；
 * 跨域场景走 T2，那时由 scope 参数决定。
 */
const SESSION_SCOPES = Claims.SUPPORTED_SCOPES

/**
 * 把任意输入收敛成一个安全的站内路径，失败返回 null。
 *
 * 复用 `UrlHelper.getSafeRedirectPath()`（登录流程用的同一把尺子）：
 * 它把值当作相对 URL 解析后只取 path+search+hash，`https://evil.com/x`
 * 会变成 `/x`，纯 `https://evil.com` 会变成 undefined。
 *
 * 额外拒绝三类：`/login`（会自循环）、`/sso/*`（会自指）、`/register`。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function sanitizeRedirect(value) {
  if (typeof value !== 'string' || value === '') return null
  let safe
  try {
    safe = UrlHelper.getSafeRedirectPath(value)
  } catch (err) {
    // Settings.siteUrl 缺失/非法时 new URL 会抛。身份接口不能因此 500。
    return null
  }
  if (!safe) return null
  if (/^\/(login|sso|register)(\/|\?|#|$)/.test(safe)) return null
  return safe
}

/**
 * 推断「登录完应该回到哪一页」。
 *
 * 优先级：
 *   1. `?redir=` 显式参数 —— 推荐用法，由调用方给出**自己那一页**的路径；
 *   2. 同源 `Referer` —— 兜底。子应用直接 `fetch('/sso/session')` 时，
 *      浏览器带的 Referer 就是用户当前所在的页面，猜得比 `/project` 准；
 *   3. 都没有 → 不给 redir，登录后按 FlyLaTeX 默认落 `/project`。
 *
 * 注意 2 只在 `Referer` 是绝对 URL 时才可信过来一点点：`getSafeRedirectPath`
 * 只保留 path，恶意站点伪造的 Referer 最多让我们跳到本站的别一页，无害。
 *
 * @param {object} req
 * @returns {string|null}
 */
function resolveRedirect(req) {
  const explicit = sanitizeRedirect(req.query && req.query.redir)
  if (explicit) return explicit

  const referer = req.headers && req.headers.referer
  if (typeof referer === 'string' && /^https?:\/\//i.test(referer)) {
    return sanitizeRedirect(referer)
  }
  return null
}

/**
 * `GET /sso/session`
 *
 * 200 `{ "user": { "sub": "...", "name": "...", "email": "...", "email_verified": false } }`
 * 401 `{ "error": "not_logged_in", "loginUrl": "/login?redir=%2Fwhiteboard%2F" }`
 *
 * 未登录**故意返回 401 而不是 302**：调用方是 JS，它要自己决定是跳登录页、
 * 还是先渲染只读界面。302 会把 fetch 变成一个被静默跟随的 HTML 页面，
 * 前端只能看到 `response.redirected === true` 这一条线索。
 */
function session(req, res) {
  res.set('Cache-Control', 'no-store')
  res.vary('Cookie')

  const user = req.session ? SessionManager.getSessionUser(req.session) : null

  if (!user || user._id == null) {
    const redirect = resolveRedirect(req)
    const loginUrl = redirect
      ? `/login?redir=${encodeURIComponent(redirect)}`
      : '/login'
    return res.status(401).json({ error: 'not_logged_in', loginUrl })
  }

  return res.json({ user: Claims.buildClaims(user, SESSION_SCOPES) })
}

module.exports = {
  session,
  // 导出给测试与 T2 复用
  sanitizeRedirect,
  resolveRedirect,
  SESSION_SCOPES,
}
