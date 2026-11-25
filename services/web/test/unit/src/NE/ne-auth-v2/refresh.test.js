const { expect } = require('chai')

const {
  createRefresher,
} = require('../../../../../commercial/ne-auth-v2/refresh')
const {
  createMemoryStore,
} = require('../../../../../commercial/ne-auth-v2/store')
const {
  KIND,
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2/errors')

const TOKENS = {
  accessToken: 'a2.old',
  refreshToken: 'r2.old',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: Math.floor(Date.now() / 1000) + 900,
}
const NEW_TOKENS = {
  accessToken: 'a2.new',
  refreshToken: 'r2.new',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: TOKENS.expiresAt,
}

function newStore() {
  const store = createMemoryStore()
  store.set('s1', TOKENS)
  return store
}

async function expectKind(promise, kind) {
  try {
    await promise
    throw new Error(`预期抛出 ${kind}`)
  } catch (e) {
    if (!(e instanceof NeAuthError)) throw e
    expect(e.kind).to.equal(kind)
    return e
  }
}

describe('ne-auth-v2/refresh', function () {
  it('并发调用被合并为同一次刷新', async function () {
    let resolveRefresh
    let calls = 0
    const client = {
      refresh: () => {
        calls++
        return new Promise(r => {
          resolveRefresh = () => r(NEW_TOKENS)
        })
      },
    }
    const store = newStore()
    const refresher = createRefresher({ client, store })

    const p1 = refresher.refresh('s1')
    const p2 = refresher.refresh('s1')
    const p3 = refresher.refresh('s1')
    await new Promise(resolve => setImmediate(resolve))
    expect(calls).to.equal(1)

    resolveRefresh()
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).to.deep.equal(NEW_TOKENS)
    expect(r2).to.deep.equal(r1)
    expect(r3).to.deep.equal(r1)
    expect(calls).to.equal(1)
  })

  it('成功后原子替换整对令牌', async function () {
    const client = { refresh: async () => NEW_TOKENS }
    const store = newStore()
    const refresher = createRefresher({ client, store })
    await refresher.refresh('s1')
    expect(store.get('s1')).to.deep.equal(NEW_TOKENS)
  })

  it('传给 NE 的 request_id 满足 16–128 位 [A-Za-z0-9_-]', async function () {
    const seen = []
    const client = { refresh: async a => (seen.push(a), NEW_TOKENS) }
    const store = newStore()
    const refresher = createRefresher({ client, store })
    await refresher.refresh('s1')
    expect(seen[0].requestId).to.match(/^[A-Za-z0-9_-]{16,128}$/)
    expect(seen[0].refreshToken).to.equal('r2.old')
  })

  it('并发结束后可以再次刷新（inFlight 已清理）', async function () {
    let calls = 0
    const client = { refresh: async () => (calls++, NEW_TOKENS) }
    const store = newStore()
    const refresher = createRefresher({ client, store })
    await refresher.refresh('s1')
    await refresher.refresh('s1')
    expect(calls).to.equal(2)
  })

  it('slow_down 时抛出并**保留**凭据（不当作会话失效）', async function () {
    const err = new NeAuthError(KIND.SLOW_DOWN, { retryAfter: 42 })
    const client = {
      refresh: async () => {
        throw err
      },
    }
    const store = newStore()
    const refresher = createRefresher({ client, store })

    const caught = await expectKind(refresher.refresh('s1'), KIND.SLOW_DOWN)
    expect(caught.retryAfter).to.equal(42)
    expect(store.get('s1')).to.deep.equal(TOKENS)
  })

  it('temporarily_unavailable 时保留凭据', async function () {
    const client = {
      refresh: async () => {
        throw new NeAuthError(KIND.TEMPORARILY_UNAVAILABLE, {})
      },
    }
    const store = newStore()
    const refresher = createRefresher({ client, store })
    await expectKind(refresher.refresh('s1'), KIND.TEMPORARILY_UNAVAILABLE)
    expect(store.get('s1')).to.deep.equal(TOKENS)
  })

  it('invalid_grant 时清除凭据（需要重新登录）', async function () {
    const client = {
      refresh: async () => {
        throw new NeAuthError(KIND.INVALID_GRANT, {})
      },
    }
    const store = newStore()
    const refresher = createRefresher({ client, store })
    await expectKind(refresher.refresh('s1'), KIND.INVALID_GRANT)
    expect(store.get('s1')).to.equal(null)
  })

  it('没有 refresh_token 时直接 invalid_grant', async function () {
    const client = { refresh: async () => NEW_TOKENS }
    const store = createMemoryStore()
    const refresher = createRefresher({ client, store })
    await expectKind(refresher.refresh('missing'), KIND.INVALID_GRANT)
  })

  it('网络错误在 10 秒窗口内重试一次，复用相同 request_id 与原刷新令牌', async function () {
    const seen = []
    const client = {
      refresh: async a => {
        seen.push(a)
        if (seen.length === 1) throw new NeAuthError(KIND.NETWORK, {})
        return NEW_TOKENS
      },
    }
    const store = newStore()
    const refresher = createRefresher({ client, store })

    const result = await refresher.refresh('s1')
    expect(result).to.deep.equal(NEW_TOKENS)
    expect(seen).to.have.length(2)
    expect(seen[1].requestId).to.equal(seen[0].requestId)
    expect(seen[1].refreshToken).to.equal(seen[0].refreshToken)
    expect(store.get('s1')).to.deep.equal(NEW_TOKENS)
  })

  it('超出 10 秒窗口后不再重放旧凭据（只调用一次）', async function () {
    let clock = 1_000_000
    let calls = 0
    const client = {
      refresh: async () => {
        calls++
        clock += 11_000 // 模拟请求耗时超过窗口
        throw new NeAuthError(KIND.NETWORK, {})
      },
    }
    const store = newStore()
    const refresher = createRefresher({ client, store, now: () => clock })

    const error = await expectKind(
      refresher.refresh('s1'),
      KIND.REFRESH_UNCERTAIN
    )
    expect(calls).to.equal(1)
    expect(error.requiresRelogin).to.equal(true)
    expect(store.get('s1')).to.equal(null)
    await expectKind(refresher.refresh('s1'), KIND.INVALID_GRANT)
    expect(calls).to.equal(1)
  })

  it('重试后仍无法确认结果则停止刷新，不再次重放旧凭据', async function () {
    let calls = 0
    const client = {
      refresh: async () => {
        calls++
        throw new NeAuthError(KIND.NETWORK, {})
      },
    }
    const store = newStore()
    const refresher = createRefresher({ client, store })
    await expectKind(refresher.refresh('s1'), KIND.REFRESH_UNCERTAIN)
    expect(calls).to.equal(2)
    expect(store.get('s1')).to.equal(null)
    await expectKind(refresher.refresh('s1'), KIND.INVALID_GRANT)
    expect(calls).to.equal(2)
  })

  it('等待异步存储的读取和整对写入完成', async function () {
    const backing = newStore()
    let saved = false
    const store = {
      get: async key => backing.get(key),
      delete: async key => backing.delete(key),
      set: async (key, value) => {
        await new Promise(resolve => setImmediate(resolve))
        backing.set(key, value)
        if (value.refreshToken === NEW_TOKENS.refreshToken) saved = true
      },
    }
    const refresher = createRefresher({
      store,
      client: { refresh: async () => NEW_TOKENS },
    })
    await refresher.refresh('s1')
    expect(saved).to.equal(true)
    expect(backing.get('s1')).to.deep.equal(NEW_TOKENS)
  })

  it('两个 refresher 共享存储时不会重复轮换同一令牌', async function () {
    let calls = 0
    const store = newStore()
    const client = {
      refresh: async () => {
        calls++
        await new Promise(resolve => setImmediate(resolve))
        return NEW_TOKENS
      },
    }
    const a = createRefresher({ store, client })
    const b = createRefresher({ store, client })
    const values = await Promise.all([a.refresh('s1'), b.refresh('s1')])
    expect(calls).to.equal(1)
    expect(values[0]).to.deep.equal(values[1])
  })

  it('刷新期间退出不会被迟到的响应恢复登录凭据', async function () {
    const store = newStore()
    const client = {
      refresh: async () => {
        store.delete('s1')
        return NEW_TOKENS
      },
    }
    await expectKind(
      createRefresher({ store, client }).refresh('s1'),
      KIND.INVALID_GRANT
    )
    expect(store.get('s1')).to.equal(null)
  })

  it('写入失败后在窗口内恢复时复用未决请求 ID', async function () {
    const backing = newStore()
    let writable = false
    const seen = []
    const store = {
      get: async key => backing.get(key),
      delete: async (...args) => backing.delete(...args),
      replace: async (key, old, value) => {
        if (!value.refreshPending && !writable)
          throw new Error('storage offline')
        return backing.replace(key, old, value)
      },
    }
    const client = {
      refresh: async params => {
        seen.push(params)
        return NEW_TOKENS
      },
    }
    const refresher = createRefresher({ store, client })
    await expectKind(refresher.refresh('s1'), KIND.STORAGE_UNAVAILABLE)
    writable = true
    await refresher.refresh('s1')
    expect(seen[1].requestId).to.equal(seen[0].requestId)
    expect(seen[1].refreshToken).to.equal(seen[0].refreshToken)
    expect(backing.get('s1')).to.deep.equal(NEW_TOKENS)
  })
  it('存储耗时跨过幂等窗口时，不再发送刷新请求', async function () {
    let clock = 1000
    let calls = 0
    const backing = newStore()
    const store = {
      get: async key => backing.get(key),
      delete: async (...args) => backing.delete(...args),
      replace: async (...args) => {
        clock += 11000
        return backing.replace(...args)
      },
    }
    const client = {
      refresh: async () => {
        calls++
        return NEW_TOKENS
      },
    }
    await expectKind(
      createRefresher({ store, client, now: () => clock }).refresh('s1'),
      KIND.REFRESH_UNCERTAIN
    )
    expect(calls).to.equal(0)
    expect(backing.get('s1')).to.equal(null)
  })
})
