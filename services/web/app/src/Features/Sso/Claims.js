'use strict'

/**
 * FlyLaTeX SSO · claims 白名单
 *
 * T0（`GET /sso/session`）和后续的 T2（`GET /sso/userinfo`）共用这一份构造逻辑，
 * 保证「本站前端看到的我」和「第三方应用看到的我」形状完全一致。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须是逐字段白名单，而不是 `{ ...sessionUser }`
 * ---------------------------------------------------------------------------
 * `req.session.user` 是 `AuthenticationController.serializeUser()` 裁剪出来的
 * light user，里面除了展示字段，还混着三类**绝对不能出门**的东西：
 *
 *   1. NE 专有身份：`account_id`、`carsiEmail`、`v1_id`
 *      —— 泄漏后下游会把临时登录标识当成主键，换上游即断。
 *   2. 权限：`isAdmin`、`staffAccess`
 *      —— 同域的白板 / 模板系统 / 运营后台都能读，等于把后台入口标出来。
 *   3. 编辑器偏好：`overallTheme`、`aiModel`、`aiPanelLayout` …
 *      —— 无关信息，且会让下游误以为这是「用户档案接口」。
 *
 * 所以：加字段必须同时改本文件与 Claims.test.js，不允许顺手 spread。
 *
 * ---------------------------------------------------------------------------
 * 为什么 sub 必须是本地 `User._id`
 * ---------------------------------------------------------------------------
 * 详见 docs/sso-provider-design.md §4.1。一句话：
 *   · NE `account_id` 只在 master 站有，sg 站没有；
 *   · Google `sub` 只在 sg 站有，master 站没有；
 *   · `email` 会变（用户可改），且**手机号登录根本不写 email**；
 *   · `carsiEmail` 是登录标识，不是身份标识。
 * 本地 `User._id` 是四种登录方式合并后的唯一稳定锚点 —— 换上游、换部署档位、
 * 以后接入第三个 IdP，下游存下的这个字符串都不用动。
 */

/**
 * 支持的 scope。
 *
 * M1 只开三个最小集：
 *   openid  → sub（唯一必需的 claim）
 *   profile → name
 *   email   → email + email_verified
 *
 * 刻意**没有** avatar_url / locale：`models/User.js` 里没有对应字段，
 * 为了「接口里有」而凭空造一个空值，只会让下游写出 `if (!user.avatarUrl)`
 * 这种永远为真的分支。等 User 模型真的有了再加。
 */
const SUPPORTED_SCOPES = ['openid', 'profile', 'email']

/** 不指定 scope 时给什么 */
const DEFAULT_SCOPES = ['openid']

/**
 * 把 `"openid profile email"` 这类 scope 串解析成数组。
 *
 * 规则：
 *   · 未识别的 scope **丢弃而不是报错**（OAuth2 允许服务器缩小 scope）；
 *   · 全被丢掉（或压根没传）→ 退回 DEFAULT_SCOPES，保证 sub 一定在；
 *   · `openid` 永远补在第一位 —— 没有 sub 的 claims 对下游毫无用处。
 *
 * @param {string|string[]|undefined|null} raw
 * @returns {string[]}
 */
function parseScopes(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw == null ? '' : raw).split(/\s+/)
  const seen = new Set()
  for (const part of parts) {
    const scope = String(part).trim()
    if (SUPPORTED_SCOPES.includes(scope)) {
      seen.add(scope)
    }
  }
  if (seen.size === 0) {
    return DEFAULT_SCOPES.slice()
  }
  seen.delete('openid')
  // 保持「openid 在前、其余按 SUPPORTED_SCOPES 声明顺序」——输出稳定才好写断言。
  return ['openid'].concat(
    SUPPORTED_SCOPES.filter(s => s !== 'openid' && seen.has(s))
  )
}

/**
 * 展示名。
 *
 * 只有 first_name / last_name 两个来源，都没有就返回空串（**不做**「用邮箱
 * 前缀凑一个」的兜底：那会让下游误以为拿到了真名，而且手机号用户没有邮箱）。
 * 空串在 buildClaims 里会被**整个省略**，符合 OIDC「可选 claim 缺失」的语义，
 * 下游写 `user.name || '匿名'` 即可。
 *
 * @param {object} user light user
 * @returns {string}
 */
function displayName(user) {
  return [user.first_name, user.last_name]
    .filter(Boolean)
    .map(part => String(part).trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * 构造对外 claims。
 *
 * @param {object} user `SessionManager.getSessionUser(req.session)`，即 light user
 * @param {string|string[]} [scopes]
 * @returns {{sub: string, name?: string, email?: string, email_verified?: boolean}}
 */
function buildClaims(user, scopes) {
  if (!user || user._id == null) {
    throw new Error('buildClaims called without a user')
  }
  const granted = parseScopes(scopes)

  // sub 无条件给出：能进到这里的都是已登录用户，没有 sub 的响应没有意义。
  const claims = { sub: String(user._id) }

  if (granted.includes('profile')) {
    const name = displayName(user)
    if (name) claims.name = name
  }

  if (granted.includes('email') && user.email) {
    claims.email = user.email
    // **恒为 false**，不是「我们没查」的偷懒，是一个明确的态度：
    // FlyLaTeX 没有对所有登录方式做邮箱归属校验（手机号登录压根没有邮箱），
    // 下游不得把 email 当主键或可信标识。要改这个值，先改实现，别改常量。
    claims.email_verified = false
  }

  return claims
}

module.exports = {
  SUPPORTED_SCOPES,
  DEFAULT_SCOPES,
  parseScopes,
  displayName,
  buildClaims,
}
