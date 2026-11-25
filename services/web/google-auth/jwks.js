'use strict'

/**
 * Google ID Token 公钥（JWKS）拉取与缓存。
 *
 * FIXED: 2026-11-12 从已验证的原型 a local prototype repo
 * 移植（sdk/google-auth.node.js 的 loadJwks）。移植时做了三处**有意**的改动：
 *
 *   1. ESM → CommonJS：web 服务整个是 CJS，`require()` 一个 `.js` 的 ESM 文件
 *      在 Node 22 上仍需实验开关，不能依赖。
 *   2. `fetch` → `https.request`：本仓库其它出站调用（llm-relay / llm-models /
 *      crosrefsearch）都用 node 原生模块，且**原生 fetch 不读 HTTPS_PROXY**。
 *      海外机器常见"必须走代理才能到 googleapis"的网络，fetch 会直接失败。
 *   3. 缓存目录改为 `os.tmpdir()` 默认值：原型的 `.cache/` 挂在 cwd 下，
 *      容器里 cwd 可能是只读的，写盘失败会掩盖真正的网络错误。
 *
 * 缓存层次（自原型保留，生产已验过）：内存 → 磁盘 → 网络 → 陈旧缓存兜底。
 */

const https = require('https')
const http = require('http')
const fsp = require('fs').promises
const os = require('os')
const path = require('path')

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const JWKS_TTL_MS = 6 * 60 * 60 * 1000
const JWKS_MIN_TTL_MS = 30 * 60 * 1000
const JWKS_MAX_TTL_MS = 12 * 60 * 60 * 1000
const JWKS_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = Number(process.env.GOOGLE_JWKS_TIMEOUT_MS) || 8000

const DEFAULT_CACHE_FILE =
  process.env.GOOGLE_JWKS_CACHE_FILE ||
  path.join(os.tmpdir(), 'flylatex-google-jwks.json')

let jwksCache = { at: 0, keys: new Map(), source: null, ttl: 0 }
let jwksInflight = null
let diskLoaded = false

/* ------------------------------------------------------------------ */
/* HTTP 传输                                                          */
/* ------------------------------------------------------------------ */

/**
 * 有代理走代理，没代理直连。
 *
 * `https-proxy-agent` 在 v5 是 `module.exports = HttpsProxyAgent`，
 * 在 v7 是 `{ HttpsProxyAgent }`。两种都兼容 —— 包装版本由 lockfile 决定，
 * 这里不能假设。
 */
function proxyAgentFor(targetUrl) {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (!proxy) return undefined
  try {
    // `https-proxy-agent` 未在 services/web/package.json 里声明，但与
    // commercial/real-sub-agents.js:367 的用法一致（本仓库既有做法）。
    // require 包在 try/catch 里：包缺失时自动退回直连，不影响登录。
    // eslint-disable-next-line import/no-extraneous-dependencies
    const mod = require('https-proxy-agent')
    const Agent = mod.HttpsProxyAgent || mod
    return new Agent(proxy)
  } catch (error) {
    // 代理包不可用时不阻断：直连可能仍然可达。
    return undefined
  }
}

/**
 * GET 一个 JSON。
 * @returns {Promise<{status:number, headers:object, body:any}>}
 */
function getJson(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      return reject(Object.assign(new Error('bad_url'), { unreachable: false }))
    }
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: target.pathname + target.search,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'FlyLaTeX-Auth' },
        agent: proxyAgentFor(url),
        timeout: timeoutMs,
      },
      response => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          raw += chunk
          // JWKS 约 5KB；4MB 只是防失控，不是业务上限。
          if (raw.length > 4 * 1024 * 1024) raw = raw.slice(0, 4 * 1024 * 1024)
        })
        response.on('end', () => {
          let body = null
          try {
            body = raw ? JSON.parse(raw) : null
          } catch (error) {
            body = null
          }
          resolve({
            status: response.statusCode || 0,
            headers: response.headers || {},
            body,
          })
        })
      }
    )
    request.on('error', error => {
      reject(Object.assign(error, { unreachable: true }))
    })
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('jwks_timeout'), { unreachable: true }))
    })
    request.end()
  })
}

/* ------------------------------------------------------------------ */
/* 磁盘缓存                                                           */
/* ------------------------------------------------------------------ */

async function readDiskCache() {
  try {
    const raw = await fsp.readFile(DEFAULT_CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.keys)) return null
    const keys = new Map()
    for (const jwk of parsed.keys) {
      if (jwk && jwk.kid) keys.set(jwk.kid, jwk)
    }
    if (!keys.size) return null
    return {
      at: Number(parsed.at) || 0,
      keys,
      source: 'disk',
      ttl: Number(parsed.ttl) || JWKS_TTL_MS,
    }
  } catch (error) {
    return null
  }
}

async function writeDiskCache(keys, ttl) {
  try {
    await fsp.writeFile(
      DEFAULT_CACHE_FILE,
      JSON.stringify({ at: Date.now(), ttl, keys: [...keys.values()] }),
      { mode: 0o600 }
    )
  } catch (error) {
    // 只读文件系统（容器常见）不影响功能，内存缓存已足够。
  }
}

function ttlFromHeaders(headers) {
  const match = /max-age=(\d+)/i.exec(String(headers['cache-control'] || ''))
  if (!match) return JWKS_TTL_MS
  return Math.min(
    Math.max(Number(match[1]) * 1000, JWKS_MIN_TTL_MS),
    JWKS_MAX_TTL_MS
  )
}

/* ------------------------------------------------------------------ */
/* 主入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {boolean} [force] 忽略新鲜度，强制刷新（kid 轮换自愈用）
 * @returns {Promise<Map<string, object>>} kid → JWK
 */
async function loadJwks(force = false) {
  const fresh =
    jwksCache.keys.size > 0 &&
    Date.now() - jwksCache.at < (jwksCache.ttl || JWKS_TTL_MS)
  if (!force && fresh) return jwksCache.keys
  if (jwksInflight) return jwksInflight

  jwksInflight = (async () => {
    if (!diskLoaded && jwksCache.keys.size === 0) {
      diskLoaded = true
      const cached = await readDiskCache()
      if (cached && Date.now() - cached.at < JWKS_MAX_STALE_MS) {
        jwksCache = cached
        if (!force && Date.now() - cached.at < (cached.ttl || JWKS_TTL_MS)) {
          return cached.keys
        }
      }
    }

    try {
      const response = await getJson(JWKS_URL)
      if (response.status !== 200) {
        throw Object.assign(new Error(`jwks_http_${response.status}`), {
          unreachable: true,
        })
      }
      const ttl = ttlFromHeaders(response.headers)
      const keys = new Map()
      for (const jwk of (response.body && response.body.keys) || []) {
        if (jwk && jwk.kid && jwk.kty === 'RSA') keys.set(jwk.kid, jwk)
      }
      if (!keys.size) throw new Error('jwks_empty')

      jwksCache = { at: Date.now(), keys, source: 'network', ttl }
      await writeDiskCache(keys, ttl)
      return keys
    } catch (error) {
      // 网络不可达时用陈旧缓存兜底：Google 的公钥轮换有重叠期，
      // 7 天内的旧公钥基本仍可验签，比"整个登录不可用"好得多。
      const stale =
        jwksCache.keys.size > 0 ? jwksCache : await readDiskCache()
      if (stale && Date.now() - stale.at < JWKS_MAX_STALE_MS) {
        jwksCache = stale
        console.warn(
          `[google-auth] JWKS 拉取失败（${error.message}），改用${
            stale.source === 'disk' ? '磁盘' : '内存'
          }缓存（${Math.round((Date.now() - stale.at) / 60000)} 分钟前）`
        )
        return stale.keys
      }
      throw Object.assign(error, { unreachable: true })
    }
  })().finally(() => {
    jwksInflight = null
  })

  return jwksInflight
}

/** 仅供测试：清空进程内缓存。 */
function _resetCache() {
  jwksCache = { at: 0, keys: new Map(), source: null, ttl: 0 }
  jwksInflight = null
  diskLoaded = false
}

module.exports = {
  JWKS_URL,
  JWKS_TTL_MS,
  JWKS_MAX_STALE_MS,
  loadJwks,
  getJson,
  _resetCache,
  DEFAULT_CACHE_FILE,
}
