const { expect } = require('chai')
const path = require('path')
const Module = require('module')

/**
 * 集成测试：**真实加载** commercial/index.js，验证「止血」改造后的登录入口。
 *
 * index.js 会牵出 mongoose / redis / node-jsencrypt 等重依赖（本项目单测环境未安装），
 * 因此对它们的**模块加载**做最小桩替换；被测的 login() 编排逻辑是真实代码。
 * 注意：测试全程只访问本地 mock，绝不请求真实用户中心。
 */

const NE_LOGIN_DIR = path.resolve(__dirname, '../../../../../commercial')
const INDEX = path.join(NE_LOGIN_DIR, 'index.js')

const { startMockNe } = require('./fixtures/mock-ne-server')

const settingsStub = { ne: {} }
const tokenCacheStub = {
  calls: { setBySession: [], setByEmail: [], setV2Tokens: [] },
  setV2Tokens(...args) {
    this.calls.setV2Tokens.push(args)
    return Promise.resolve()
  },
  setBySession(...args) {
    this.calls.setBySession.push(args)
    return Promise.resolve()
  },
  setByEmail(...args) {
    this.calls.setByEmail.push(args)
    return Promise.resolve()
  },
}

const STUBS = {
  '@overleaf/settings': settingsStub,
  '@overleaf/promise-utils': { expressify: fn => fn },
  [path.join(NE_LOGIN_DIR, 'utils.js')]: {
    encrypt: () => 'LEGACY_CIPHER',
    PUBLIC_KEY: 'x',
  },
  [path.join(NE_LOGIN_DIR, 'tokenCache.js')]: tokenCacheStub,
  [path.join(NE_LOGIN_DIR, 'ai-agent.js')]: {
    aiChatService: () => {},
    AI_SYSTEM_PROMPTS: {},
  },
  [path.join(NE_LOGIN_DIR, 'ai-config.js')]: {},
  [path.resolve(NE_LOGIN_DIR, '../app/src/infrastructure/Mongoose.js')]: {
    model: () => ({}),
  },
  [path.resolve(NE_LOGIN_DIR, '../app/src/models/User.js')]: { UserSchema: {} },
  [path.resolve(NE_LOGIN_DIR, '../app/src/models/Project.js')]: {
    ProjectSchema: {},
  },
}

const origRequire = Module.prototype.require

function loadNeservice() {
  Module.prototype.require = function (request) {
    let resolved = null
    try {
      resolved = Module._resolveFilename(request, this)
    } catch (e) {
      /* 解析失败则交回原始实现 */
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
    delete require.cache[INDEX]
    return require(INDEX)
  } finally {
    Module.prototype.require = origRequire
  }
}

/** 指向本地 mock 并重新加载被测模块 */
function bootWith(mock) {
  settingsStub.ne = {
    authV2: true,
    baseUrl: mock.baseUrl,
    clientId: 'flylatex',
    clientSecret: '',
    redirectUri: 'https://www.example.com/ne-auth-callback',
  }
  tokenCacheStub.calls.setBySession.length = 0
  tokenCacheStub.calls.setByEmail.length = 0
  tokenCacheStub.calls.setV2Tokens.length = 0
  return loadNeservice()
}

/** 把回调式 login 包成 Promise（支持 3 参 / 4 参两种签名） */
function loginAsync(NEService, target, password, captchaVerifyParam) {
  return new Promise(resolve => {
    if (captchaVerifyParam === undefined) {
      NEService.NELogin(target, password, resolve)
    } else {
      NEService.NELogin(target, password, captchaVerifyParam, resolve)
    }
  })
}

describe('ne-auth-v2/集成：commercial 登录入口', function () {
  this.timeout(20000)

  beforeEach(function () {
    tokenCacheStub.calls.setBySession.length = 0
    tokenCacheStub.calls.setByEmail.length = 0
    tokenCacheStub.calls.setV2Tokens.length = 0
  })

  describe('未启用验证码（enabled="0"）—— 向后兼容旧调用', function () {
    let mock
    let NEService

    before(async function () {
      mock = await startMockNe({ captchaEnabled: false })
      NEService = bootWith(mock)
    })
    after(async function () {
      await mock.close()
    })

    it('导出 NELogin / NELoginV2 / NELoginLegacy 且入口已切换', function () {
      expect(NEService.NELogin).to.be.a('function')
      expect(NEService.NELoginV2).to.be.a('function')
      expect(NEService.NELoginLegacy).to.be.a('function')
      // 关键：入口不再是老的 V1 实现
      expect(NEService.NELogin).to.not.equal(NEService.NELoginLegacy)
    })

    it('旧签名 (email, password, cb) 直接可用，回调字段与历史契约一致', async function () {
      const r = await loginAsync(NEService, 'demo@example.com', 'Passw0rd!')

      expect(r.code).to.equal(0)
      expect(r.msg).to.equal('success')

      // AuthenticationManager 实际读取的字段
      expect(r.account_id).to.equal(10001)
      expect(r.email).to.equal('demo@example.com')
      expect(r.nick_name).to.equal('MOCK')
      expect(r.login_id).to.equal('demo@example.com')
      for (const f of ['name', 'type_txt', 'icon_url', 'inst_name', 'mobile']) {
        expect(r, f).to.have.property(f)
      }

      // 新增的 V2 令牌字段（不破坏既有语义）
      expect(r.token).to.match(/^a2\./)
      expect(r.accessToken).to.equal(r.token)
      expect(r.refreshToken).to.match(/^r2\./)
      expect(r.tokenType).to.equal('Bearer')
      expect(r.expiresIn).to.equal(900)
    })

    it('登录成功后保存完整令牌对与原标识，不再写入24小时的旧访问令牌缓存', async function () {
      await loginAsync(NEService, 'demo@example.com', 'Passw0rd!')
      expect(tokenCacheStub.calls.setV2Tokens).to.have.length(1)
      const [, tokens, identifier, profile] =
        tokenCacheStub.calls.setV2Tokens[0]
      expect(tokens.accessToken).to.match(/^a2\./)
      expect(tokens.refreshToken).to.match(/^r2\./)
      expect(tokens.expiresIn).to.equal(900)
      expect(identifier).to.equal('demo@example.com')
      expect(profile.account_id).to.equal(10001)
      expect(tokenCacheStub.calls.setBySession).to.have.length(0)
      expect(tokenCacheStub.calls.setByEmail).to.have.length(0)
    })

    it('配置接口返回关闭开关与本站公开加密配置，保存私钥但不返回它', async function () {
      let saved
      let data
      const headers = {}
      const session = {
        save(callback) {
          saved = JSON.parse(JSON.stringify(this))
          callback()
        },
      }
      await NEService.GetCaptchaConfig(
        { session },
        {
          setHeader(name, value) {
            headers[name] = value
          },
          json(value) {
            data = value
          },
        }
      )
      expect(data.captcha.enabled).to.equal('0')
      expect(data.passwordEncryption.encoding).to.equal('ne-password-v1')
      expect(data.passwordEncryption.publicKey).to.include('BEGIN PUBLIC KEY')
      expect(JSON.stringify(data)).to.not.include('PRIVATE KEY')
      expect(saved.nePasswordTransport.privateKey).to.include('PRIVATE KEY')
      expect(headers['Cache-Control']).to.equal('no-store')
    })

    it('密码错误 -> {code:500, msg:NE 原文}', async function () {
      const r = await loginAsync(NEService, 'demo@example.com', 'WRONG')
      expect(r.code).to.equal(500)
      expect(r.msg).to.match(/密码错误/)
    })

    it('认证失败时不会写入 tokenCache', async function () {
      await loginAsync(NEService, 'demo@example.com', 'WRONG')
      expect(tokenCacheStub.calls.setByEmail).to.have.length(0)
      expect(tokenCacheStub.calls.setV2Tokens).to.have.length(0)
    })

    it('用户中心不可达 -> 归一化为 network 文案，不抛异常', async function () {
      const offline = bootWith({ baseUrl: 'http://127.0.0.1:1' })
      const r = await loginAsync(offline, 'demo@example.com', 'Passw0rd!')
      expect(r.code).to.equal(500)
      expect(r.msg).to.match(/网络|用户中心/)
      NEService = bootWith(mock) // 还原
    })
  })

  describe('启用验证码（enabled="1"）—— 新签名可用', function () {
    let mock
    let NEService

    before(async function () {
      mock = await startMockNe({ captchaEnabled: true })
      NEService = bootWith(mock)
    })
    after(async function () {
      await mock.close()
    })

    it('(email, password, captchaVerifyParam, cb) 验证码通过后登录成功', async function () {
      const r = await loginAsync(
        NEService,
        'demo@example.com',
        'Passw0rd!',
        mock.validCaptchaParam
      )
      expect(r.code).to.equal(0)
      expect(r.token).to.match(/^a2\./)
    })

    // 说明：启用验证码而缺参时，NE 返回 1000「参数错误」，没有更细的原因码；
    // 因此前端必须在验证码通过前禁用提交（见阶段 3），使该分支在真实使用中不可达。
    it('旧三参签名在启用验证码时不会崩，返回 {code:500, msg}', async function () {
      const r = await loginAsync(NEService, 'demo@example.com', 'Passw0rd!')
      expect(r.code).to.equal(500)
      expect(r.msg).to.be.a('string')
      expect(r.msg.length).to.be.greaterThan(0)
    })

    it('验证码错误 -> 映射为可操作提示', async function () {
      const r = await loginAsync(
        NEService,
        'demo@example.com',
        'Passw0rd!',
        'FAKE'
      )
      expect(r.code).to.equal(500)
      expect(r.msg).to.match(/验证码/)
    })
  })
})
