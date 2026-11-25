'use strict'

/**
 * Google 登录的 HTTP 层。
 *
 * 两个端点，都在 `webRouter` 上（继承 express-session + csurf）：
 *
 *   GET  /auth/google/nonce   发一次性 nonce（防 ID Token 重放）
 *   POST /auth/google/verify  验签 → 找/建用户 → 建 Overleaf 会话
 *
 * 设计原则：**不新建会话体系**。
 * 登录成功的收尾直接走 `AuthenticationController.finishLogin`，与密码 /
 * 短信登录共用同一条路径 —— 会话再生成（防 fixation）、审计日志、分析事件、
 * redirect 处理都一次性对齐。原型里的 `gid_session` cookie 有意不引入。
 *
 * 信任模型：本端点只接收 Google 签名的原始 JWT（`credential`），
 * 不接受前端自报的 email / sub / name。
 */

const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const { expressify } = require('@overleaf/promise-utils')

const GoogleAuth = require('../../../../google-auth')
const { resolveGoogleUser } = require('./GoogleUserResolver')
const AuthenticationController = require('../Authentication/AuthenticationController')
// FIXED: 2026-11-13 RateLimiter 这个模块导出的是对象 { RateLimiter }，不是构造函数。
// 原来解构漏了花括号 → 启动即 TypeError: RateLimiter is not a constructor →
// web 进程起不来 → nginx 502（生产事故根因）。
// OLD: const RateLimiter = require('../../infrastructure/RateLimiter')
const { RateLimiter } = require('../../infrastructure/RateLimiter')
const Features = require('../../infrastructure/Features')

const nonceLimiter = new RateLimiter('google-auth-nonce', {
  points: 30,
  duration: 60,
})

const verifyLimiter = new RateLimiter('google-auth-verify', {
  points: 10,
  duration: 60,
  blockDuration: 60,
})

const clientIp = req =>
  req.ip || (req.headers && req.headers['x-real-ip']) || 'unknown'

const fail = (res, status, reason, extra) => {
  if (res.headersSent) return
  res.status(status).json(Object.assign({ ok: false, reason }, extra))
}

/**
 * 只有 Google 登录真正可用时才注册这两个路由。
 * 这样中国站（未配置 GOOGLE_CLIENT_ID）上这两个 URL 直接 404，
 * 不存在"能调到但必然失败"的中间状态。
 */
function isAvailable() {
  return Features.hasFeature('google-login')
}

function requireAvailable(req, res, next) {
  if (!isAvailable()) {
    return fail(res, 404, 'google_login_not_enabled')
  }
  next()
}

/* ------------------------------------------------------------------ */
/* 端点                                                               */
/* ------------------------------------------------------------------ */

/**
 * 发 nonce。
 * 前端拿到后传给 `google.accounts.id.initialize({ nonce })`，
 * Google 会把它写进 ID Token 的 `nonce` claim；verify 时比对。
 */
const issueNonce = expressify(async function (req, res) {
  try {
    await nonceLimiter.consume(clientIp(req))
  } catch (error) {
    return fail(res, 429, 'rate_limited')
  }

  let issued
  try {
    issued = await GoogleAuth.issueNonce()
  } catch (error) {
    // nonce 存储（Redis）不可用。这种时候登录一定不能用，
    // 必须明确告知，而不是让用户在登录页反复点击一个静默失败的按钮。
    logger.error({ err: error }, '[identity/google] nonce 存储不可用')
    return fail(res, 503, 'nonce_store_unavailable')
  }

  const { nonce, expiresIn } = issued
  res.set('Cache-Control', 'no-store')
  res.json({ ok: true, nonce, expiresIn })
})

/**
 * 验签并登录。
 *
 * 请求体：`{ credential: string, nonce: string }`
 * 成功：`{ redir: '/project' }`（会话 cookie 已下发）
 * 失败：`{ ok: false, reason }`
 */
const verify = expressify(async function (req, res, next) {
  try {
    await verifyLimiter.consume(clientIp(req))
  } catch (error) {
    return fail(res, 429, 'rate_limited')
  }

  const credential = req.body && req.body.credential
  const nonce = (req.body && req.body.nonce) || ''

  if (typeof credential !== 'string' || credential === '') {
    return fail(res, 400, 'missing_credential')
  }
  if (typeof nonce !== 'string' || nonce === '') {
    return fail(res, 400, 'missing_nonce')
  }

  const result = await GoogleAuth.verifyCredential(credential, nonce).catch(
    error => {
      logger.error({ err: error }, '[identity/google] 校验过程异常')
      return { ok: false, claims: null, checks: [], error: 'verify_error' }
    }
  )

  if (!result.ok) {
    if (result.error === 'nonce_store_unavailable') {
      return fail(res, 503, 'nonce_store_unavailable')
    }
    // 完整校验细节只进日志：对浏览器暴露过多，等于把攻击面画成说明书。
    logger.warn(
      {
        error: result.error,
        checks: (result.checks || []).filter(check => !check.ok),
        ip: clientIp(req),
      },
      '[identity/google] ID Token 校验未通过'
    )
    const status = result.error === 'nonce_required' ? 400 : 401
    return fail(res, status, result.error || 'verification_failed')
  }

  const claims = result.claims || {}

  let resolved
  try {
    resolved = await resolveGoogleUser({
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
    })
  } catch (error) {
    if (error.code === 'google_account_conflict') {
      // 明确的业务冲突，且不含敏感信息，可以告诉用户
      return fail(res, 409, 'google_account_conflict')
    }
    logger.error(
      { err: error, sub: claims.sub },
      '[identity/google] 用户解析失败'
    )
    return fail(res, 500, 'user_resolution_failed')
  }

  const { user, created, linked } = resolved

  if (!user || !user._id) {
    logger.error(
      { sub: claims.sub },
      '[identity/google] 解析结果缺少 _id，拒绝建立会话'
    )
    return fail(res, 500, 'user_resolution_failed')
  }

  if (Settings.adminOnlyLogin && !user.isAdmin) {
    return fail(res, 403, 'admin_only')
  }

  AuthenticationController.setAuditInfo(req, {
    method: 'Google login',
    // 便于审计时区分"新建"与"绑定既有账号"
    detail: created ? 'google-signup' : linked ? 'google-link' : 'google-signin',
  })

  if (created) {
    // 与密码注册对齐：下游（分析 / 首次引导）依赖这个标记
    req.session.justRegistered = true
    req.session.googleJustCreated = true
  }

  logger.info(
    { userId: String(user._id), created, linked },
    '[identity/google] 登录成功'
  )

  // 由 finishLogin 统一完成：会话再生成、审计日志、分析事件、redirect。
  // 响应体是 `{ redir }` —— 与 NE 密码 / 短信登录**完全相同**的契约，
  // 前端不需要为 Google 写特例（有 redir 即成功）。
  // 有意不包一层 `{ok:true}`：多一种响应形状就多一处前端分支要维护。
  return AuthenticationController.finishLogin(user, req, res, next)
})

module.exports = {
  isAvailable,
  requireAvailable,
  issueNonce,
  verify,
}
