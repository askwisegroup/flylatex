'use strict'

/**
 * SSO claims 白名单的行为测试。
 *
 * 钉住 5 件事：
 *   1. `sub` 恒等于本地 `User._id` 的字符串形式（换上游 IdP 不变）。
 *   2. 敏感字段（account_id / carsiEmail / v1_id / isAdmin / staffAccess）
 *      **一个都不能出现** —— 这是 SSO 存在的意义。
 *   3. scope 真的会收窄 claims，且未识别的 scope 被丢弃而不是报错。
 *   4. 没有名字时**省略** name，而不是发空串（OIDC 可选 claim 语义）。
 *   5. `email_verified` 恒为 false。
 *
 * 运行：npm run test:sso
 * 本测试只 require ./Claims，不依赖 @overleaf/settings。
 */

const test = require('node:test')
const assert = require('node:assert')

const Claims = require('./Claims')

/** 模拟 serializeUser 产出的 light user（字段取自 AuthenticationController） */
function lightUser(overrides) {
  return Object.assign(
    {
      _id: '65f1a2b3c4d5e6f7a8b9c0d1',
      first_name: '三',
      last_name: '张',
      email: 'zhangsan@example.com',
      // ↓ 以下都是**绝对不能出门**的字段
      account_id: 'ne-account-123',
      carsiEmail: 'zs@university.edu.cn',
      v1_id: 42,
      isAdmin: true,
      staffAccess: true,
      overallTheme: 'dark',
      aiModel: 'gpt-x',
    },
    overrides
  )
}

test('sub 来自本地 User._id，且永远是字符串', () => {
  const claims = Claims.buildClaims(lightUser(), ['openid'])
  assert.deepStrictEqual(Object.keys(claims), ['sub'])
  assert.strictEqual(claims.sub, '65f1a2b3c4d5e6f7a8b9c0d1')
  assert.strictEqual(typeof claims.sub, 'string')
})

test('敏感字段一个都不能泄漏', () => {
  const claims = Claims.buildClaims(lightUser(), Claims.SUPPORTED_SCOPES)
  const forbidden = [
    'account_id',
    'carsiEmail',
    'v1_id',
    'isAdmin',
    'staffAccess',
    'overallTheme',
    'aiModel',
    'analyticsId',
    'ip_address',
    'session_created',
  ]
  for (const key of forbidden) {
    assert.ok(
      !(key in claims),
      `claims 里不能出现 ${key}（下游同域应用都能读到）`
    )
  }
  assert.deepStrictEqual(Object.keys(claims).sort(), [
    'email',
    'email_verified',
    'name',
    'sub',
  ])
})

test('scope 收窄 claims', () => {
  const all = Claims.buildClaims(lightUser(), ['openid', 'profile', 'email'])
  assert.strictEqual(all.name, '三 张')
  assert.strictEqual(all.email, 'zhangsan@example.com')

  const onlyOpenid = Claims.buildClaims(lightUser(), ['openid'])
  assert.strictEqual(onlyOpenid.name, undefined)
  assert.strictEqual(onlyOpenid.email, undefined)

  const onlyProfile = Claims.buildClaims(lightUser(), ['openid', 'profile'])
  assert.strictEqual(onlyProfile.name, '三 张')
  assert.strictEqual(onlyProfile.email, undefined)
})

test('email_verified 恒为 false', () => {
  const claims = Claims.buildClaims(lightUser(), ['email'])
  assert.strictEqual(claims.email_verified, false)
})

test('没有名字时省略 name，不发空串', () => {
  const claims = Claims.buildClaims(
    lightUser({ first_name: '', last_name: undefined }),
    ['openid', 'profile']
  )
  assert.ok(!('name' in claims), 'name 缺失应当整个省略')
})

test('手机号登录（没有 email）不发 email', () => {
  const claims = Claims.buildClaims(
    lightUser({ email: null, first_name: '三', last_name: '张' }),
    ['openid', 'profile', 'email']
  )
  assert.ok(!('email' in claims))
  assert.ok(!('email_verified' in claims), '没有 email 就不要自报已验证状态')
  assert.strictEqual(claims.name, '三 张')
})

test('parseScopes：未识别丢弃、去重、openid 恒在最前', () => {
  assert.deepStrictEqual(Claims.parseScopes('openid profile email'), [
    'openid',
    'profile',
    'email',
  ])
  assert.deepStrictEqual(Claims.parseScopes('profile  admin'), [
    'openid',
    'profile',
  ])
  assert.deepStrictEqual(Claims.parseScopes('profile profile'), [
    'openid',
    'profile',
  ])
  // 全都不认识 / 没传 → 退回只给 sub
  assert.deepStrictEqual(Claims.parseScopes('root'), ['openid'])
  assert.deepStrictEqual(Claims.parseScopes(''), ['openid'])
  assert.deepStrictEqual(Claims.parseScopes(undefined), ['openid'])
  assert.deepStrictEqual(Claims.parseScopes(null), ['openid'])
  // 数组输入（重复 query 参数 `?scope=openid&scope=email`）
  assert.deepStrictEqual(Claims.parseScopes(['openid', 'email']), [
    'openid',
    'email',
  ])
})

test('buildClaims 在没有用户时直接报错，而不是发一个空 claims', () => {
  assert.throws(() => Claims.buildClaims(null, ['openid']))
  assert.throws(() => Claims.buildClaims({}, ['openid']))
})

test('displayName 只拼接 first/last，不做邮箱兜底', () => {
  assert.strictEqual(Claims.displayName({ first_name: 'A' }), 'A')
  assert.strictEqual(Claims.displayName({ last_name: 'B' }), 'B')
  assert.strictEqual(
    Claims.displayName({ first_name: ' A ', last_name: ' B ' }),
    'A B'
  )
  assert.strictEqual(Claims.displayName({ email: 'x@y.z' }), '')
  assert.strictEqual(Claims.displayName({}), '')
})
