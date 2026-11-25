const { expect } = require('chai')
const path = require('path')
const Module = require('module')
const { ObjectId } = require('mongodb')
const sdk = require('../../../../../commercial/ne-auth-v2')
const { startMockNe } = require('./fixtures/mock-ne-server')

const WEB = path.resolve(__dirname, '../../../../..')
const NE = path.join(WEB, 'commercial')
const INDEX = path.join(NE, 'index.js')
const CARSI = path.join(NE, 'carsi.js')
const V2 = path.join(NE, 'carsi-v2.js')
const CALLBACK = path.join(
  WEB,
  'app/src/Features/Authentication/CarsiAuthCallbackController.js'
)
const SESSION_REDIS = path.join(
  WEB,
  'app/src/Features/User/UserSessionsRedis.js'
)
// FIXED: 2026-10-23 CARSI 回调新增登录审计日志，用桩避免单测触达 MongoDB
const AUDIT_LOG = path.join(
  WEB,
  'app/src/Features/User/UserAuditLogHandler.js'
)
let users
let projects
let updates
let creations
let cached
let transactionStore
let auditEntries
const settings = { ne: {} }
const User = {
  findOne(query, callback) {
    const conditions = query.$or || [query]
    callback(
      null,
      users.find(user =>
        conditions.some(condition =>
          Object.entries(condition).every(
            ([key, value]) => String(user[key]) === String(value)
          )
        )
      ) || null
    )
  },
  updateOne(query, update, callback) {
    updates.push(update)
    const target = users.find(user => user._id === query._id)
    // FIXED: 2026-10-23 支持 features.compileTimeout 这类点路径写入
    if (update.$set) {
      for (const key of Object.keys(update.$set)) {
        const parts = key.split('.')
        let cursor = target
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') {
            cursor[parts[i]] = {}
          }
          cursor = cursor[parts[i]]
        }
        cursor[parts[parts.length - 1]] = update.$set[key]
      }
    }
    if (update.$inc) {
      for (const key of Object.keys(update.$inc)) {
        target[key] = (target[key] || 0) + update.$inc[key]
      }
    }
    callback(null)
  },
}
const Project = {
  countDocuments: (query, callback) =>
    callback(
      null,
      projects.filter(project => project.owner_ref === query.owner_ref).length
    ),
}
const stubs = {
  '@overleaf/settings': settings,
  '@overleaf/promise-utils': { expressify: fn => fn },
  '@overleaf/logger': { info() {}, warn() {}, err() {}, debug() {} },
  [path.join(WEB, 'app/src/infrastructure/Mongoose.js')]: { model: () => ({}) },
  // FIXED: 2026-10-23 NeAccountSync 读 Mongo institutions 集合校验机构
  [path.join(WEB, 'app/src/infrastructure/mongodb.js')]: {
    db: {
      institutions: {
        find: () => ({
          toArray: cb =>
            cb(null, [
              { eduName: '中山大学' },
              { eduName: '深圳大学' },
            ]),
        }),
      },
    },
    ObjectId,
  },
  [path.join(WEB, 'app/src/models/User.js')]: { UserSchema: {}, User },
  [path.join(WEB, 'app/src/models/Project.js')]: { ProjectSchema: {}, Project },
  [path.join(WEB, 'app/src/Features/User/UserCreator.js')]: {
    createNewUser() {
      creations++
      throw new Error('Existing user must not be recreated')
    },
  },
  [path.join(WEB, 'app/src/Features/User/UserSessionsRedis.js')]: {
    client: () => ({}),
  },
  [path.join(NE, 'tokenCache.js')]: {
    setV2Tokens: async (...args) => {
      cached.push(args)
    },
    setBySession: async (...args) => {
      cached.push(args)
    },
    setByEmail: async (...args) => {
      cached.push(args)
    },
  },
  [path.join(NE, 'ai-agent.js')]: { aiChatService() {}, AI_SYSTEM_PROMPTS: {} },
  [path.join(NE, 'ai-config.js')]: {},
  [path.join(NE, 'utils.js')]: {
    encrypt: () => 'unused',
    PUBLIC_KEY: 'unused',
  },
}

function loadWorker() {
  const original = Module.prototype.require
  Module.prototype.require = function (name) {
    if (this.filename === V2 && name === './ne-auth-v2') {
      return { ...sdk, createRedisTransactionStore: () => transactionStore }
    }
    let resolved
    try {
      resolved = Module._resolveFilename(name, this)
    } catch (error) {}
    if (Object.prototype.hasOwnProperty.call(stubs, name)) return stubs[name]
    if (resolved && Object.prototype.hasOwnProperty.call(stubs, resolved))
      return stubs[resolved]
    return original.apply(this, arguments)
  }
  try {
    delete require.cache[V2]
    return require(V2)
  } finally {
    Module.prototype.require = original
  }
}

function session() {
  return { save: callback => callback(null) }
}
function exchange(url) {
  return new Promise((resolve, reject) => {
    require('http')
      .get(`${url}&mock_format=json`, response => {
        let body = ''
        response.on('data', value => {
          body += value
        })
        response.on('end', () => resolve(JSON.parse(body)))
      })
      .on('error', reject)
  })
}
async function start(worker, currentSession) {
  let url
  await worker.startCarsiLogin(
    { session: currentSession },
    {
      redirect: value => {
        url = value
      },
    }
  )
  return url
}
async function callback(worker, currentSession, query) {
  let loggedIn
  let redirect
  const req = {
    session: currentSession,
    query,
    body: {},
    login(user, done) {
      loggedIn = user
      done(null)
    },
  }
  await worker.handleCarsiCallback(
    req,
    {
      redirect: value => {
        redirect = value
      },
    },
    error => {
      throw error
    }
  )
  return { loggedIn, redirect }
}

describe('ne-auth-v2/CARSI legacy user compatibility', function () {
  let mock
  let worker
  let options
  let originalLog
  let originalError
  let previousRedisModule
  let previousAuditModule
  beforeEach(async function () {
    users = [
      {
        _id: 'old-owner',
        account_id: '10001',
        email: 'old-primary@example.com',
        carsiEmail: 'demo@example.com',
        features: { compileTimeout: 120 },
      },
    ]
    projects = [{ _id: 'old-project', owner_ref: 'old-owner' }]
    updates = []
    creations = 0
    cached = []
    auditEntries = []
    transactionStore = sdk.createMemoryTransactionStore()
    options = {}
    mock = await startMockNe(options)
    settings.ne = {
      baseUrl: mock.baseUrl,
      clientId: 'flylatex',
      redirectUri: 'https://test.invalid/ne-auth-callback',
    }
    previousRedisModule = require.cache[SESSION_REDIS]
    require.cache[SESSION_REDIS] = {
      id: SESSION_REDIS,
      filename: SESSION_REDIS,
      loaded: true,
      exports: stubs[SESSION_REDIS],
    }
    // FIXED: 2026-10-23 惰性 require 的审计日志也走桩，避免单测连 MongoDB
    previousAuditModule = require.cache[AUDIT_LOG]
    require.cache[AUDIT_LOG] = {
      id: AUDIT_LOG,
      filename: AUDIT_LOG,
      loaded: true,
      exports: {
        addEntry: function (...args) {
          auditEntries.push(args)
        },
      },
    }
    for (const file of [INDEX, CARSI, CALLBACK]) delete require.cache[file]
    worker = loadWorker()
    originalLog = console.log
    originalError = console.error
    console.log = () => {}
    console.error = () => {}
  })
  afterEach(async function () {
    console.log = originalLog
    console.error = originalError
    await mock.close()
    for (const file of [INDEX, CARSI, CALLBACK, V2]) delete require.cache[file]
    if (previousRedisModule) require.cache[SESSION_REDIS] = previousRedisModule
    else delete require.cache[SESSION_REDIS]
    if (previousAuditModule) require.cache[AUDIT_LOG] = previousAuditModule
    else delete require.cache[AUDIT_LOG]
  })
  it('the V2 callback reuses the original user and resources in the same request', async function () {
    const browser = session()
    const issued = await exchange(await start(worker, browser))
    const result = await callback(worker, browser, issued)
    expect(result.redirect).to.equal('/project')
    expect(result.loggedIn._id).to.equal('old-owner')
    expect(result.loggedIn.email).to.equal('old-primary@example.com')
    expect(projects[0].owner_ref).to.equal(result.loggedIn._id)
    expect(creations).to.equal(0)
    // FIXED: 2026-10-23 CARSI 登录需补记登录统计
    expect(result.loggedIn.loginCount).to.equal(1)
    expect(result.loggedIn.lastLoggedIn).to.be.instanceOf(Date)
    expect(auditEntries).to.have.length(1)
    expect(auditEntries[0][4]).to.deep.equal({ method: 'CARSI login' })
    expect(
      cached.some(
        value => value[2] === 'demo@example.com' && value[1].refreshToken
      )
    ).to.equal(true)
  })
  it('a different browser cannot consume the transaction before the original browser completes', async function () {
    const browser = session()
    const issued = await exchange(await start(worker, browser))
    const wrong = await callback(
      worker,
      { ...session(), neAuthV2Binding: 'other-browser' },
      issued
    )
    expect(wrong.redirect).to.equal('/login')
    expect(wrong.loggedIn).to.equal(undefined)
    const result = await callback(worker, browser, issued)
    expect(result.loggedIn._id).to.equal('old-owner')
    expect(creations).to.equal(0)
  })
  it('a callback can move to another worker using the shared transaction store', async function () {
    const browser = session()
    const issued = await exchange(await start(worker, browser))
    const second = loadWorker()
    const result = await callback(second, browser, issued)
    expect(result.loggedIn._id).to.equal('old-owner')
  })
  it('profile failures do not downgrade a VIP or create a replacement user', async function () {
    users[0].features.compileTimeout = 600
    options.userInfoError = {
      code: 3000,
      data: { error: 'temporarily_unavailable' },
    }
    const browser = session()
    const issued = await exchange(await start(worker, browser))
    const result = await callback(worker, browser, issued)
    expect(result.redirect).to.equal('/login')
    expect(result.loggedIn).to.equal(undefined)
    expect(users[0].features.compileTimeout).to.equal(600)
    expect(updates).to.have.length(0)
    expect(creations).to.equal(0)
    expect(cached).to.have.length(0)
  })
  it('legacy placeholder email identities still resolve to the original project owner', async function () {
    users[0].account_id = undefined
    users[0].email = '10001@example.com'
    users[0].carsiEmail = undefined
    const browser = session()
    const issued = await exchange(await start(worker, browser))
    const result = await callback(worker, browser, issued)
    expect(result.loggedIn._id).to.equal('old-owner')
    expect(projects[0].owner_ref).to.equal('old-owner')
    expect(creations).to.equal(0)
  })
})
