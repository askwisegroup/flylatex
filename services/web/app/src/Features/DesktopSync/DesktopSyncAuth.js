const { promisify } = require('util')
const AuthenticationController = require('../Authentication/AuthenticationController')
const UserGetter = require('../User/UserGetter')
const DesktopSyncKeys = require('./DesktopSyncKeys')

// serializeUser 会把完整用户裁剪为 light user（去掉 password 等敏感字段），
// 与 Web 登录写入 session 的形态一致。
const serializeUser = promisify(
  AuthenticationController.serializeUser.bind(AuthenticationController)
)

function extractBearerKey(req) {
  // express-bearer-token 已在 app 级挂载（Server.js），会填充 req.token；
  // 这里再兜底直接解析 Authorization 头。
  if (req.token) {
    return req.token
  }
  const header = req.headers && req.headers.authorization
  if (!header) {
    return null
  }
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

function sendUnauthorized(res, message) {
  res.set('WWW-Authenticate', 'Bearer realm="flylatex-desktop-sync"')
  return res.status(401).json({ message })
}

module.exports = {
  // Bearer Key -> SHA-256 -> 查 desktop_sync_keys -> 加载用户 -> shim req.session。
  // 仅挂载在 /api/sync/projects 与 /api/sync/project/* 上；/api/sync/keys 不受影响。
  async requireApiKey(req, res, next) {
    try {
      const key = extractBearerKey(req)
      if (!key || !key.startsWith('flysync_')) {
        return sendUnauthorized(res, 'missing or malformed API key')
      }
      const record = await DesktopSyncKeys.findActiveKeyByHash(
        DesktopSyncKeys.hashKey(key)
      )
      if (!record) {
        return sendUnauthorized(res, 'invalid or revoked API key')
      }
      const user = await UserGetter.promises.getUser(record.user_id)
      if (!user) {
        return sendUnauthorized(res, 'user not found')
      }
      const lightUser = await serializeUser(user)

      // shim req.session：publicApiRouter 未挂 express-session / passport，
      // 但 AuthorizationMiddleware._getUserId / requireLogin 依赖 req.session。
      // 这里构造最小 session（user 优先被 SessionManager.getSessionUser 读取）。
      //
      // FIXED: 2026-11-11 _id 必须转成字符串，不能保留 Mongoose ObjectId。
      //   浏览器的 session 存在 Redis 里，取回来时 _id 已经被 JSON 序列化成
      //   string；而这里直接把内存里的 user 塞进去，_id 还是 ObjectId。
      //   下游但凡写 `project.owner_ref.toString() === userId`（GitController
      //   全是这种写法），ObjectId === string 恒为 false → 连项目 owner 都被
      //   403「没有权限访问这个项目」。转成字符串后与浏览器路径完全一致。
      // OLD: req.session = { user: lightUser }
      req.session = {
        user: {
          ...lightUser,
          _id: lightUser._id ? String(lightUser._id) : lightUser._id,
        },
      }

      // 异步记录使用时间，不阻塞请求
      DesktopSyncKeys.touchKey(record._id)

      return next()
    } catch (err) {
      return next(err)
    }
  },
}
