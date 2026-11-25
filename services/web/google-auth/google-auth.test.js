/**
 * Google 登录校验链路的回归测试。
 *
 * 钉住 4 件事（都会导致线上事故）：
 *   1. nonce 是**一次性**的：同一个 nonce 第二次必失败（防 ID Token 重放）。
 *   2. `aud` 必须等于本应用 Client ID（防拿别的应用的 Google token 登录）。
 *   3. `iss` 必须是 Google（防自建 IdP 伪造）。
 *   4. `email_verified=false` 时，`requireVerifiedEmail` 为真则拒绝。
 *
 * 不发任何网络请求：JWKS 与 tokeninfo 都不参与，只测纯校验逻辑与
 * 内存 nonce 存储。
 */
const test = require('node:test')
const assert = require('node:assert')

const { verifyClaims, verifyIdToken } = require('./verifier')
const { createMemoryStore } = require('./nonce-store')

const CLIENT_ID = 'test-client.apps.googleusercontent.com'

function baseClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  return Object.assign(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      sub: '1234567890',
      email: 'user@example.com',
      email_verified: true,
      iat: now - 10,
      exp: now + 3600,
    },
    overrides
  )
}

const fatalFailures = checks =>
  checks.filter(check => !check.ok && check.fatal).map(check => check.id)

test('verifyClaims: 正常 token 全部通过', () => {
  const checks = verifyClaims(baseClaims(), { clientId: CLIENT_ID })
  assert.deepStrictEqual(fatalFailures(checks), [])
})

test('verifyClaims: iss 不是 Google 时拒绝', () => {
  const checks = verifyClaims(
    baseClaims({ iss: 'https://evil.example.com' }),
    { clientId: CLIENT_ID }
  )
  assert.ok(fatalFailures(checks).includes('iss'))
})

test('verifyClaims: aud 不匹配时拒绝（别人的应用签发的 token）', () => {
  const checks = verifyClaims(baseClaims({ aud: 'other-client' }), {
    clientId: CLIENT_ID,
  })
  assert.ok(fatalFailures(checks).includes('aud'))
})

test('verifyClaims: 未配置 clientId 时 aud 一律不通过（不能默认放行）', () => {
  const checks = verifyClaims(baseClaims(), { clientId: '' })
  assert.ok(fatalFailures(checks).includes('aud'))
})

test('verifyClaims: exp 过期时拒绝', () => {
  const past = Math.floor(Date.now() / 1000) - 3600
  const checks = verifyClaims(baseClaims({ iat: past - 10, exp: past }), {
    clientId: CLIENT_ID,
  })
  assert.ok(fatalFailures(checks).includes('exp'))
})

test('verifyClaims: nonce 不匹配时拒绝', () => {
  const checks = verifyClaims(baseClaims({ nonce: 'aaa' }), {
    clientId: CLIENT_ID,
    expectedNonce: 'bbb',
  })
  assert.ok(fatalFailures(checks).includes('nonce'))
})

test('verifyClaims: email_verified=false 时，requireVerifiedEmail 决定是否致命', () => {
  const claims = baseClaims({ email_verified: false })

  const lenient = verifyClaims(claims, { clientId: CLIENT_ID })
  assert.ok(
    !fatalFailures(lenient).includes('email_verified'),
    '默认不应因为未验证邮箱而拒绝（fatal=false）'
  )

  const strict = verifyClaims(claims, {
    clientId: CLIENT_ID,
    requireVerifiedEmail: true,
  })
  assert.ok(
    fatalFailures(strict).includes('email_verified'),
    'requireVerifiedEmail=true 时必须拒绝'
  )
})

test('verifyClaims: tokeninfo 风格的字符串 email_verified 也能识别', () => {
  const checks = verifyClaims(baseClaims({ email_verified: 'true' }), {
    clientId: CLIENT_ID,
    requireVerifiedEmail: true,
  })
  assert.deepStrictEqual(fatalFailures(checks), [])
})

test('verifyIdToken: 结构不是 3 段的 token 直接拒绝', async () => {
  const result = await verifyIdToken('not-a-jwt', { clientId: CLIENT_ID })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'malformed_token')
})

test('verifyIdToken: base64 内容不是 JSON 时拒绝', async () => {
  const result = await verifyIdToken('aaa.bbb.ccc', { clientId: CLIENT_ID })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'unparsable_token')
})

test('nonce store: 一次性 —— 第二次 take 必须失败', async () => {
  const store = createMemoryStore({ ttlSeconds: 60 })
  const { nonce } = await store.issue()

  assert.strictEqual(await store.take(nonce), '1', '第一次应当成功')
  assert.strictEqual(await store.take(nonce), '', '第二次必须失败（已被消费）')
})

test('nonce store: 未签发过的 nonce 不通过', async () => {
  const store = createMemoryStore({ ttlSeconds: 60 })
  assert.strictEqual(await store.take('forged-nonce'), '')
})

test('nonce store: 空值不通过（不能因为没传就放行）', async () => {
  const store = createMemoryStore({ ttlSeconds: 60 })
  assert.strictEqual(await store.take(''), '')
  assert.strictEqual(await store.take(undefined), '')
})
