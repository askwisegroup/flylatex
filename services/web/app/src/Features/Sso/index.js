'use strict'

/**
 * FlyLaTeX SSO
 *
 * 让生态里的其他应用（模板系统、运营系统、白板、TikZ 资源库、桌面端、MCP、
 * 以后还有更多）**只对接 FlyLaTeX 一次**，而不是各自去接 NE account 或
 * Google account。身份锚点是本地 `User._id`，与上游 IdP 无关，所以
 * master（NE）/ sg（Google）两个部署档位对下游是同一套接口。
 *
 * 设计文档：docs/sso-provider-design.md
 *
 * ---------------------------------------------------------------------------
 * 三层前门
 * ---------------------------------------------------------------------------
 *   T0  同源前端   GET /sso/session                                  ← Session.js
 *   T1  同源后端   GET /_sso/verify（nginx auth_request + 签名头）    ← M3
 *   T2  跨域/桌面  /sso/authorize → /sso/token → /sso/userinfo      ← 本目录其余文件
 *
 * 「未登录 → 跳 FlyLaTeX 登录 → 登录后跳回来」这条链路**没有新机制**：
 * 任何路由挂上 `AuthenticationController.requireLogin()`，未登录就会 302 到
 * `/login`，`setRedirectInSession()` 把整条 URL（含 query）记进
 * `session.postLoginRedirect`，`finishLogin()` 登录完成后送回原处。
 * T2 的 `/sso/authorize` 只是把这条现成机制当成自己的第一部分 ——
 * 已用 `UrlHelper.getSafeRedirectPath('/sso/authorize?...')` 验证过
 * query 会原样保留。
 *
 * ---------------------------------------------------------------------------
 * 什么时候整个 T2 不存在
 * ---------------------------------------------------------------------------
 * 客户端注册表为空（`Settings.sso.clients` 为空数组）→
 * `/sso/authorize|token|userinfo` 统一 404，且**不连接 Redis**（store 是懒建的）。
 *
 * 这就是「开源版能跑」的实现方式：注册表在 `config/internal-values.js` 里，
 * 开源时被 `internal-values.example.js` 覆盖成 `clients: []`，三条 T2 端点
 * 直接消失；而 `/sso/session`（T0）不依赖客户端注册，同源应用照样能用。
 * 既不用删代码，也不用写 holder stub。
 *
 * ---------------------------------------------------------------------------
 * 开源边界（本目录的硬约束，由 sso-boundary.test.js 钉住）
 * ---------------------------------------------------------------------------
 * 本目录**不 import 任何私有模块**：不碰 `commercial/**`、
 * 不碰 `Features/IdentityProviders/**`、不读 `NE_*` / `GOOGLE_*` 环境变量。
 * 它只读 `req.session.user` —— 那是 `finishLogin` 的唯一产物，四种登录方式
 * （密码 / 短信 / CARSI / Google）共同写出来的中立结构。
 *
 * 于是：**推开源代码时本目录一行都不用改。** holder code 的边界本来就已经
 * 画在 `Settings.loginProviders`（config/settings.defaults.js）上了。
 */

const Settings = require('@overleaf/settings')

const Claims = require('./Claims')
const Session = require('./Session')
const Clients = require('./Clients')
const Store = require('./Store')
const Codes = require('./Codes')
const Tokens = require('./Tokens')
const Authorize = require('./Authorize')
const Token = require('./Token')
const UserInfo = require('./UserInfo')

/**
 * 配置在**模块加载时**就解析完。
 *
 * 理由：注册表是手写数据（`internal-values.js` 里的数组，或 `SSO_CLIENTS`
 * 这个 JSON 环境变量），写错时最坏的情况是「启动成功、每次授权都 500」。
 * 这里直接抛错让进程起不来 —— 部署时立刻发现，而不是等第一个用户点登录。
 */
const config = (Settings && Settings.sso) || {}
const rawClients = Clients.parseClientsConfig(config.clients)
const enabled = rawClients.length > 0

/** @type {null | {authorize: Function, token: Function, userinfo: Function}} */
let wired = null

/**
 * 懒建真实依赖。
 *
 * 刻意不在模块顶层 `RedisWrapper.client('sso')`：那会让「没配 SSO 的部署」
 * 也去连一次 Redis，也会让本目录的单元测试被迫依赖完整运行时环境。
 */
function buildStore() {
  if (config.store === 'memory') {
    return Store.memoryStore()
  }
  // 延迟 require：开源版（clients 为空）永远不会走到这里。
  // 路径层级：本文件在 app/src/Features/Sso/，
  //   ../  → app/src/Features（Authentication 等）
  //   ../../ → app/src（infrastructure、models）
  const RedisWrapper = require('../../infrastructure/RedisWrapper')
  return Store.redisStore(RedisWrapper.client('sso'))
}

function wire() {
  if (wired) return wired

  const SessionManager = require('../Authentication/SessionManager')
  const { User } = require('../../models/User')

  const registry = Clients.createRegistry(rawClients)
  const store = buildStore()
  const codes = Codes.createCodeService({ store })
  const tokens = Tokens.createTokenService({ store })

  wired = {
    authorize: Authorize.createAuthorizeHandler({
      registry,
      codes,
      getUser: req => SessionManager.getSessionUser(req.session),
    }),
    token: Token.createTokenHandler({ registry, codes, tokens, store }),
    userinfo: UserInfo.createUserInfoHandler({
      tokens,
      // 只按 _id 取，不读 session：token 里只有 userId，用户资料回表拿最新的。
      loadUser: userId => User.findById(userId).exec(),
    }),
  }
  return wired
}

function notFound(res) {
  res.status(404).type('text/plain; charset=utf-8')
  res.send('Not Found')
}

/**
 * 把「T2 未启用 → 404」包一层，让 router.js 不用关心开关。
 */
function guard(name) {
  return function ssoEndpoint(req, res, next) {
    if (!enabled) return notFound(res)
    return wire()[name](req, res, next)
  }
}

module.exports = {
  Claims,
  Session,
  /** T2 是否启用（由客户端注册表是否为空决定）。 */
  enabled,
  /** 解析后的客户端数量，便于启动日志/健康检查展示。 */
  clientCount: rawClients.length,
  /** T2 三跳。未启用时各自返回 404。 */
  authorize: guard('authorize'),
  token: guard('token'),
  userinfo: guard('userinfo'),
  // 仅供测试：重置懒建状态
  _resetForTesting() {
    wired = null
  },
}
