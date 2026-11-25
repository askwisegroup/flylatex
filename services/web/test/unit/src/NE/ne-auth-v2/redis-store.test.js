const { expect } = require('chai')
const {
  createRedisStore,
  createRedisTransactionStore,
  createMemoryStore,
  createRefresher,
  KIND,
} = require('../../../../../commercial/ne-auth-v2')

// Optional Lua-backed validation; the SDK itself has no Redis dependency.
let RedisMock
try {
  RedisMock = require('ioredis-mock')
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}

;(RedisMock ? describe : describe.skip)(
  'ne-auth-v2/Redis atomic storage',
  function () {
    let redis
    beforeEach(function () {
      redis = new RedisMock()
    })
    afterEach(function () {
      redis.disconnect()
    })
    it('wrong browser bindings do not consume a transaction; concurrent correct callbacks consume it once', async function () {
      const store = createRedisTransactionStore({ redis, prefix: 'test:tx:' })
      await store.set(
        'state',
        { verifier: 'private', binding: 'original' },
        1000
      )
      expect(await store.take('state', 'other')).to.equal(null)
      const result = await Promise.all([
        store.take('state', 'original'),
        store.take('state', 'original'),
      ])
      expect(result.filter(Boolean)).to.have.length(1)
      expect(result.find(Boolean).verifier).to.equal('private')
    })
    it('late refresh responses cannot replace or delete a new login token', async function () {
      const lock = createMemoryStore()
      const store = createRedisStore({
        redis,
        prefix: 'test:tokens:',
        withLock: lock.withLock.bind(lock),
      })
      await store.set('session', {
        accessToken: 'new-access',
        refreshToken: 'new-login',
      })
      expect(
        await store.replace('session', 'old-login', {
          accessToken: 'old-response',
          refreshToken: 'rotated-old',
        })
      ).to.equal(false)
      expect(await store.delete('session', 'old-login')).to.equal(false)
      expect((await store.get('session')).refreshToken).to.equal('new-login')
    })
    it('a change between reading and the Lua write is rejected atomically', async function () {
      const lock = createMemoryStore()
      const store = createRedisStore({
        redis,
        prefix: 'test:cas:',
        withLock: lock.withLock.bind(lock),
      })
      await store.set('session', { accessToken: 'old', refreshToken: 'old' })
      const evaluate = redis.eval.bind(redis)
      redis.eval = async (...args) => {
        await redis.set(
          'test:cas:session',
          JSON.stringify({ accessToken: 'new', refreshToken: 'new' })
        )
        return evaluate(...args)
      }
      expect(
        await store.replace('session', 'old', {
          accessToken: 'late',
          refreshToken: 'late',
        })
      ).to.equal(false)
      expect((await store.get('session')).refreshToken).to.equal('new')
    })
    it('two refresh coordinators share the injected lock and publish one rotation', async function () {
      const lock = createMemoryStore()
      const options = {
        redis,
        prefix: 'test:shared:',
        withLock: lock.withLock.bind(lock),
      }
      const a = createRedisStore(options)
      const b = createRedisStore(options)
      await a.set('session', { accessToken: 'old', refreshToken: 'old' })
      let calls = 0
      const client = {
        refresh: async () => {
          calls++
          return { accessToken: 'new', refreshToken: 'new' }
        },
      }
      const values = await Promise.all([
        createRefresher({ store: a, client }).refresh('session'),
        createRefresher({ store: b, client }).refresh('session'),
      ])
      expect(calls).to.equal(1)
      expect(values[0]).to.deep.equal(values[1])
    })
    it('corrupt persisted data is a typed storage failure', async function () {
      const store = createRedisTransactionStore({
        redis,
        prefix: 'test:corrupt:',
      })
      await redis.set('test:corrupt:state', '{broken')
      try {
        await store.get('state')
      } catch (error) {
        expect(error.kind).to.equal(KIND.STORAGE_UNAVAILABLE)
        return
      }
      throw new Error('Expected invalid stored data to fail')
    })
    it('bounds unavailable storage instead of leaving authentication pending forever', async function () {
      const unavailable = {
        get: () => new Promise(() => {}),
        set() {},
        eval() {},
      }
      const store = createRedisTransactionStore({
        redis: unavailable,
        timeoutMs: 10,
      })
      try {
        await store.get('state')
      } catch (error) {
        expect(error.kind).to.equal(KIND.STORAGE_UNAVAILABLE)
        return
      }
      throw new Error('Expected unavailable storage to time out')
    })
  }
)
