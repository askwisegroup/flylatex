'use strict'

/**
 * FIXED: 2026-11-20 清掉浏览器里互相顶牛的 session cookie。
 *
 * 背景（2026-11-19 的事故链）：
 *   1) 有一次发布让 cookieDomain 回落到 internal-values（example.com），
 *      于是 session cookie 从「host-only（www.example.com）」变成了
 *      「Domain=example.com」的跨子域 cookie；
 *   2) 配置回滚以后，服务器又开始写 host-only 的 cookie，但浏览器里那条
 *      Domain 版本的旧 cookie 谁也不会再更新它；
 *   3) 同一个名字、同一个 Path，域名不同就是两条 cookie。请求头按
 *      「创建时间早的在前」排序，而 express-session（cookie.parse）取**第一条**
 *      —— 于是被顶在前面的旧 cookie 永远赢，服务器每次请求都拿它去 Redis 找，
 *      找不到就现场生成一个新 session。
 *   4) 结果：登录页 GET 把公钥写进 session A，POST /login 读到的是全新的
 *      session B，解密失败 →「登录加密数据已失效或无效，请刷新登录页面后重试」。
 *      因为 cookie 每次都「新建又丢弃」，用户无论刷新多少次都不会好，只有把
 *      浏览器 cookie 清空才行。
 *
 * 这里做的事就是自动完成「清空那几条 cookie」：
 *   只要请求带了 session cookie，但没有任何一条能对上本次请求实际使用的
 *   session（说明都是废票），就
 *     - 把 host-only 版本和各层父域的 Domain 版本统统作废（Expires=1970），
 *     - 再用当前 session 补写一条 host-only 的 cookie，
 *   保证下一个请求手里只有一张有效票，登录就回到正常链路。
 *
 * 只在 Settings.cookieDomain 未配置（本服务只写 host-only cookie）时生效；
 * 显式配置了跨子域 cookie 的部署保持原样，不受影响。
 */
const Metrics = require('@overleaf/metrics')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const signature = require('cookie-signature')

const EPOCH = new Date(0)
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

function secret() {
  const security = Settings.security
  return (security && security.sessionSecret) || ''
}

/** 请求头里同名 cookie 的**全部**取值（按浏览器发送顺序，即创建时间早的在前） */
function cookieValues(header, name) {
  if (typeof header !== 'string' || !header || !name) return []
  const values = []
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    const raw = part.slice(index + 1).trim()
    try {
      values.push(decodeURIComponent(raw))
    } catch (error) {
      values.push(raw)
    }
  }
  return values
}

/** 's:<sid>.<sig>' → sid；签名不对就返回 null */
function unsign(value, sessionSecret) {
  if (typeof value !== 'string' || !value.startsWith('s:') || !sessionSecret) {
    return null
  }
  try {
    const sid = signature.unsign(value.slice(2), sessionSecret)
    return typeof sid === 'string' && sid ? sid : null
  } catch (error) {
    return null
  }
}

/**
 * 可能挂着旧 cookie 的域：当前主机、它的父域、以及曾经被误用过的
 * languageCookieDomain（就是事故里那条 Domain=example.com）。
 * 删一条不存在的 cookie 是无害的，所以这里宁可多列几个。
 */
function candidateDomains(hostname) {
  const domains = new Set()
  const host = String(hostname || '').toLowerCase()
  if (host && host.includes('.') && !IPV4.test(host)) {
    domains.add(host)
    const labels = host.split('.')
    if (labels.length > 2) domains.add(labels.slice(1).join('.'))
  }
  if (Settings.languageCookieDomain) {
    domains.add(String(Settings.languageCookieDomain).toLowerCase())
  }
  return domains
}

function attributes(extra) {
  const parts = ['Path=/']
  if (extra && extra.domain) parts.push(`Domain=${extra.domain}`)
  const expires = (extra && extra.expires) || EPOCH
  parts.push(`Expires=${expires.toUTCString()}`)
  parts.push(`Max-Age=${(extra && extra.maxAge) || 0}`)
  parts.push('HttpOnly')
  if (Settings.secureCookie) parts.push('Secure')
  if (Settings.sameSiteCookie) {
    const sameSite = String(Settings.sameSiteCookie)
    parts.push(
      `SameSite=${sameSite.charAt(0).toUpperCase() + sameSite.slice(1)}`
    )
  }
  return parts.join('; ')
}

function setCookies(res, headers) {
  for (const header of headers) {
    res.append('Set-Cookie', header)
  }
}

/**
 * 作废所有旧变体，然后用当前 session 补写一条（host-only，与 express-session
 * 自己的写法保持一致：'s:' + 签名，值做 URL 编码）。
 */
function purgeStaleCookies(req, res) {
  const name = Settings.cookieName
  const headers = [`${name}=; ${attributes()}`]
  for (const domain of candidateDomains(req.hostname)) {
    headers.push(`${name}=; ${attributes({ domain })}`)
  }
  const sessionSecret = secret()
  const sid = req.sessionID
  if (typeof sid === 'string' && sid && sessionSecret) {
    const value = encodeURIComponent('s:' + signature.sign(sid, sessionSecret))
    const maxAge = Math.max(
      0,
      Math.floor((Settings.cookieSessionLength || 86400000) / 1000)
    )
    const expires = new Date(Date.now() + maxAge * 1000)
    headers.push(
      `${name}=${value}; ${attributes({
        domain: Settings.cookieDomain || undefined,
        expires,
        maxAge,
      })}`
    )
  }
  setCookies(res, headers)
  return headers.length
}

function middleware(req, res, next) {
  try {
    // 只处理「本服务自己只写 host-only cookie」的部署
    if (Settings.cookieDomain) return next()
    const sessionSecret = secret()
    if (!sessionSecret) return next()
    const name = Settings.cookieName
    const values = cookieValues(req.headers && req.headers.cookie, name)
    if (!values.length) return next()
    const sids = values.map(value => unsign(value, sessionSecret))
    // 本次请求实际用的 session 就在其中 → 一切正常（可能只是残留了多余的一条）
    if (req.sessionID && sids.includes(req.sessionID)) return next()
    // 带了 cookie，却没有一条能对上：全是废票，正是「登录永远报加密失效」的状态
    const purged = purgeStaleCookies(req, res)
    Metrics.inc('session_cookie_purge')
    logger.warn(
      {
        cookieCount: values.length,
        signedCount: sids.filter(Boolean).length,
        purgedHeaders: purged,
        path: req.path,
      },
      'purging stale session cookies'
    )
  } catch (error) {
    // 清理失败绝不能挡住请求本身
    logger.error({ err: error }, 'failed to purge stale session cookies')
  }
  next()
}

module.exports = {
  middleware,
  cookieValues,
  candidateDomains,
}
