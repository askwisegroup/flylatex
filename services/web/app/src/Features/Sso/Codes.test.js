'use strict'

/**
 * authorization code 的一次性语义 + PKCE。
 *
 * 最关键的一条在中间：**并发重放只能有一个成功**。
 * 这是 `GET` + `DEL` 两步写法的唯一理由，也是最容易被改成「只 GET 就够了吧」
 * 的地方 —— 所以必须有测试钉死。
 */

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

const Codes = require('./Codes')
const Store = require('./Store')

function makeService() {
  return Codes.createCodeService({ store: Store.memoryStore() })
}

function verifier() {
  // RFC 7636 §4.1：43~128 个 unreserved 字符
  return crypto.randomBytes(32).toString('base64url')
}

test('S256 与 RFC 7636 附录 B 的示例一致', () => {
  // 附录 B 的 verifier / challenge 是官方测试向量
  assert.strictEqual(
    Codes.s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  )
})

test('code 正常换出 userId + scopes', async () => {
  const codes = makeService()
  const code = await codes.issue({
    userId: 'u1',
    clientId: 'word2latex',
    redirectUri: 'http://a/b',
    scopes: ['openid', 'profile'],
  })
  assert.ok(code.length >= 40)

  const granted = await codes.consume({
    code,
    clientId: 'word2latex',
    redirectUri: 'http://a/b',
  })
  assert.deepStrictEqual(granted, {
    userId: 'u1',
    scopes: ['openid', 'profile'],
  })
})

test('code 只能用一次', async () => {
  const codes = makeService()
  const code = await codes.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
  })
  await codes.consume({ code, clientId: 'c', redirectUri: 'http://a/b' })

  await assert.rejects(
    () => codes.consume({ code, clientId: 'c', redirectUri: 'http://a/b' }),
    err => err.code === 'invalid_grant'
  )
})

test('并发重放：只有一个能成功', async () => {
  const codes = makeService()
  const code = await codes.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
  })

  const results = await Promise.allSettled([
    codes.consume({ code, clientId: 'c', redirectUri: 'http://a/b' }),
    codes.consume({ code, clientId: 'c', redirectUri: 'http://a/b' }),
    codes.consume({ code, clientId: 'c', redirectUri: 'http://a/b' }),
  ])

  const ok = results.filter(r => r.status === 'fulfilled')
  const failed = results.filter(r => r.status === 'rejected')
  assert.strictEqual(ok.length, 1, '只能有一个成功')
  assert.strictEqual(failed.length, 2)
  for (const failure of failed) {
    assert.strictEqual(failure.reason.code, 'invalid_grant')
  }
})

test('client_id / redirect_uri 与授权时不一致即 invalid_grant', async () => {
  const codes = makeService()
  const code = await codes.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
  })

  await assert.rejects(
    () => codes.consume({ code, clientId: 'other', redirectUri: 'http://a/b' }),
    err => err.code === 'invalid_grant'
  )

  // 上一个失败已把 code 烧掉（故意的），所以这里必然也是 invalid_grant
  await assert.rejects(
    () => codes.consume({ code, clientId: 'c', redirectUri: 'http://a/c' }),
    err => err.code === 'invalid_grant'
  )
})

test('PKCE：正确 verifier 通过，错误/缺失/格式非法全部拒绝', async () => {
  const codes = makeService()
  const v = verifier()
  const code = await codes.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
    codeChallenge: Codes.s256(v),
    codeChallengeMethod: 'S256',
  })

  // 缺 verifier
  await assert.rejects(
    () => codes.consume({ code, clientId: 'c', redirectUri: 'http://a/b' }),
    err => err.code === 'invalid_grant'
  )

  const codes2 = makeService()
  const code2 = await codes2.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
    codeChallenge: Codes.s256(v),
  })
  // 错误 verifier
  await assert.rejects(
    () =>
      codes2.consume({
        code: code2,
        clientId: 'c',
        redirectUri: 'http://a/b',
        codeVerifier: verifier(),
      }),
    err => err.code === 'invalid_grant'
  )

  const codes3 = makeService()
  const code3 = await codes3.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
    codeChallenge: Codes.s256(v),
  })
  // 格式非法（太短）
  await assert.rejects(
    () =>
      codes3.consume({
        code: code3,
        clientId: 'c',
        redirectUri: 'http://a/b',
        codeVerifier: 'too-short',
      }),
    err => err.code === 'invalid_grant'
  )

  const codes4 = makeService()
  const code4 = await codes4.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
    codeChallenge: Codes.s256(v),
  })
  // 正确 verifier
  const granted = await codes4.consume({
    code: code4,
    clientId: 'c',
    redirectUri: 'http://a/b',
    codeVerifier: v,
  })
  assert.strictEqual(granted.userId, 'u1')
})

test('过期 code 换不出来', async () => {
  const store = Store.memoryStore()
  const codes = Codes.createCodeService({ store, ttlSeconds: 0 })
  const code = await codes.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  await assert.rejects(
    () => codes.consume({ code, clientId: 'c', redirectUri: 'http://a/b' }),
    err => err.code === 'invalid_grant'
  )
})

test('code 在存储里只以哈希形式出现', async () => {
  const store = Store.memoryStore()
  const codes = Codes.createCodeService({ store })
  const code = await codes.issue({
    userId: 'u1',
    clientId: 'c',
    redirectUri: 'http://a/b',
    scopes: ['openid'],
  })
  // 明文 code 不能作为 key 直接查到东西
  assert.strictEqual(store.get && (await store.get(code)), null)
  // 但哈希 key 能查到
  assert.notStrictEqual(await store.get(Codes.codeKey(code)), null)
})

test('isChallenge / isVerifier 只接受 RFC 7636 的字符集与长度', () => {
  assert.ok(Codes.isVerifier('a'.repeat(43)))
  assert.ok(Codes.isVerifier('a'.repeat(128)))
  assert.strictEqual(Codes.isVerifier('a'.repeat(42)), false)
  assert.strictEqual(Codes.isVerifier('a'.repeat(129)), false)
  assert.strictEqual(Codes.isVerifier('a'.repeat(42) + '+'), false)

  assert.ok(Codes.isChallenge(Codes.s256('x'.repeat(43))))
  assert.strictEqual(Codes.isChallenge('a'.repeat(42)), false)
})
