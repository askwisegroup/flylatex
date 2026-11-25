const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { JSDOM } = require('jsdom')
const {
  createPasswordConfig,
  decodeLoginPassword,
  ENCODING,
} = require('../../../../../commercial/ne-auth-v2/password-transport')
const transport = require('../../../../../commercial/ne-auth-v2/password-transport')
const {
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2/errors')

const WEB = path.resolve(__dirname, '../../../../..')

function newSession() {
  return {
    save(callback) {
      callback()
    },
  }
}

function loadController(authenticate) {
  const filename = path.join(
    WEB,
    'app/src/Features/Authentication/AuthenticationController.js'
  )
  const module = { exports: {} }
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module,
      console: { log() {} },
      require(name) {
        if (name === './AuthenticationManager') return { authenticate }
        if (name === '../../infrastructure/Modules') {
          return {
            hooks: {
              fire(name, req, email, callback) {
                callback(null, [])
              },
            },
          }
        }
        if (name === '../Security/LoginRateLimiter') {
          return {
            processLoginRequest(email, callback) {
              callback(null, true)
            },
          }
        }
        if (name.endsWith('/password-transport')) {
          return { decodeLoginPassword }
        }
        return {}
      },
    },
    { filename }
  )
  return module.exports
}

describe('ne-auth-v2/browser password transport', function () {
  this.timeout(15000)
  let dom
  let session
  let config
  let browser

  beforeEach(async function () {
    session = newSession()
    config = await createPasswordConfig(session)
    dom = new JSDOM('', {
      url: 'https://test.invalid/login',
      runScripts: 'outside-only',
    })
    Object.defineProperty(dom.window, 'crypto', { value: crypto.webcrypto })
    dom.window.TextEncoder = TextEncoder
    dom.window.eval(
      fs.readFileSync(
        path.join(WEB, 'commercial/ne-auth-v2/browser/password.js'),
        'utf8'
      )
    )
    browser = dom.window.NeAuthPassword
  })
  afterEach(function () {
    dom.window.close()
  })

  it('returns only a public key after persisting the private key in the server session', async function () {
    let persisted
    const state = {
      save(callback) {
        persisted = JSON.parse(JSON.stringify(this))
        callback()
      },
    }
    const publicConfig = await createPasswordConfig(state)
    assert.ok(publicConfig.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'))
    assert.equal(JSON.stringify(publicConfig).includes('PRIVATE KEY'), false)
    assert.ok(persisted.nePasswordTransport.privateKey.includes('PRIVATE KEY'))
    const restored = { ...persisted, save: state.save }
    assert.deepEqual(await createPasswordConfig(restored), publicConfig)
    const encrypted = await browser.encryptPassword(
      'fixture-password',
      publicConfig
    )
    assert.equal(
      decodeLoginPassword(encrypted, restored, ENCODING),
      'fixture-password'
    )
  })

  it('round-trips UTF-8, whitespace and passwords longer than a direct RSA block', async function () {
    const password = `  ${'密码😀'.repeat(60)}  `
    const encrypted = await browser.encryptPassword(password, config)
    assert.ok(encrypted.startsWith('nepw1.'))
    assert.equal(encrypted.includes(password), false)
    assert.equal(decodeLoginPassword(encrypted, session, ENCODING), password)
  })

  it('generates different ciphertext for each retry of the same password', async function () {
    const a = await browser.encryptPassword('fixture-password', config)
    const b = await browser.encryptPassword('fixture-password', config)
    assert.notEqual(a, b)
    assert.equal(decodeLoginPassword(b, session, ENCODING), 'fixture-password')
  })

  it('rejects tampering, expired keys and unsupported encoding', async function () {
    const encrypted = await browser.encryptPassword('fixture-password', config)
    const parts = encrypted.split('.')
    const ciphertext = Buffer.from(parts[4], 'base64')
    ciphertext[0] ^= 1
    parts[4] = ciphertext.toString('base64')
    assert.throws(
      () => decodeLoginPassword(parts.join('.'), session, ENCODING),
      NeAuthError
    )
    assert.throws(
      () => decodeLoginPassword(encrypted, session, 'unknown'),
      NeAuthError
    )
    const expired = await createPasswordConfig(newSession())
    transport.clearKeyCache()
    session.nePasswordTransport.expiresAt = Date.now() - 1
    const expiredCiphertext = await browser.encryptPassword(
      'fixture-password',
      expired
    )
    assert.throws(
      () => decodeLoginPassword(expiredCiphertext, session, ENCODING),
      NeAuthError
    )
  })

  // FIXED: 2026-11-20 这条以前是「换个 session 就必须失败」。现在看来正是这个
  // 设计让 2026-11-19 的 cookie 事故把用户锁死（页面加载与提交落在不同 session）。
  // 私钥按 keyId 存在进程内，session 只是兜底，所以换 session / 没有 session
  // 都必须还能解开。
  it('keeps decrypting when the browser session is lost or replaced', async function () {
    const encrypted = await browser.encryptPassword('fixture-password', config)
    const other = newSession()
    await createPasswordConfig(other)
    assert.equal(decodeLoginPassword(encrypted, other, ENCODING), 'fixture-password')
    assert.equal(
      decodeLoginPassword(encrypted, undefined, ENCODING),
      'fixture-password'
    )
  })

  it('rejects a key id it never issued', async function () {
    const encrypted = await browser.encryptPassword('fixture-password', config)
    const parts = encrypted.split('.')
    parts[1] = 'f'.repeat(32)
    assert.throws(
      () => decodeLoginPassword(parts.join('.'), session, ENCODING),
      NeAuthError
    )
  })

  it('keeps old clients with no encoding flag unchanged', function () {
    assert.equal(
      decodeLoginPassword('legacy-password', undefined, undefined),
      'legacy-password'
    )
  })

  // FIXED: 2026-11-20 session 存不下也照样能登录：私钥已进进程内缓存。
  // 旧的「存不下就报配置不可用」会把用户彻底挡在登录页外。
  it('keeps issuing usable keys when the session cannot be persisted', async function () {
    const withoutSession = await createPasswordConfig(undefined)
    assert.ok(withoutSession.publicKey.includes('-----BEGIN PUBLIC KEY-----'))
    const failedSession = {
      save(callback) {
        callback(new Error('redis unavailable'))
      },
    }
    const fromFailed = await createPasswordConfig(failedSession)
    assert.equal(failedSession.nePasswordTransport, undefined)
    const encrypted = await browser.encryptPassword('fixture-password', fromFailed)
    assert.equal(
      decodeLoginPassword(encrypted, newSession(), ENCODING),
      'fixture-password'
    )
  })

  it('passes the original password, identifier and captcha to the actual authentication controller', async function () {
    const password = 'original-password'
    const encrypted = await browser.encryptPassword(password, config)
    let received
    const controller = loadController((query, plain, audit, callback) => {
      received = { query, plain, audit }
      callback(null, false, { status: 401, text: 'fixture' })
    })
    const request = {
      session,
      headers: {},
      ip: '127.0.0.1',
      body: {
        password: encrypted,
        ne_password_encoding: ENCODING,
        captcha_verify_param: 'VALID',
      },
    }
    controller.doPassportLogin(
      request,
      'OLD-USER@example.com',
      encrypted,
      () => {}
    )
    assert.equal(received.query.email, 'old-user@example.com')
    assert.equal(received.plain, password)
    assert.equal(received.query.captchaVerifyParam, 'VALID')
    assert.equal(request.body.password, encrypted)
  })

  it('rejects malformed encrypted input before invoking authentication', function () {
    let calls = 0
    const controller = loadController(() => {
      calls++
    })
    let result
    controller.doPassportLogin(
      { session, body: { ne_password_encoding: ENCODING } },
      'old-user@example.com',
      'malformed',
      (error, user, info) => {
        result = info
      }
    )
    assert.equal(calls, 0)
    assert.equal(result.status, 400)
    assert.ok(result.text.includes('刷新'))
  })
})
