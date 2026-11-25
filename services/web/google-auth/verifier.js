'use strict'

/**
 * Google ID Token 校验。
 *
 * 从 a local prototype repo（sdk/google-auth.node.js）
 * 移植，只保留**纯校验**部分：签发方/受众/时效/nonce/邮箱验证。
 *
 * 有意**不移植**原型的 cookie + 会话 + 路由那一层（约 400 行）：
 * Overleaf 已有自己的 express-session + passport，再叠一套 `gid_session`
 * 等于两个真相源 —— 登出时清哪一个、过期以哪个为准，都会成为线上事故。
 * 这里只回答一个问题：**这个 credential 是不是 Google 给本应用签发的**。
 *
 * 信任模型与原型的结论一致：
 *   后端只接收 Google 签名的原始 JWT，不接受前端自报的 email/name。
 *   前端解码仅用于"校验中"的即时预览。
 */

const crypto = require('crypto')
const { loadJwks } = require('./jwks')
const { getJson } = require('./jwks')

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token='
const VALID_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
])
const CLOCK_SKEW_MS = 5 * 60 * 1000

const isTrue = value => value === true || value === 'true'
const isFalse = value => value === false || value === 'false'

function decodeSegment(segment) {
  if (typeof segment !== 'string' || !segment) throw new Error('missing_segment')
  const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  if (!value || typeof value !== 'object') throw new Error('bad_json')
  return value
}

/* ------------------------------------------------------------------ */
/* 签名                                                               */
/* ------------------------------------------------------------------ */

async function verifySignature(parts, header) {
  if (header.alg !== 'RS256') {
    throw Object.assign(new Error('unsupported_alg'), { fatal: true })
  }
  if (!header.kid) {
    throw Object.assign(new Error('missing_kid'), { fatal: true })
  }

  const signingInput = `${parts[0]}.${parts[1]}`
  const signature = Buffer.from(parts[2], 'base64url')

  let keys = await loadJwks()
  // Google 轮换密钥后，旧 kid 会先消失再出现在新集合里：强刷一次即自愈。
  if (!keys.has(header.kid)) keys = await loadJwks(true)

  const jwk = keys.get(header.kid)
  if (!jwk) throw Object.assign(new Error('unknown_kid'), { fatal: true })

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  return {
    valid: crypto.verify(
      'RSA-SHA256',
      Buffer.from(signingInput),
      publicKey,
      signature
    ),
    kid: header.kid,
  }
}

/* ------------------------------------------------------------------ */
/* claims                                                             */
/* ------------------------------------------------------------------ */

/**
 * @returns {Array<{id,label,ok,detail,fatal}>}
 */
function verifyClaims(claims, options = {}) {
  const {
    clientId = '',
    requireVerifiedEmail = false,
    allowedDomains = [],
    expectedNonce = '',
    now = Date.now(),
  } = options

  const checks = []
  const add = (id, label, ok, detail, fatal = true) => {
    checks.push({ id, label, ok, detail, fatal })
    return ok
  }

  const expMs = Number(claims.exp) * 1000
  const iatMs = Number(claims.iat) * 1000

  add(
    'iss',
    'iss 签发方必须是 Google',
    VALID_ISSUERS.has(claims.iss),
    String(claims.iss ?? '(缺失)')
  )
  add(
    'aud',
    'aud 受众必须等于本应用 Client ID',
    Boolean(clientId) && claims.aud === clientId,
    clientId ? String(claims.aud ?? '(缺失)') : '未配置 clientId，无法校验受众'
  )
  if (claims.azp) {
    add('azp', 'azp 授权方等于本应用', claims.azp === clientId, String(claims.azp), false)
  }
  add(
    'exp',
    'exp 未过期',
    Number.isFinite(expMs) && expMs > now,
    expMs ? new Date(expMs).toISOString() : '(缺失)'
  )
  add(
    'iat',
    'iat 签发时间合理（不晚于当前 +5min）',
    Number.isFinite(iatMs) && iatMs <= now + CLOCK_SKEW_MS,
    iatMs ? new Date(iatMs).toISOString() : '(缺失)'
  )
  add('sub', 'sub 用户唯一标识存在', Boolean(claims.sub), String(claims.sub ?? '(缺失)'))

  if (expectedNonce) {
    add(
      'nonce',
      'nonce 与本次登录请求一致（防重放）',
      claims.nonce === expectedNonce,
      claims.nonce ? 'token 内 nonce 已匹配' : 'token 中缺少 nonce'
    )
  }

  const hasEmail =
    typeof claims.email === 'string' && claims.email.includes('@')
  add('email', '包含 email', hasEmail, String(claims.email ?? '(缺失)'))

  const emailVerified = isTrue(claims.email_verified)
  add(
    'email_verified',
    'email_verified === true',
    emailVerified,
    `${String(claims.email_verified)} (${typeof claims.email_verified})` +
      (isFalse(claims.email_verified) ? ' · 该账号邮箱未验证' : ''),
    requireVerifiedEmail
  )

  if (allowedDomains.length) {
    const domain =
      claims.hd || (hasEmail ? String(claims.email).split('@')[1] : '')
    add(
      'hd',
      `邮箱域在白名单内（${allowedDomains.join(', ')}）`,
      allowedDomains.includes(domain),
      domain || '(未知)'
    )
  }

  return checks
}

/* ------------------------------------------------------------------ */
/* tokeninfo 降级                                                     */
/* ------------------------------------------------------------------ */

/**
 * JWKS 不可达时的兜底：把 token 交给 Google 自己的 tokeninfo 端点验。
 * 安全性不降低（Google 自己验签），代价是多一次网络往返。
 */
async function verifyWithTokeninfo(token, options) {
  let response
  try {
    response = await getJson(
      TOKENINFO_URL + encodeURIComponent(token),
      { timeoutMs: 8000 }
    )
  } catch (error) {
    return {
      ok: false,
      method: 'tokeninfo',
      claims: null,
      checks: [],
      error: 'tokeninfo_unreachable',
    }
  }

  const claims = response.body
  if (
    response.status !== 200 ||
    !claims ||
    claims.error_description
  ) {
    return {
      ok: false,
      method: 'tokeninfo',
      claims: null,
      checks: [],
      error:
        (claims && claims.error_description) ||
        `tokeninfo_http_${response.status}`,
    }
  }

  const normalized = {
    ...claims,
    // tokeninfo 返回的是字符串 "true"/"false"，统一成布尔便于下游判断
    email_verified: isTrue(claims.email_verified),
  }
  const checks = verifyClaims(normalized, options)
  return {
    ok: checks.every(check => check.ok || !check.fatal),
    method: 'tokeninfo',
    claims: normalized,
    checks,
    error: null,
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} VerifyResult
 * @property {boolean} ok
 * @property {'jwks'|'tokeninfo'|'none'} method
 * @property {object|null} claims
 * @property {Array<object>} checks
 * @property {string|null} error
 */

/**
 * @param {string} token  Google 签发的原始 ID Token（credential）
 * @param {object} options
 * @param {string} options.clientId
 * @param {boolean} [options.requireVerifiedEmail]
 * @param {string[]} [options.allowedDomains]
 * @param {string} [options.expectedNonce]
 * @param {number} [options.now]
 * @returns {Promise<VerifyResult>}
 */
async function verifyIdToken(token, options = {}) {
  const raw = String(token || '')
  const parts = raw.split('.')
  const now = options.now ?? Date.now()

  const fail = (id, label, detail, error) => ({
    ok: false,
    method: 'none',
    claims: null,
    checks: [{ id, label, ok: false, detail, fatal: true }],
    error,
  })

  if (parts.length !== 3) {
    return fail('format', 'JWT 结构（3 段）', '不是合法 ID Token', 'malformed_token')
  }

  let header
  let claims
  try {
    header = decodeSegment(parts[0])
    claims = decodeSegment(parts[1])
  } catch (error) {
    return fail('parse', 'JWT 解析', 'base64url / JSON 解析失败', 'unparsable_token')
  }

  const checks = [
    {
      id: 'parse',
      label: 'JWT 解析',
      ok: true,
      detail: `alg=${header.alg ?? '?'}, kid=${header.kid ?? '?'}`,
      fatal: true,
    },
  ]

  try {
    const { valid, kid } = await verifySignature(parts, header)
    checks.push({
      id: 'signature',
      label: '签名校验（RS256 + Google JWKS）',
      ok: valid,
      detail: valid ? `公钥 kid=${kid}` : '签名与服务端计算的摘要不一致',
      fatal: true,
    })
    if (!valid) {
      return { ok: false, method: 'jwks', claims: null, checks, error: 'bad_signature' }
    }
  } catch (error) {
    if (error.unreachable) {
      const fallback = await verifyWithTokeninfo(raw, { ...options, now })
      fallback.checks = [checks[0], ...fallback.checks]
      return fallback
    }
    checks.push({
      id: 'signature',
      label: '签名校验（RS256 + Google JWKS）',
      ok: false,
      detail: error.message,
      fatal: true,
    })
    return { ok: false, method: 'jwks', claims: null, checks, error: error.message }
  }

  const claimChecks = verifyClaims(claims, {
    clientId: options.clientId,
    requireVerifiedEmail: options.requireVerifiedEmail,
    allowedDomains: options.allowedDomains,
    expectedNonce: options.expectedNonce,
    now,
  })

  const all = [...checks, ...claimChecks]
  const ok = all.every(check => check.ok || !check.fatal)
  return {
    ok,
    method: 'jwks',
    claims,
    checks: all,
    error: ok ? null : (all.find(check => !check.ok && check.fatal) || {}).id,
  }
}

module.exports = {
  TOKENINFO_URL,
  VALID_ISSUERS,
  verifyIdToken,
  verifyClaims,
  verifyWithTokeninfo,
}
