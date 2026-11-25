'use strict'

/**
 * Google 登录校验门面（服务端）。
 *
 * 只暴露三个动作，业务侧（IdentityProviders/GoogleAuthController）不需要
 * 知道 JWKS / Redis / 校验顺序：
 *
 *   isConfigured()                       —— 有 clientId 才算可用
 *   issueNonce()                         —— 发一次性 nonce
 *   verifyCredential(credential, nonce)  —— 验签 + 验 claims + 核销 nonce
 *
 * 与原型（a local prototype repo）的差异：
 *   原型用 HttpOnly cookie 存 nonce 和会话；这里 nonce 由浏览器回传、
 *   服务端在 Redis 里**原子核销**，会话则完全交给 Overleaf 既有的
 *   express-session + passport —— 避免两个会话来源打架。
 */

const Settings = require('@overleaf/settings')
const { verifyIdToken } = require('./verifier')
const {
  createRedisNonceStore,
  createMemoryStore,
  DEFAULT_TTL_SECONDS,
} = require('./nonce-store')

let nonceStore = null
let nonceStoreErrorLogged = false

/**
 * nonce 存储选择（默认 Redis，显式失败）。
 *
 * 为什么默认**不静默降级到内存**：
 *   web 服务是多实例的，nonce 在 A 实例签发、verify 落到 B 实例时，
 *   内存里根本找不到 —— 用户会看到毫无解释的「登录准备失败」，
 *   而且只在生产多副本下复现。与其隐性失败，不如直接 503 并说清原因。
 *
 * 单实例部署（本地开发 / 小规模私有部署）用 `GOOGLE_NONCE_STORE=memory`。
 */
function getNonceStore() {
  if (nonceStore) return nonceStore

  if ((process.env.GOOGLE_NONCE_STORE || '').toLowerCase() === 'memory') {
    nonceStore = createMemoryStore({
      ttlSeconds:
        Number(process.env.GOOGLE_NONCE_TTL_SECONDS) || DEFAULT_TTL_SECONDS,
    })
    return nonceStore
  }

  const RedisWrapper = require('../../app/src/infrastructure/RedisWrapper')
  const client = RedisWrapper.client('googleauth')
  const redisStore = createRedisNonceStore(client, {
    ttlSeconds:
      Number(process.env.GOOGLE_NONCE_TTL_SECONDS) || DEFAULT_TTL_SECONDS,
    prefix: `google-auth:nonce:${
      Settings.deployment ? Settings.deployment.profile : 'cn'
    }:`,
  })

  // Redis 的任何失败都归一成一个明确错误码，由上层决定如何响应
  // （控制器会返回 503，而不是把用户带到登录页却点不动）。
  const wrap = fn => async arg => {
    try {
      return await fn(arg)
    } catch (error) {
      if (!nonceStoreErrorLogged) {
        nonceStoreErrorLogged = true
        console.error(
          '[google-auth] nonce 存储（Redis）不可用，Google 登录暂时关闭:',
          error.message
        )
      }
      throw Object.assign(new Error('nonce_store_unavailable'), {
        code: 'nonce_store_unavailable',
      })
    }
  }

  nonceStore = {
    issue: wrap(() => redisStore.issue()),
    take: wrap(nonce => redisStore.take(nonce)),
  }
  return nonceStore
}

/** 仅供测试：注入或清空 nonce 存储。 */
function _setNonceStore(store) {
  nonceStore = store
}

function googleConfig() {
  const provider = (Settings.loginProviders || {}).google || {}
  return {
    clientId: provider.clientId || '',
    // 默认要求邮箱已验证：Gmail 账号天然已验证，这条只是防止
    // Google Workspace 里未验证的自建域被拿来注册。
    requireVerifiedEmail:
      process.env.GOOGLE_REQUIRE_VERIFIED_EMAIL !== 'false',
    allowedDomains: (process.env.GOOGLE_ALLOWED_DOMAINS || '')
      .split(',')
      .map(domain => domain.trim())
      .filter(Boolean),
  }
}

function isConfigured() {
  return googleConfig().clientId !== ''
}

async function issueNonce() {
  return getNonceStore().issue()
}

/**
 * @param {string} credential Google 签发的原始 ID Token
 * @param {string} nonce      本次登录的 nonce（浏览器回传）
 * @returns {Promise<{ok:boolean, claims:object|null, checks:Array, error:string|null}>}
 */
async function verifyCredential(credential, nonce) {
  const config = googleConfig()
  if (!config.clientId) {
    return {
      ok: false,
      claims: null,
      checks: [],
      error: 'google_not_configured',
    }
  }

  // 先核销再验签：否则一个被拒的 token 也能反复消耗 CPU 做 RSA 校验。
  let consumed
  try {
    consumed = await getNonceStore().take(nonce)
  } catch (error) {
    // 存储不可用 → 明确告知上层，让它回 503 而不是伪装成"凭据无效"。
    return {
      ok: false,
      claims: null,
      checks: [],
      error: 'nonce_store_unavailable',
    }
  }
  if (!consumed) {
    return {
      ok: false,
      claims: null,
      checks: [
        {
          id: 'nonce',
          label: 'nonce 预签发',
          ok: false,
          detail: '无有效 nonce（未请求或已使用过）',
          fatal: true,
        },
      ],
      error: 'nonce_required',
    }
  }

  const result = await verifyIdToken(credential, {
    clientId: config.clientId,
    requireVerifiedEmail: config.requireVerifiedEmail,
    allowedDomains: config.allowedDomains,
    expectedNonce: nonce,
  })

  return {
    ok: result.ok,
    claims: result.claims,
    checks: result.checks,
    error: result.error,
  }
}

module.exports = {
  isConfigured,
  issueNonce,
  verifyCredential,
  googleConfig,
  _setNonceStore,
  createMemoryStore,
}
