'use strict'

/**
 * FlyLaTeX SSO · 客户端注册表
 *
 * 注册来源：`config/internal-values.js` 的 `sso.clients`
 * （环境变量 `SSO_CLIENTS` 可覆盖，值是同一份 JSON）。**不落库**。
 *
 * ---------------------------------------------------------------------------
 * 为什么是静态配置而不是 Mongo 表 / 动态注册
 * ---------------------------------------------------------------------------
 * 生态里需要 SSO 的应用是**我们自己**的（模板系统、运营后台、白板、TikZ、
 * 桌面端、MCP），数量个位数、变更走发布流程。为这几个客户端做一张表 +
 * 一套 CRUD + 动态客户端注册（DCR），换来的是：
 *
 *   · 一个「谁能注册成 OAuth 客户端」的新攻击面（DCR 是恶意客户端的经典入口）；
 *   · 一份必须跟着代码一起开源、但线上又必须覆盖的配置；
 *   · 每次加应用都要连数据库改数据，而不是改一行部署配置。
 *
 * 静态配置的好处正好反过来：开源时 `internal-values.js` 被 example 覆盖成
 * `clients: []` → `/sso/*` 统一 404，一行私有配置都不用写进仓库
 * （holder code 的边界就落在这里）。
 *
 * ---------------------------------------------------------------------------
 * redirect_uri 为什么必须全等
 * ---------------------------------------------------------------------------
 * 子串匹配 / 前缀匹配 / 通配符 全部是已知的开放重定向与 code 窃取入口
 * （`https://app.example.com.evil.com`、`https://app.example.com/../`）。
 * 这里只认**字符串全等**，唯一的例外是 RFC 8252 §7.3 为桌面端规定的
 * loopback：`http://127.0.0.1:<任意端口>/<固定路径>`。
 * 端口必须放开，因为桌面端拿不到固定端口；**host 和 path 仍然全等**。
 */

const crypto = require('node:crypto')
const Claims = require('./Claims')

/**
 * `new URL('http://[::1]:3999/x').hostname` 会带上方括号，两种写法都收。
 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1']

/**
 * 把注册表原始值（数组，或 JSON 字符串）解析成客户端数组。
 *
 * 宽容地接受两种形状（部署时手写 JSON 很容易多套一层）：
 *   · `[ {...}, {...} ]`
 *   · `{ "clients": [ {...} ] }`
 *
 * @param {string|object|undefined|null} raw
 * @returns {object[]}
 */
function parseClientsConfig(raw) {
  if (raw == null || raw === '') return []
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`SSO 客户端注册表不是合法 JSON：${error.message}`)
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.clients
  if (!Array.isArray(list)) {
    throw new Error(
      'SSO 客户端注册表必须是数组，或 { "clients": [...] }'
    )
  }
  return list
}

/**
 * 归一化单个客户端配置。
 *
 * 同时接受 snake_case（OAuth 惯例）与 camelCase（JS 惯例），
 * 因为这两者在部署脚本和代码里都会出现，让配置写错一个大小写就 401
 * 是最没有意义的挫败感来源。
 */
function normalizeClient(raw, index) {
  const id = raw.client_id || raw.clientId
  if (!id || typeof id !== 'string') {
    throw new Error(`sso.clients[${index}] 缺少 client_id`)
  }

  const redirectUris = raw.redirect_uris || raw.redirectUris || []
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new Error(`sso.clients[${index}] (${id}) 缺少 redirect_uris`)
  }
  for (const uri of redirectUris) {
    // RFC 6749 §3.1.2：redirect_uri 不得带 fragment。
    // 带 fragment 的地址在浏览器里根本收不到 query，注册它一定是配错了。
    if (typeof uri !== 'string' || uri.includes('#')) {
      throw new Error(
        `sso.clients[${index}] (${id}) 的 redirect_uri 非法：${uri}`
      )
    }
  }

  const secret = raw.client_secret || raw.clientSecret || ''
  const scopes = raw.scopes || raw.allowed_scopes || Claims.SUPPORTED_SCOPES

  return {
    id,
    secret: typeof secret === 'string' ? secret : '',
    name: raw.name || id,
    redirectUris,
    scopes: Array.isArray(scopes) ? scopes : Claims.SUPPORTED_SCOPES,
    /**
     * trusted：第一方应用。跳过同意页。
     *
     * M2 只支持 trusted 的客户端 —— 同意页 + 授权记录属于 M3，
     * 在那之前**宁可直接拒绝**，也不要「静默授权」一个第三方应用：
     * 用户从未看到过「你正在把身份交给谁」，那就不叫授权。
     */
    trusted: raw.trusted === true,
    /**
     * 是否强制 PKCE。默认 true。
     *
     * 对一个只会被我们自己调用的授权服务器来说，强制 PKCE 的唯一代价是
     * 客户端多两行代码；收益是即使 code 被截获（内网 http 尤其现实），
     * 没有 code_verifier 也换不出 token。默认关掉它没有任何理由。
     */
    requirePkce: raw.require_pkce !== false && raw.requirePkce !== false,
    allowLoopback: raw.allow_loopback === true || raw.allowLoopback === true,
  }
}

/**
 * 比较密钥，长度不同直接判否（`timingSafeEqual` 要求等长，否则抛错）。
 */
function secretEquals(expected, actual) {
  if (!expected || !actual) return false
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(actual))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * @param {object[]} rawClients 已 parse 的原始配置数组
 */
function createRegistry(rawClients) {
  /** @type {Map<string, object>} */
  const byId = new Map()
  for (const [index, raw] of rawClients.entries()) {
    const client = normalizeClient(raw, index)
    if (byId.has(client.id)) {
      throw new Error(`客户端注册表里 client_id 重复：${client.id}`)
    }
    byId.set(client.id, client)
  }

  return {
    size: byId.size,

    /** 未注册的 client_id 一律返回 null —— 调用方据此返回 400/401，绝不跳转。 */
    get(clientId) {
      if (!clientId) return null
      return byId.get(String(clientId)) || null
    },

    /**
     * redirect_uri 校验。**只认全等**，外加 loopback 的端口豁免。
     *
     * @param {object} client
     * @param {string} candidate 请求里带过来的 redirect_uri
     * @returns {boolean}
     */
    verifyRedirectUri(client, candidate) {
      if (!client || typeof candidate !== 'string' || candidate === '') {
        return false
      }
      if (candidate.includes('#')) return false
      if (client.redirectUris.includes(candidate)) return true
      if (!client.allowLoopback) return false

      let url
      try {
        url = new URL(candidate)
      } catch {
        return false
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      if (!LOOPBACK_HOSTS.includes(url.hostname)) return false
      // loopback 例外只放开**端口**。带 query 的地址无法做稳定比对，直接拒。
      if (url.search) return false
      for (const registered of client.redirectUris) {
        let reg
        try {
          reg = new URL(registered)
        } catch {
          continue
        }
        if (!LOOPBACK_HOSTS.includes(reg.hostname)) continue
        if (reg.pathname === url.pathname && reg.protocol === url.protocol) {
          return true
        }
      }
      return false
    },

    /**
     * 校验 client_secret。
     *
     * public client（没有 secret）不在这里放行 —— 由调用方按「必须带 PKCE」
     * 单独处理，否则就成了「空 secret 就能过」。
     */
    verifySecret(client, secret) {
      if (!client) return false
      return secretEquals(client.secret, secret)
    },

    /**
     * 把请求里的 scope 收敛到「客户端允许 ∩ 服务器支持」。
     *
     * 与 Claims.parseScopes 的区别：那个是**宽容**的（丢弃未知 scope，给下游用），
     * 这个是**严格**的 —— 客户端请求了它没被授权使用的 scope 时，
     * RFC 6749 §3.3 要求返回 `invalid_scope`，而不是悄悄降级。
     * 悄悄降级的后果是客户端以为自己拿到了 email，实际没有，直到线上 500。
     *
     * @returns {string[]|null} null 表示 invalid_scope
     */
    resolveScopes(client, requested) {
      const allowed = client.scopes
      const parts = String(requested == null ? '' : requested)
        .split(/\s+/)
        .filter(Boolean)

      if (parts.length === 0) {
        // 没传 scope：给最小集。仍要在客户端允许范围内。
        const fallback = Claims.DEFAULT_SCOPES.filter(s => allowed.includes(s))
        return fallback.length > 0 ? fallback : null
      }

      const seen = new Set()
      for (const scope of parts) {
        if (!allowed.includes(scope)) return null
        seen.add(scope)
      }

      // 输出顺序稳定：openid 在前，其余按服务器声明顺序。
      return Claims.SUPPORTED_SCOPES.filter(s => seen.has(s))
    },
  }
}

module.exports = {
  parseClientsConfig,
  normalizeClient,
  secretEquals,
  createRegistry,
}
