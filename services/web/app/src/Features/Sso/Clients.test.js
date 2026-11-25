'use strict'

/**
 * SSO 客户端注册表的行为断言。
 *
 * 这些用例对应的是**真实事故形态**，不是「覆盖率」：
 *   · redirect_uri 前缀匹配 → `https://app.example.com.evil.com` 拿走 code；
 *   · secret 用 == 比较 → 时序侧信道；
 *   · scope 悄悄降级 → 客户端以为有 email，线上才 500；
 *   · 未知 client_id 也跳转 → 开放重定向。
 */

const test = require('node:test')
const assert = require('node:assert')

const Clients = require('./Clients')

function makeRegistry(overrides = {}) {
  return Clients.createRegistry([
    {
      client_id: 'word2latex',
      client_secret: 's3cr3t-with-chars-&^-inside',
      name: 'Word 转 LaTeX',
      redirect_uris: [
        'http://localhost:3100/word2latex/api/auth/sso/callback',
        'https://www.example.com/word2latex/api/auth/sso/callback',
      ],
      scopes: ['openid', 'profile', 'email'],
      trusted: true,
      ...overrides,
    },
  ])
}

test('SSO_CLIENTS 接受数组与 { clients: [...] } 两种形状', () => {
  assert.strictEqual(Clients.parseClientsConfig('').length, 0)
  assert.strictEqual(Clients.parseClientsConfig(null).length, 0)
  assert.strictEqual(
    Clients.parseClientsConfig('[{"client_id":"a"}]').length,
    1
  )
  assert.strictEqual(
    Clients.parseClientsConfig('{"clients":[{"client_id":"a"}]}').length,
    1
  )
})

test('SSO_CLIENTS 写错 JSON 必须抛错（让进程起不来，而不是运行时 500）', () => {
  assert.throws(() => Clients.parseClientsConfig('[{"client_id":"a"},]'))
  assert.throws(() => Clients.parseClientsConfig('{"nope":1}'))
})

test('缺少 client_id / redirect_uris 时拒绝注册', () => {
  assert.throws(() =>
    Clients.createRegistry([{ redirect_uris: ['http://a/b'] }])
  )
  assert.throws(() => Clients.createRegistry([{ client_id: 'x' }]))
  assert.throws(() =>
    Clients.createRegistry([{ client_id: 'x', redirect_uris: [] }])
  )
})

test('重复 client_id 拒绝注册（否则后一个静默覆盖前一个）', () => {
  assert.throws(() =>
    Clients.createRegistry([
      { client_id: 'x', redirect_uris: ['http://a/b'] },
      { client_id: 'x', redirect_uris: ['http://c/d'] },
    ])
  )
})

test('redirect_uri 带 fragment 直接拒绝注册（浏览器收不到 query）', () => {
  assert.throws(() =>
    Clients.createRegistry([
      { client_id: 'x', redirect_uris: ['http://a/b#frag'] },
    ])
  )
})

test('redirect_uri 只认全等：后缀 / 前缀 / 通配 全部拒绝', () => {
  const registry = makeRegistry()
  const client = registry.get('word2latex')
  const good = 'https://www.example.com/word2latex/api/auth/sso/callback'

  assert.ok(registry.verifyRedirectUri(client, good))

  const attacks = [
    // 经典后缀攻击：域名是 evil.com，只是前缀长得像
    'https://www.example.com.evil.com/word2latex/api/auth/sso/callback',
    // 路径穿越
    'https://www.example.com/word2latex/api/auth/sso/../callback',
    // 多一个 query
    `${good}?next=https://evil.com`,
    // 大小写/端口差异都不放过
    'https://www.example.com:443/word2latex/api/auth/sso/callback',
    // 前缀匹配
    'https://www.example.com/word2latex/api/auth/sso/',
    '',
  ]
  for (const uri of attacks) {
    assert.strictEqual(
      registry.verifyRedirectUri(client, uri),
      false,
      `不该通过：${uri}`
    )
  }
})

test('loopback 只放开端口，host 与 path 仍必须全等', () => {
  const registry = makeRegistry({
    redirect_uris: ['http://127.0.0.1:41555/callback'],
    allow_loopback: true,
  })
  const client = registry.get('word2latex')

  // 端口任意
  assert.ok(
    registry.verifyRedirectUri(client, 'http://127.0.0.1:51234/callback')
  )
  assert.ok(registry.verifyRedirectUri(client, 'http://[::1]:51234/callback'))

  // path / host 不符则拒
  assert.strictEqual(
    registry.verifyRedirectUri(client, 'http://127.0.0.1:51234/other'),
    false
  )
  assert.strictEqual(
    registry.verifyRedirectUri(client, 'http://127.0.0.1:51234/callback'),
    false
  )
  // 带 query 无法稳定比对
  assert.strictEqual(
    registry.verifyRedirectUri(client, 'http://127.0.0.1:51234/callback?x=1'),
    false
  )
})

test('未开 allow_loopback 时 loopback 也不通（默认更严）', () => {
  const registry = makeRegistry({
    redirect_uris: ['http://127.0.0.1:41555/cb'],
  })
  const client = registry.get('word2latex')
  assert.strictEqual(
    registry.verifyRedirectUri(client, 'http://127.0.0.1:51234/cb'),
    false
  )
})

test('client_secret 比较：对、错、空、长度不同都不能崩', () => {
  const registry = makeRegistry()
  const client = registry.get('word2latex')

  assert.ok(registry.verifySecret(client, 's3cr3t-with-chars-&^-inside'))
  assert.strictEqual(
    registry.verifySecret(client, 's3cr3t-with-chars-&^-insid'),
    false
  )
  assert.strictEqual(registry.verifySecret(client, ''), false)
  assert.strictEqual(registry.verifySecret(client, undefined), false)
  // 长度不同必须返回 false 而不是抛 RangeError
  assert.strictEqual(registry.verifySecret(client, 'short'), false)
})

test('scope 越权返回 null（不允许悄悄降级）', () => {
  const registry = makeRegistry()
  const client = registry.get('word2latex')

  assert.deepStrictEqual(registry.resolveScopes(client, 'openid profile'), [
    'openid',
    'profile',
  ])
  assert.deepStrictEqual(registry.resolveScopes(client, ''), ['openid'])
  assert.deepStrictEqual(registry.resolveScopes(client, undefined), ['openid'])

  // 客户端没被授权 openid 以外的东西时
  const narrow = makeRegistry({ scopes: ['openid'] }).get('word2latex')
  assert.strictEqual(
    registry.resolveScopes(narrow, 'openid email'),
    null,
    '请求超出客户端被授权的 scope 必须 invalid_scope'
  )
})

test('scope 输出顺序稳定（openid 在前），便于下游做字符串比较', () => {
  const registry = makeRegistry()
  const client = registry.get('word2latex')
  assert.deepStrictEqual(
    registry.resolveScopes(client, 'email profile openid'),
    ['openid', 'profile', 'email']
  )
})

test('requirePkce 默认开启，只有显式 false 才关', () => {
  assert.strictEqual(makeRegistry().get('word2latex').requirePkce, true)
  assert.strictEqual(
    makeRegistry({ require_pkce: false }).get('word2latex').requirePkce,
    false
  )
  assert.strictEqual(
    makeRegistry({ require_pkce: true }).get('word2latex').requirePkce,
    true
  )
})

test('trusted 默认关闭（M2 只放行显式 trusted 的第一方应用）', () => {
  assert.strictEqual(makeRegistry().get('word2latex').trusted, true)
  assert.strictEqual(
    makeRegistry({ trusted: undefined }).get('word2latex').trusted,
    false
  )
})
