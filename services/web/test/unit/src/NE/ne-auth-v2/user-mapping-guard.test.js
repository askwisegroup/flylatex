const { expect } = require('chai')
const path = require('path')
const Module = require('module')

/**
 * 用户匹配守卫测试（业务红线）
 *
 * 业务红线：换一种登录方式（密码 / 短信 / CARSI）**不能新建用户**，
 * 否则老用户登录后会看不到自己原有的文档。
 *
 * 这里加载真实的 AuthenticationManager，只把数据层换成桩，验证：
 *   1. 短信登录复用与密码登录**完全相同**的解析函数，且用手机号做标识
 *   2. 命中已有用户时返回该用户，绝不调用 UserCreator
 *   3. 只有 account_id / email / carsiEmail / 遗留 {account_id}@example.com
 *      全部未命中时才创建新用户
 *
 * 桩按「查询内容」作答，不依赖查询的调用顺序。
 */

/**
 * 极简 stub。不用 sinon：本地 node_modules 里的 sinon 是不完整的副本，
 * 会遮蔽 NODE_PATH；且项目单测依赖当前未安装。
 */
function createStub(defaultImpl) {
  function stub(...args) {
    stub.calls.push(args)
    const impl = stub.impls[stub.calls.length] || stub.defaultImpl
    if (impl) return impl(...args)
  }
  stub.calls = []
  stub.impls = {}
  stub.defaultImpl = defaultImpl
  stub.callsFake = impl => {
    stub.defaultImpl = impl
    return stub
  }
  stub.reset = () => {
    stub.calls = []
    stub.impls = {}
    stub.defaultImpl = undefined
  }
  Object.defineProperty(stub, 'called', { get: () => stub.calls.length > 0 })
  Object.defineProperty(stub, 'calledOnce', {
    get: () => stub.calls.length === 1,
  })
  Object.defineProperty(stub, 'firstCall', {
    get: () => ({ args: stub.calls[0] }),
  })
  return stub
}

const WEB = path.resolve(__dirname, '../../../../..')
const AM = path.join(
  WEB,
  'app/src/Features/Authentication/AuthenticationManager.js'
)

class FakeError extends Error {}
class ParallelLoginError extends FakeError {}

const User = {
  findOne: createStub(),
  countDocuments: createStub(),
  updateOne: createStub(),
}
const Project = { countDocuments: createStub() }
const UserCreator = { createNewUser: createStub() }
const NEService = {
  SpecialUsers: ['special@example.com'],
  NELogin: createStub(),
  SmsLogin: createStub(),
}

const STUBS = {
  [path.join(WEB, 'app/src/models/User.js')]: { User },
  [path.join(WEB, 'app/src/models/Project.js')]: { Project },
  [path.join(WEB, 'app/src/infrastructure/mongodb.js')]: {
    db: {
      users: {
        // _setUserPasswordInMongo 用 db.users.updateOne(filter, update, cb)
        updateOne: (filter, update, cb) => cb(null, { modifiedCount: 1 }),
      },
    },
    ObjectId: function ObjectId() {},
  },
  [path.join(WEB, 'app/src/Features/User/UserCreator.js')]: UserCreator,
  [path.join(WEB, 'app/src/Features/User/UserAuditLogHandler.js')]: {
    addEntry: createStub(),
  },
  [path.join(WEB, 'app/src/Features/Helpers/EmailHelper.js')]: {
    parseEmail: e => (String(e).includes('@') ? { address: e } : null),
  },
  [path.join(WEB, 'app/src/Features/Helpers/DiffHelper.js')]: {
    diff: () => '',
  },
  [path.join(WEB, 'app/src/Features/Authentication/AuthenticationErrors.js')]: {
    ParallelLoginError,
    InvalidEmailError: FakeError,
    InvalidPasswordError: FakeError,
  },
  [path.join(WEB, 'app/src/Features/Authentication/HaveIBeenPwned.js')]: {
    checkPasswordForReuse: (password, cb) => cb(null, false),
    checkPasswordForReuseInBackground: () => {},
  },
  [path.join(WEB, 'commercial/index.js')]: NEService,
  [path.join(WEB, 'commercial/carsi.js')]: {
    getTempPasswordByEmail: () => null,
  },
  '@overleaf/settings': {
    ne: { authV2: true },
    security: { bcryptRounds: 12, bcryptMinorVersion: 'a' },
  },
  '@overleaf/logger': {
    debug() {},
    info() {},
    warn() {},
    err() {},
    error() {},
    log() {},
  },
  '@overleaf/metrics': {
    inc: createStub(),
    timing: createStub(),
    gauge: createStub(),
  },
  bcrypt: {
    getRounds: () => 12,
    compare: (a, b, cb) => cb(null, a === b),
    genSalt: (rounds, minor, cb) => cb(null, '$2a$12$0123456789012345678901'),
    hash: (password, salt, cb) => cb(null, salt + 'x'.repeat(31)),
  },
}

const origRequire = Module.prototype.require

function loadAuthenticationManager() {
  Module.prototype.require = function (request) {
    let resolved = null
    try {
      resolved = Module._resolveFilename(request, this)
    } catch (e) {
      /* 解析失败则交给原始 require 去报错 */
    }
    if (resolved && Object.prototype.hasOwnProperty.call(STUBS, resolved)) {
      return STUBS[resolved]
    }
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) {
      return STUBS[request]
    }
    return origRequire.apply(this, arguments)
  }
  try {
    delete require.cache[AM]
    return require(AM)
  } finally {
    Module.prototype.require = origRequire
  }
}

function callAsync(fn, ...args) {
  return new Promise(resolve => fn(...args, (...cbArgs) => resolve(cbArgs)))
}

// _findOrUpdateByEmailOrCreate 会并行发两种查询，这里按查询形态区分
function isAccountIdQuery(q) {
  return !!q && q.account_id !== undefined
}
function isIdentityQuery(q) {
  return !!q && q.$or !== undefined
}

/** 按查询内容作答，与调用顺序无关 */
function stubFindOne({ byAccountId = null, byIdentity = null, queries } = {}) {
  User.findOne.callsFake((q, cb) => {
    if (queries) {
      queries.push(q)
    }
    if (isAccountIdQuery(q)) {
      return cb(null, byAccountId)
    }
    if (isIdentityQuery(q)) {
      return cb(null, byIdentity)
    }
    return cb(null, null)
  })
}

function stubProjectCounts(countByUserId) {
  Project.countDocuments.callsFake((q, cb) =>
    cb(null, countByUserId[q.owner_ref] || 0)
  )
}

function smsOk(accountId, nickName = 'N') {
  return { code: 0, account_id: accountId, nick_name: nickName, inst_name: '' }
}

describe('ne-auth-v2/用户匹配守卫（换登录方式不能新建用户）', function () {
  this.timeout(20000)

  let AuthenticationManager

  const EXISTING_USER = {
    _id: 'existing-user-id',
    email: 'user@example.com',
    carsiEmail: '15810024047',
    account_id: '10001',
    loginEpoch: 1,
  }

  beforeEach(function () {
    User.findOne.reset()
    User.countDocuments.reset()
    User.updateOne.reset()
    Project.countDocuments.reset()
    UserCreator.createNewUser.reset()
    NEService.SmsLogin.reset()
    NEService.NELogin.reset()
    User.updateOne.callsFake((query, update, cb) => cb(null))
    User.countDocuments.callsFake((q, cb) => cb(null, 1))
    stubProjectCounts({})
  })

  let originalLog

  before(function () {
    AuthenticationManager = loadAuthenticationManager()
    // 这条路径上 AuthenticationManager 有较多调试日志，测试期间静音以免刷屏
    originalLog = console.log
    console.log = () => {}
  })

  after(function () {
    console.log = originalLog
  })

  it('短信登录复用密码登录的解析函数，且用「手机号」作为标识', async function () {
    const queries = []
    stubFindOne({ byIdentity: EXISTING_USER, queries })
    NEService.SmsLogin.callsFake((mobile, code, cb) => cb(smsOk(10001)))

    const [, user] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '15810024047',
      '123456'
    )

    expect(user, '应返回已有用户').to.equal(EXISTING_USER)
    expect(
      UserCreator.createNewUser.called,
      '命中已有用户时绝不能创建新用户'
    ).to.equal(false)
    expect(NEService.SmsLogin.firstCall.args[0]).to.equal('15810024047')
    expect(
      queries.some(q => JSON.stringify(q).includes('15810024047')),
      '必须用手机号去用户表查过，否则会误建新用户'
    ).to.equal(true)
  })

  it('用 account_id 命中时同样复用已有用户（不新建）', async function () {
    const queries = []
    stubFindOne({ byAccountId: EXISTING_USER, queries })
    NEService.SmsLogin.callsFake((mobile, code, cb) => cb(smsOk(10001)))

    const [, user] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '123456'
    )

    expect(user).to.equal(EXISTING_USER)
    expect(UserCreator.createNewUser.called).to.equal(false)
    expect(
      queries.some(
        q => isAccountIdQuery(q) && JSON.stringify(q).includes('10001')
      )
    ).to.equal(true)
  })

  it('标识查询条件含 carsiEmail 与遗留的 {account_id}@example.com 模式', async function () {
    const queries = []
    stubFindOne({ byIdentity: EXISTING_USER, queries })
    NEService.SmsLogin.callsFake((mobile, code, cb) => cb(smsOk(10001)))

    await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '123456'
    )

    const conds = JSON.stringify(queries.find(isIdentityQuery))
    expect(conds, '应包含 carsiEmail 匹配').to.include('carsiEmail')
    expect(conds, '应包含遗留 email 模式').to.include('10001@example.com')
    expect(conds, '应包含本次手机号').to.include('13800000000')
    expect(UserCreator.createNewUser.called).to.equal(false)
  })

  it('两个不同用户都命中时，优先有项目的那个（与密码登录同规则）', async function () {
    const userA = {
      _id: 'A',
      account_id: '10001',
      loginEpoch: 1,
      email: 'a@x.com',
    }
    const userB = {
      _id: 'B',
      carsiEmail: '13800000000',
      loginEpoch: 1,
      email: 'b@x.com',
    }
    stubFindOne({ byAccountId: userA, byIdentity: userB })
    stubProjectCounts({ A: 0, B: 3 })
    NEService.SmsLogin.callsFake((mobile, code, cb) => cb(smsOk(10001)))

    const [, user] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '123456'
    )

    expect(user._id).to.equal('B')
    expect(UserCreator.createNewUser.called).to.equal(false)
  })

  it('两个不同用户都有项目时，取 account_id 命中的那个', async function () {
    const userA = { _id: 'A', account_id: '10001', loginEpoch: 1 }
    const userB = { _id: 'B', carsiEmail: '13800000000', loginEpoch: 1 }
    stubFindOne({ byAccountId: userA, byIdentity: userB })
    stubProjectCounts({ A: 5, B: 2 })
    NEService.SmsLogin.callsFake((mobile, code, cb) => cb(smsOk(10001)))

    const [, user] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '123456'
    )

    expect(user._id).to.equal('A')
    expect(UserCreator.createNewUser.called).to.equal(false)
  })

  it('三种键全部未命中时才创建新用户，并带上标识', async function () {
    stubFindOne({})
    UserCreator.createNewUser.callsFake((attrs, opts, cb) =>
      cb(null, { _id: 'new-user-id', ...attrs })
    )
    NEService.SmsLogin.callsFake((mobile, code, cb) => cb(smsOk(99999, '新人')))

    const [, user] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13900000001',
      '123456'
    )

    expect(UserCreator.createNewUser.calledOnce).to.equal(true)
    expect(user._id).to.equal('new-user-id')
    const attrs = UserCreator.createNewUser.firstCall.args[0]
    expect(attrs.email).to.equal('13900000001')
    expect(attrs.carsiEmail).to.equal('13900000001')
    expect(attrs.account_id).to.equal('99999')
  })

  it('短信码错误时不触碰用户表，也不创建用户', async function () {
    NEService.SmsLogin.callsFake((mobile, code, cb) =>
      cb({ code: 500, msg: '验证码错误' })
    )

    const [err, user, info] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '000000'
    )

    expect(err).to.equal(null)
    expect(user).to.equal(false)
    expect(info.text).to.match(/验证码错误/)
    expect(User.findOne.called).to.equal(false)
    expect(UserCreator.createNewUser.called).to.equal(false)
  })

  it('缺少手机号或短信码时本地拒绝，不调用用户中心', async function () {
    const [err, user, info] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '',
      ''
    )

    expect(err).to.equal(null)
    expect(user).to.equal(false)
    expect(info.status).to.equal(401)
    expect(NEService.SmsLogin.called).to.equal(false)
  })

  it('密码与短信登录同一手机号都保留原用户 ID、邮箱和资源归属', async function () {
    const existing = {
      _id: 'resource-owner',
      account_id: '10001',
      email: 'old@example.com',
      carsiEmail: '13800000000',
      features: { compileTimeout: 120 },
    }
    const resources = [
      { owner_ref: existing._id, id: 'old-project' },
      { owner_ref: existing._id, id: 'old-asset' },
    ]
    stubFindOne({ byAccountId: existing, byIdentity: existing })
    NEService.NELogin.callsFake((identifier, password, captcha, cb) =>
      cb(smsOk(10001))
    )
    NEService.SmsLogin.callsFake((identifier, code, cb) => cb(smsOk(10001)))
    const [, passwordUser] = await callAsync(
      AuthenticationManager.authenticate.bind(AuthenticationManager),
      { email: '13800000000' },
      'unchanged'
    )
    const [, smsUser] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '123456'
    )
    expect(passwordUser._id).to.equal('resource-owner')
    expect(smsUser._id).to.equal(passwordUser._id)
    expect(smsUser.email).to.equal('old@example.com')
    expect(smsUser.features.compileTimeout).to.equal(120)
    expect(
      resources.every(resource => resource.owner_ref === smsUser._id)
    ).to.equal(true)
    expect(UserCreator.createNewUser.called).to.equal(false)
  })

  it('密码与短信冲突匹配都复用原有有项目账号，不新建或迁移项目', async function () {
    const empty = {
      _id: 'empty',
      account_id: '10001',
      email: 'empty@example.com',
    }
    const owner = {
      _id: 'original-owner',
      email: 'owner@example.com',
      carsiEmail: '13800000000',
    }
    stubFindOne({ byAccountId: empty, byIdentity: owner })
    stubProjectCounts({ empty: 0, 'original-owner': 3 })
    NEService.NELogin.callsFake((identifier, password, captcha, cb) =>
      cb(smsOk(10001))
    )
    NEService.SmsLogin.callsFake((identifier, code, cb) => cb(smsOk(10001)))
    const [, passwordUser] = await callAsync(
      AuthenticationManager.authenticate.bind(AuthenticationManager),
      { email: '13800000000' },
      'unchanged'
    )
    const [, smsUser] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '123456'
    )
    expect(passwordUser._id).to.equal('original-owner')
    expect(smsUser._id).to.equal('original-owner')
    expect(UserCreator.createNewUser.called).to.equal(false)
  })

  it('遗留占位邮箱账号在两种登录方式下均可找到，主邮箱不被手机号覆盖', async function () {
    const old = { _id: 'legacy-owner', email: '10001@example.com' }
    stubFindOne({ byIdentity: old })
    NEService.NELogin.callsFake((identifier, password, captcha, cb) =>
      cb(smsOk(10001))
    )
    NEService.SmsLogin.callsFake((identifier, code, cb) => cb(smsOk(10001)))
    const [, passwordUser] = await callAsync(
      AuthenticationManager.authenticate.bind(AuthenticationManager),
      { email: '13800000000' },
      'unchanged'
    )
    const [, smsUser] = await callAsync(
      AuthenticationManager.authenticateBySms.bind(AuthenticationManager),
      '13800000000',
      '123456'
    )
    expect(passwordUser._id).to.equal('legacy-owner')
    expect(smsUser._id).to.equal('legacy-owner')
    expect(smsUser.email).to.equal('10001@example.com')
    expect(UserCreator.createNewUser.called).to.equal(false)
  })
})
