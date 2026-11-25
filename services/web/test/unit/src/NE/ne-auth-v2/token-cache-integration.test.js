const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const { EventEmitter } = require('events')
let RedisMock
try {
  RedisMock = require('ioredis-mock')
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}
const { startMockNe, DEFAULT_SMS_CODE } = require('./fixtures/mock-ne-server')
const { KIND } = require('../../../../../commercial/ne-auth-v2')

const WEB = path.resolve(__dirname, '../../../../..')
const NE = path.join(WEB, 'commercial')
const hash = value =>
  require('crypto').createHash('sha256').update(value).digest('hex')

function evaluate(filename, stubs, context = {}) {
  const from = createRequire(filename)
  const module = { exports: {} }
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module,
      Buffer,
      console: { log() {}, warn() {}, error() {} },
      require(name) {
        return Object.hasOwnProperty.call(stubs, name)
          ? stubs[name]
          : from(name)
      },
      ...context,
    },
    { filename }
  )
  return module.exports
}

function realLocker(redis) {
  const filename = path.resolve(
    WEB,
    '../../libraries/redis-wrapper/RedisWebLocker.js'
  )
  const Locker = evaluate(
    filename,
    {
      '@overleaf/metrics': {
        inc() {},
        gauge() {},
        Timer: class {
          constructor() {
            this.start = Date.now()
          }
          done() {}
        },
      },
      '@overleaf/logger': { debug() {}, warn() {} },
    },
    { process, setTimeout, clearTimeout }
  )
  return {
    withTimeout(timeout) {
      return new Locker({
        rclient: redis,
        getKey: (namespace, key) => `lock:web:${namespace}:${key}`,
        options: { redisLockExpiry: timeout },
      })
    },
  }
}

function loadCache(redis, client, writes = [], overrides = {}) {
  const io = {
    async mkdir() {},
    async writeFile(filename, value) {
      writes.push({ filename, value })
    },
    async unlink() {},
    async readFile() {
      const error = new Error('fixture has no legacy cache')
      error.code = 'ENOENT'
      throw error
    },
  }
  return evaluate(
    path.join(NE, 'tokenCache.js'),
    {
      fs: { promises: io },
      os: { tmpdir: () => '/fixture' },
      '../app/src/infrastructure/RedisWrapper': { client: () => redis },
      '../app/src/infrastructure/LockManager':
        overrides.locker || realLocker(redis),
      './index': { GetClient: () => client() },
    },
    {
      process: { pid: 1, on() {} },
      setInterval: () => 1,
      clearInterval() {},
      setTimeout,
      clearTimeout,
      ...overrides.context,
    }
  )
}

function loadService(mock, cache) {
  return evaluate(path.join(NE, 'index.js'), {
    '@overleaf/settings': {
      ne: { authV2: true, baseUrl: mock.baseUrl, clientId: 'flylatex' },
    },
    '@overleaf/promise-utils': { expressify: fn => fn },
    './tokenCache': cache,
    './utils': { encrypt: () => 'unused', PUBLIC_KEY: 'unused' },
    './ai-agent': {},
    './ai-config': {},
    '../app/src/infrastructure/Mongoose': { model: () => ({}) },
    '../app/src/models/User': { UserSchema: {} },
    '../app/src/models/Project': { ProjectSchema: {} },
  })
}

function loadSearch(cache, headers) {
  const https = {
    request(options, callback) {
      headers.push(options.headers)
      const response = new EventEmitter()
      response.statusCode = 200
      response.setEncoding = () => {}
      callback(response)
      const request = new EventEmitter()
      request.write = () => {}
      request.end = () =>
        queueMicrotask(() => {
          response.emit('data', JSON.stringify({ items: [] }))
          response.emit('end')
        })
      return request
    },
  }
  return evaluate(path.join(NE, 'crosrefsearch.js'), {
    https,
    './tokenCache': cache,
    '../app/src/Features/Authentication/SessionManager': {},
    '../app/src/Features/Project/ProjectGetter': {},
    '../app/src/Features/DocumentUpdater/DocumentUpdaterHandler': {},
    '../app/src/Features/Docstore/DocstoreManager': {},
  })
}

;(RedisMock ? describe : describe.skip)(
  'NE V2 login -> real tokenCache -> business request refresh',
  function () {
    this.timeout(20000)
    let redis
    let mock
    let cache
    let service
    let writes

    beforeEach(async function () {
      redis = new RedisMock()
      await redis.flushall()
      mock = await startMockNe({ captchaEnabled: false, rotateSeconds: 0 })
      writes = []
      cache = loadCache(redis, () => service.GetClient(), writes)
      service = loadService(mock, cache)
    })
    afterEach(async function () {
      await mock.close()
      redis.disconnect()
    })

    function passwordLogin() {
      return new Promise(resolve =>
        service.NELogin('demo@example.com', 'Passw0rd!', resolve)
      )
    }
    async function expire(alias = 'demo@example.com') {
      const key = `ne-auth-v2:tokens:${hash(alias)}`
      const pair = JSON.parse(await redis.get(key))
      pair.expiresAt = Date.now() / 1000 - 1
      await redis.set(key, JSON.stringify(pair), 'PX', 86400000)
      return { key, pair }
    }
    async function search(headers = [], region = 'global') {
      const module = loadSearch(cache, headers)
      let reply
      await module.crossRefSearch(
        {
          body: {
            userEmail: 'demo@example.com',
            filters: { title: 'fixture' },
            keywords: 'fixture',
            region,
          },
        },
        {
          json(value) {
            reply = value
            return value
          },
        }
      )
      return reply
    }

    it('saves a full pair on password login and refreshes the token actually sent by CrossRef', async function () {
      const login = await passwordLogin()
      assert.equal(login.code, 0)
      const { key, pair } = await expire()
      assert.equal(pair.refreshToken, login.refreshToken)
      assert.ok((await redis.pttl(key)) > 900000)
      const headers = []
      const reply = await search(headers)
      assert.equal(reply.code, 0)
      assert.equal(
        mock.requests.filter(request => request.path === '/user/token').length,
        1
      )
      const rotated = JSON.parse(await redis.get(key))
      assert.notEqual(rotated.refreshToken, pair.refreshToken)
      assert.equal(headers[0].Authorization, `Bearer NE:${rotated.accessToken}`)
      assert.equal(rotated.profile.accountId, '10001')
      assert.equal(
        await service.GetActiveToken('demo@example.com'),
        rotated.accessToken
      )
      assert.equal(await redis.get('ne:token:demo@example.com'), null)
      assert.equal(
        writes.some(write => String(write.value).includes(login.refreshToken)),
        false
      )
    })

    it('restores credentials after a worker restart and performs one rotation across concurrent workers', async function () {
      await passwordLogin()
      await expire()
      const other = loadCache(redis, () => service.GetClient())
      const values = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? other : cache).getByEmailFromRedis('demo@example.com')
        )
      )
      assert.ok(values.every(value => value === values[0]))
      assert.equal(
        mock.requests.filter(request => request.path === '/user/token').length,
        1
      )
    })
    it('SMS uses the same refresh lifecycle and its original cache identifier', async function () {
      const login = await new Promise(resolve =>
        service.SmsLogin('13800000000', DEFAULT_SMS_CODE, resolve)
      )
      assert.equal(login.code, 0)
      await expire('13800000000')
      const active = await cache.getByEmailFromRedis('13800000000')
      assert.notEqual(active, login.accessToken)
      assert.equal(
        mock.requests.filter(request => request.path === '/user/token').length,
        1
      )
    })

    it('CARSI finish persists the same full pair and personal search uses the refreshed AUT header', async function () {
      const tokens = await service.GetClient().loginWithPassword({
        target: 'demo@example.com',
        password: 'Passw0rd!',
      })
      await service.FinishLogin(tokens, '', {
        requireProfile: true,
        requireEntitlements: true,
      })
      await expire()
      const headers = []
      assert.equal((await search(headers, 'person')).code, 0)
      const active = await cache.getByEmailFromRedis('demo@example.com')
      assert.equal(headers[0].AUT, active)
      assert.notEqual(active, tokens.accessToken)
    })

    it('logout removes the V2 pair and never falls back to an old token from Redis or memory', async function () {
      await passwordLogin()
      cache.emailTokenMap.set('demo@example.com', {
        token: 'STALE_ACCESS',
        timestamp: Date.now(),
      })
      await redis.set('ne:token:demo@example.com', 'STALE_ACCESS')
      await cache.clearByEmail('demo@example.com')
      const headers = []
      assert.equal((await search(headers)).code, 401)
      assert.equal(headers.length, 0)
      assert.equal(
        mock.requests.filter(request => request.path === '/user/sessionlogout')
          .length,
        1
      )
    })

    it('a revoked NE refresh token stops at the token lookup without sending a stale business request', async function () {
      const login = await passwordLogin()
      await service.GetClient().logout({ refreshToken: login.refreshToken })
      await expire()
      await redis.set('ne:token:demo@example.com', 'STALE_ACCESS')
      const headers = []
      assert.equal((await search(headers)).code, 401)
      assert.equal(headers.length, 0)
    })

    it('fails login with a retryable message if the rotating pair cannot be persisted', async function () {
      const set = redis.set.bind(redis)
      redis.set = (...args) =>
        args[0].startsWith('ne-auth-v2:tokens:')
          ? Promise.reject(new Error('storage unavailable'))
          : set(...args)
      const login = await passwordLogin()
      assert.equal(login.code, 500)
      assert.ok(login.msg.includes('暂不可用'))
    })

    it('returns a typed temporary failure during Redis outage rather than a stale fallback', async function () {
      await passwordLogin()
      cache.emailTokenMap.set('demo@example.com', {
        token: 'STALE_ACCESS',
        timestamp: Date.now(),
      })
      redis.get = async () => {
        throw new Error('storage unavailable')
      }
      await assert.rejects(
        cache.getByEmailFromRedis('demo@example.com'),
        error => error.kind === KIND.STORAGE_UNAVAILABLE
      )
    })
    it('bounds a stalled shared lock and prevents a late acquisition from starting refresh', async function () {
      await passwordLogin()
      await expire()
      let timeout
      let runner
      const other = loadCache(redis, () => service.GetClient(), [], {
        locker: {
          withTimeout() {
            return {
              runWithLock(namespace, key, run) {
                runner = run
              },
            }
          },
        },
        context: {
          setTimeout(callback, ms) {
            if (ms === 60000) {
              timeout = callback
              return -1
            }
            return setTimeout(callback, ms)
          },
          clearTimeout(id) {
            if (id !== -1) clearTimeout(id)
          },
        },
      })
      const pending = other.getByEmailFromRedis('demo@example.com')
      const rejected = assert.rejects(
        pending,
        error => error.kind === KIND.STORAGE_UNAVAILABLE
      )
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(typeof timeout, 'function')
      timeout()
      await rejected
      await new Promise(resolve =>
        runner(error => {
          assert.equal(error.kind, KIND.STORAGE_UNAVAILABLE)
          resolve()
        })
      )
      assert.equal(
        mock.requests.filter(request => request.path === '/user/token').length,
        0
      )
    })
  }
)
