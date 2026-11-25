const assert = require('assert')
const {
  createMemoryStore,
  createTokenManager,
  createClient,
  KIND,
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2')

describe('ne-auth-v2/request token lifecycle', function () {
  let time
  let store
  let client
  let manager
  let calls
  const initial = () => ({
    accessToken: 'a2.initial',
    refreshToken: 'r2.initial',
    expiresIn: 900,
    refreshExpiresIn: 86400,
    profile: { accountId: '10001' },
  })

  beforeEach(async function () {
    time = 100000
    calls = []
    store = createMemoryStore({ now: () => time })
    client = {
      async refresh(params) {
        calls.push(params)
        return {
          accessToken: `a2.rotated-${calls.length}`,
          refreshToken: `r2.rotated-${calls.length}`,
          expiresIn: 900,
          refreshExpiresIn: 86400,
        }
      },
      async logout() {},
    }
    manager = createTokenManager({ client, store, now: () => time })
    await manager.save('session', initial())
  })

  it('returns a valid token without refresh and rotates automatically before 15 minutes', async function () {
    assert.equal(await manager.getAccessToken('session'), 'a2.initial')
    assert.equal(calls.length, 0)
    time += 871000
    assert.equal(await manager.getAccessToken('session'), 'a2.rotated-1')
    assert.equal(calls.length, 1)
    assert.equal(store.get('session').refreshToken, 'r2.rotated-1')
    assert.equal(store.get('session').profile.accountId, '10001')
    assert.equal(await manager.getAccessToken('session'), 'a2.rotated-1')
    assert.equal(calls.length, 1)
    time += 901000
    assert.equal(await manager.getAccessToken('session'), 'a2.rotated-2')
    assert.equal(calls[1].refreshToken, 'r2.rotated-1')
  })
  it('uses the V2 15-minute lifetime when NE omits expiry fields, without refreshing on every request', async function () {
    let refreshes = 0
    const ne = createClient({
      clientId: 'flylatex',
      now: () => time,
      async request(method, url) {
        if (new URL(url).pathname === '/user/token') refreshes++
        return {
          status: 200,
          body: JSON.stringify({
            code: 0,
            data: {
              access_token: `a2.sparse-${refreshes}`,
              refresh_token: `r2.sparse-${refreshes}`,
              account_id: 10001,
            },
          }),
        }
      },
    })
    const sparse = createTokenManager({ client: ne, store, now: () => time })
    await sparse.save(
      'sparse',
      await ne.loginWithSmsCode({ mobile: '13800000000', code: '123456' })
    )
    assert.equal(await sparse.getAccessToken('sparse'), 'a2.sparse-0')
    time += 869000
    assert.equal(await sparse.getAccessToken('sparse'), 'a2.sparse-0')
    assert.equal(refreshes, 0)
    time += 2000
    assert.equal(await sparse.getAccessToken('sparse'), 'a2.sparse-1')
    assert.equal(await sparse.getAccessToken('sparse'), 'a2.sparse-1')
    assert.equal(refreshes, 1)
  })

  it('coalesces automatic concurrent requests and does not rotate again after a raced read', async function () {
    time += 901000
    const other = createTokenManager({ client, store, now: () => time })
    const tokens = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? other : manager).getAccessToken('session')
      )
    )
    assert.ok(tokens.every(token => token === 'a2.rotated-1'))
    assert.equal(calls.length, 1)
  })

  it('uses the new pair if another caller rotated between the expiry read and the refresh read', async function () {
    time += 901000
    const get = store.get.bind(store)
    let reads = 0
    store.get = key => {
      const value = get(key)
      if (++reads === 1)
        store.set(key, {
          ...initial(),
          accessToken: 'a2.raced',
          refreshToken: 'r2.raced',
        })
      return value
    }
    assert.equal(await manager.getAccessToken('session'), 'a2.raced')
    assert.equal(calls.length, 0)
  })

  it('honors slow_down without consuming the pair or returning access after its expiry', async function () {
    time += 871000
    client.refresh = async () => {
      calls.push('limited')
      throw new NeAuthError(KIND.SLOW_DOWN, { retryAfter: 60 })
    }
    assert.equal(await manager.getAccessToken('session'), 'a2.initial')
    assert.equal(await manager.getAccessToken('session'), 'a2.initial')
    assert.equal(calls.length, 1)
    time += 30000
    await assert.rejects(
      manager.getAccessToken('session'),
      error => error.kind === KIND.SLOW_DOWN
    )
    assert.equal(calls.length, 1)
    assert.equal(store.get('session').refreshToken, 'r2.initial')
  })

  it('retains usable access during a temporary early refresh failure, but rejects expired access', async function () {
    client.refresh = async () => {
      throw new NeAuthError(KIND.TEMPORARILY_UNAVAILABLE)
    }
    time += 871000
    assert.equal(await manager.getAccessToken('session'), 'a2.initial')
    time += 30000
    await assert.rejects(
      manager.getAccessToken('session'),
      error => error.kind === KIND.TEMPORARILY_UNAVAILABLE
    )
    assert.equal(store.get('session').refreshToken, 'r2.initial')
  })

  it('invalid_grant and uncertain network results invalidate the session instead of using old access', async function () {
    time += 901000
    client.refresh = async () => {
      throw new NeAuthError(KIND.INVALID_GRANT)
    }
    await assert.rejects(
      manager.getAccessToken('session'),
      error => error.kind === KIND.INVALID_GRANT
    )
    assert.equal(store.get('session'), null)
    await manager.save('session', initial())
    time += 901000
    client.refresh = async () => {
      throw new NeAuthError(KIND.NETWORK)
    }
    await assert.rejects(
      manager.getAccessToken('session'),
      error => error.kind === KIND.REFRESH_UNCERTAIN
    )
    assert.equal(store.get('session'), null)
  })

  it('rejects a refresh response belonging to another account', async function () {
    time += 901000
    client.refresh = async () => ({
      ...initial(),
      accessToken: 'other',
      refreshToken: 'other',
      profile: { accountId: '99999' },
    })
    await assert.rejects(
      manager.getAccessToken('session'),
      error => error.kind === KIND.REFRESH_UNCERTAIN
    )
    assert.equal(store.get('session'), null)
  })

  it('does not refresh after the NE session expires', async function () {
    time += 86401000
    // FIXED: 2026-10-27 会话到期报告为 SESSION_EXPIRED，不再与「NE 拒绝凭据」
    // 共用 INVALID_GRANT：前者是时间到了（一键重新连接），后者是被撤销。
    // OLD: error => error.kind === KIND.INVALID_GRANT
    await assert.rejects(
      manager.getAccessToken('session'),
      error => error.kind === KIND.SESSION_EXPIRED
    )
    assert.equal(calls.length, 0)
  })

  it('clears local credentials before logout and cannot be resurrected by a late refresh', async function () {
    time += 901000
    let finish
    client.refresh = () =>
      new Promise(resolve => {
        finish = resolve
      })
    client.logout = async ({ refreshToken }) => {
      assert.equal(refreshToken, 'r2.initial')
      assert.equal(store.get('session'), null)
    }
    const pending = manager.getAccessToken('session')
    const rejected = assert.rejects(
      pending,
      error => error.kind === KIND.INVALID_GRANT
    )
    await new Promise(resolve => setImmediate(resolve))
    await manager.clear('session')
    finish({ ...initial(), accessToken: 'late', refreshToken: 'late' })
    await rejected
    assert.equal(store.get('session'), null)
  })
})
