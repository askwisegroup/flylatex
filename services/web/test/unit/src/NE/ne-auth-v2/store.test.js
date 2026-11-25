const { expect } = require('chai')

const {
  createMemoryStore,
  expiryFromTokens,
  isAccessTokenExpired,
} = require('../../../../../commercial/ne-auth-v2/store')

describe('ne-auth-v2/store', function () {
  it('原子保存整对令牌（get 返回完整副本）', function () {
    const store = createMemoryStore()
    store.set('s1', { accessToken: 'a1', refreshToken: 'r1' })
    expect(store.get('s1')).to.deep.equal({
      accessToken: 'a1',
      refreshToken: 'r1',
    })

    // 替换必须是整对替换，不允许只更新 accessToken
    store.set('s1', { accessToken: 'a2', refreshToken: 'r2' })
    expect(store.get('s1')).to.deep.equal({
      accessToken: 'a2',
      refreshToken: 'r2',
    })
  })

  it('get 返回副本，外部改动不影响存储', function () {
    const store = createMemoryStore()
    store.set('s1', { accessToken: 'a1' })
    const got = store.get('s1')
    got.accessToken = 'tampered'
    expect(store.get('s1').accessToken).to.equal('a1')
  })

  it('delete / clear / size 行为正确', function () {
    const store = createMemoryStore()
    store.set('a', { accessToken: '1' })
    store.set('b', { accessToken: '2' })
    expect(store.size()).to.equal(2)
    expect(store.delete('a')).to.equal(true)
    expect(store.get('a')).to.equal(null)
    store.clear()
    expect(store.size()).to.equal(0)
  })

  it('超过 TTL 后自动失效', function () {
    let t = 1000
    const store = createMemoryStore({ ttlMs: 100, now: () => t })
    store.set('s', { accessToken: 'a' })
    expect(store.get('s')).to.not.equal(null)
    t = 1099
    expect(store.get('s')).to.not.equal(null)
    t = 1100
    expect(store.get('s')).to.equal(null)
  })

  it('expiryFromTokens 优先使用 expires_at（Unix 秒）', function () {
    expect(expiryFromTokens({ expiresAt: 1791686930 }, 0)).to.equal(
      1791686930000
    )
  })

  it('expiryFromTokens 回退到 expires_in', function () {
    expect(expiryFromTokens({ expiresIn: 900 }, 1000)).to.equal(1000 + 900000)
  })

  it('expires_in 的基准时刻不会在后续检查中改变', function () {
    const tokens = { expiresIn: 900 }
    expect(isAccessTokenExpired(tokens, { nowMs: 1000 })).to.equal(false)
    expect(isAccessTokenExpired(tokens, { nowMs: 901000 })).to.equal(true)
  })

  it('存储固定绝对到期时间，读取副本也会正确过期', function () {
    let clock = 1000
    const store = createMemoryStore({ now: () => clock })
    store.set('session', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
    })
    clock = 901000
    expect(
      isAccessTokenExpired(store.get('session'), { nowMs: clock })
    ).to.equal(true)
  })

  it('isAccessTokenExpired 留有默认 30 秒余量', function () {
    const now = 1_000_000_000_000
    const fresh = { expiresAt: (now + 60_000) / 1000 }
    expect(isAccessTokenExpired(fresh, { nowMs: now })).to.equal(false)
    // 只剩 10 秒，已进入 30 秒余量
    const almost = { expiresAt: (now + 10_000) / 1000 }
    expect(isAccessTokenExpired(almost, { nowMs: now })).to.equal(true)
    expect(isAccessTokenExpired(null, { nowMs: now })).to.equal(true)
  })
})
