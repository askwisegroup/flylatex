'use strict'

/**
 * access token 的签发与校验。
 *
 * 断言的重点不是「能加密解密」，而是三条容易被优化掉的性质：
 *   · 存储里只有 SHA-256，翻出来不能直接当凭据用；
 *   · 无效 token 一律返回 null（不区分「过期」和「伪造」，不给探测信号）；
 *   · 过期就真的换不出东西。
 */

const test = require('node:test')
const assert = require('node:assert')

const Tokens = require('./Tokens')
const Store = require('./Store')

function makeService(ttlSeconds) {
  return Tokens.createTokenService({ store: Store.memoryStore(), ttlSeconds })
}

test('签发的 token 能换回 userId / clientId / scopes', async () => {
  const tokens = makeService()
  const issued = await tokens.issue({
    userId: 'u1',
    clientId: 'word2latex',
    scopes: ['openid', 'profile'],
  })

  assert.strictEqual(issued.tokenType, 'Bearer')
  assert.strictEqual(issued.expiresIn, Tokens.TOKEN_TTL_SECONDS)
  assert.strictEqual(issued.scope, 'openid profile')

  const payload = await tokens.verify(issued.accessToken)
  assert.deepStrictEqual(payload, {
    userId: 'u1',
    clientId: 'word2latex',
    scopes: ['openid', 'profile'],
  })
})

test('两次签发不会撞（32 字节随机）', async () => {
  const tokens = makeService()
  const a = await tokens.issue({ userId: 'u1', clientId: 'c', scopes: [] })
  const b = await tokens.issue({ userId: 'u1', clientId: 'c', scopes: [] })
  assert.notStrictEqual(a.accessToken, b.accessToken)
})

test('存储里只有哈希，明文 token 不作为 key', async () => {
  const store = Store.memoryStore()
  const tokens = Tokens.createTokenService({ store })
  const issued = await tokens.issue({
    userId: 'u1',
    clientId: 'c',
    scopes: [],
  })
  assert.strictEqual(await store.get(issued.accessToken), null)
  assert.notStrictEqual(
    await store.get(Tokens.tokenKey(issued.accessToken)),
    null
  )
})

test('无效 token 一律返回 null（不给「过期 vs 伪造」的区分信号）', async () => {
  const tokens = makeService()
  assert.strictEqual(await tokens.verify(''), null)
  assert.strictEqual(await tokens.verify(undefined), null)
  assert.strictEqual(await tokens.verify('not-a-token'), null)
  assert.strictEqual(
    await tokens.verify('A'.repeat(43)),
    null,
    '格式合法但没签发过，也是 null'
  )
})

test('过期 token 失效', async () => {
  const tokens = makeService(0)
  const issued = await tokens.issue({ userId: 'u1', clientId: 'c', scopes: [] })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.strictEqual(await tokens.verify(issued.accessToken), null)
})

test('存储内容损坏时返回 null 而不是抛错', async () => {
  const store = Store.memoryStore()
  const tokens = Tokens.createTokenService({ store })
  const issued = await tokens.issue({ userId: 'u1', clientId: 'c', scopes: [] })
  await store.setex(Tokens.tokenKey(issued.accessToken), 60, '{not json')
  assert.strictEqual(await tokens.verify(issued.accessToken), null)
})
