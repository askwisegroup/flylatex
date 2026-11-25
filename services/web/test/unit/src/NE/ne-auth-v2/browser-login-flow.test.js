const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { JSDOM } = require('jsdom')
const {
  createPasswordConfig,
  decodeLoginPassword,
  ENCODING,
} = require('../../../../../commercial/ne-auth-v2/password-transport')

const WEB = path.resolve(__dirname, '../../../../..')
const config = {
  enabled: '1',
  provider: 'aliyun',
  region: 'cn',
  prefix: 'test',
  sceneId: 'test',
}
const tick = () => new Promise(resolve => setImmediate(resolve))

const HTML = `<!doctype html><html><head></head><body>
<div id="ne-login-i18n" data-ne-captcha-required="Required" data-ne-captcha-unavailable="Unavailable" data-ne-mobile-invalid="Invalid mobile" data-ne-sms-code-sent="Sent"></div>
<button type="button" data-ol-ne-tab="pw">Password</button><button type="button" data-ol-ne-tab="sms">SMS</button>
<form id="ne-login-form-pw" data-ol-async-form action="/login" method="POST">
<input name="email" value="old-user@example.com"><input data-ol-ne-password type="password" value="unchanged">
<input type="hidden" name="password"><input type="hidden" name="ne_password_encoding" value="ne-password-v1">
<div id="ne-password-status"></div>
<input type="hidden" name="captcha_verify_param" value=""><div data-ol-form-messages></div>
<div id="ne-captcha-slot"><div id="ne-captcha-holder"></div></div><div id="ne-captcha-status"></div>
<button type="submit" data-ol-disabled-inflight>Login</button></form>
<form id="ne-login-form-sms" data-ol-async-form action="/login/sms" method="POST" hidden>
<input name="mobile" value="13800000000"><input name="code" value="123456">
<div id="ne-captcha-slot-sms"></div><div id="ne-captcha-status-sms"></div>
<button type="button" id="ne-send-sms-code">Send</button><button type="submit">SMS login</button></form>
</body></html>`

function source(file) {
  return fs
    .readFileSync(path.join(WEB, file), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace(/^export /gm, '')
}

async function boot(options = {}) {
  const dom = new JSDOM(HTML, {
    url: 'https://test.invalid/login',
    runScripts: 'outside-only',
  })
  const win = dom.window
  const session = {
    save(callback) {
      callback()
    },
  }
  const passwordEncryption = await createPasswordConfig(session)
  Object.defineProperty(win, 'crypto', {
    value: options.noCrypto ? {} : options.crypto || crypto.webcrypto,
  })
  win.TextEncoder = TextEncoder
  const calls = []
  const instances = []
  const timers = []
  let clock = 100000
  const realTimeout = win.setTimeout.bind(win)
  win.Date.now = () => clock
  win.setTimeout = (callback, delay) => {
    if (delay === 60000) {
      timers.push(callback)
      return -timers.length
    }
    return realTimeout(callback, delay)
  }
  win.getJSON = async () => ({
    captcha: options.config || config,
    passwordEncryption,
  })
  win.postJSON = async (url, request) => {
    calls.push({ url, body: { ...request.body } })
    if (options.response) return options.response(url, request)
    return url === '/ne/sendcode'
      ? { code: 0 }
      : { message: { type: 'error', text: 'Wrong password' } }
  }
  win.debugConsole = { error() {} }
  win.FetchError = class FetchError extends Error {}
  win.inputValidator = () => {}
  win.classNames = name => name
  win.disableElement = element => {
    element.disabled = true
  }
  win.enableElement = element => {
    element.disabled = false
  }
  const append = win.document.head.appendChild.bind(win.document.head)
  win.document.head.appendChild = element => {
    append(element)
    if (element.tagName === 'SCRIPT')
      Promise.resolve().then(() => element.dispatchEvent(new win.Event('load')))
    return element
  }
  win.initAliyunCaptcha = value => {
    instances.push(value)
    value.getInstance({ destroy() {} })
    return Promise.resolve()
  }
  win.eval(source('commercial/ne-auth-v2/browser/captcha.js'))
  win.eval(source('commercial/ne-auth-v2/browser/password.js'))
  const bind = win.NeAuthPassword.bindForm
  win.NeAuthPassword.bindForm = (form, settings) =>
    bind(form, {
      ...settings,
      onStatus(status) {
        win.__passwordStatus = status.state
        settings.onStatus(status)
      },
    })
  if (!options.libraryOnly) {
    win.eval(source('frontend/js/features/form-helpers/hydrate-form.js'))
    win.eval(source('frontend/js/features/ne-login-captcha.js'))
  }
  if (!options.libraryOnly) {
    await waitFor(() => ['ready', 'unavailable'].includes(win.__passwordStatus))
  }
  await tick()
  return {
    dom,
    win,
    calls,
    instances,
    timers,
    session,
    advance: milliseconds => {
      clock += milliseconds
    },
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Browser login did not settle')
}

describe('ne-auth-v2/browser real form events', function () {
  let browser
  afterEach(function () {
    if (browser) browser.dom.window.close()
  })
  it('serializes the verified result before reset, then requires a new result after failure', async function () {
    browser = await boot()
    const { win, instances, calls } = browser
    const form = win.document.getElementById('ne-login-form-pw')
    instances[0].success('FIRST_RESULT')
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await waitFor(() => calls.length === 1)
    await tick()
    expect(calls[0].body.captcha_verify_param).to.equal('FIRST_RESULT')
    expect(calls[0].body.email).to.equal('old-user@example.com')
    expect(calls[0].body.password).to.not.equal('unchanged')
    expect(calls[0].body.ne_password_encoding).to.equal(ENCODING)
    expect(
      decodeLoginPassword(calls[0].body.password, browser.session, ENCODING)
    ).to.equal('unchanged')
    expect(
      form.querySelector('input[name="captcha_verify_param"]').value
    ).to.equal('')
    expect(form.querySelector('button[type="submit"]').disabled).to.equal(true)
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await tick()
    expect(calls).to.have.length(1)
    instances[instances.length - 1].success('SECOND_RESULT')
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await waitFor(() => calls.length === 2)
    expect(calls[1].body.captcha_verify_param).to.equal('SECOND_RESULT')
  })
  it('blocks duplicate submits while the original request is still pending', async function () {
    let finish
    browser = await boot({
      response: () =>
        new Promise(resolve => {
          finish = resolve
        }),
    })
    const { win, instances, calls } = browser
    const form = win.document.getElementById('ne-login-form-pw')
    instances[0].success('VALID')
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await waitFor(() => browser.calls.length === 1)
    await tick()
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await tick()
    expect(calls).to.have.length(1)
    finish({ message: { type: 'error', text: 'Retry' } })
    await tick()
    expect(form.querySelector('button[type="submit"]').disabled).to.equal(true)
  })
  it('never posts plaintext or breaks SMS tab switching when encryption is unavailable', async function () {
    browser = await boot({ config: { enabled: '0' }, noCrypto: true })
    const { win, calls } = browser
    const form = win.document.getElementById('ne-login-form-pw')
    expect(new win.FormData(form).get('password')).to.equal('')
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await tick()
    expect(calls).to.have.length(0)
    win.document.querySelector('[data-ol-ne-tab="sms"]').click()
    win.document.getElementById('ne-send-sms-code').click()
    await tick()
    expect(calls[0].url).to.equal('/ne/sendcode')
    expect(browser.instances).to.have.length(0)
  })
  it('cancels encryption after a tab switch without locking the next password attempt', async function () {
    let release
    const gate = new Promise(resolve => {
      release = resolve
    })
    const api = crypto.webcrypto.subtle
    browser = await boot({
      crypto: {
        getRandomValues: value => crypto.webcrypto.getRandomValues(value),
        subtle: {
          importKey: api.importKey.bind(api),
          encrypt: api.encrypt.bind(api),
          exportKey: api.exportKey.bind(api),
          generateKey: (...args) => gate.then(() => api.generateKey(...args)),
        },
      },
    })
    const { win, calls, instances } = browser
    const form = win.document.getElementById('ne-login-form-pw')
    instances[0].success('FIRST_RESULT')
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    win.document.querySelector('[data-ol-ne-tab="sms"]').click()
    release()
    await waitFor(
      () =>
        form.querySelector('input[name="password"]').value === '' &&
        win.__passwordStatus === 'ready'
    )
    expect(calls).to.have.length(0)
    win.document.querySelector('[data-ol-ne-tab="pw"]').click()
    await tick()
    instances[instances.length - 1].success('SECOND_RESULT')
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await waitFor(() => calls.length === 1)
    expect(calls[0].body.captcha_verify_param).to.equal('SECOND_RESULT')
  })
  it('keeps the request body empty when native encryption fails after configuration loads', async function () {
    const api = crypto.webcrypto.subtle
    browser = await boot({
      config: { enabled: '0' },
      crypto: {
        getRandomValues: value => crypto.webcrypto.getRandomValues(value),
        subtle: {
          importKey: api.importKey.bind(api),
          generateKey: () =>
            Promise.reject(new Error('native encryption failed')),
        },
      },
    })
    const { win, calls } = browser
    const form = win.document.getElementById('ne-login-form-pw')
    form.dispatchEvent(
      new win.Event('submit', { bubbles: true, cancelable: true })
    )
    await waitFor(() => win.__passwordStatus === 'unavailable')
    expect(calls).to.have.length(0)
    expect(new win.FormData(form).get('password')).to.equal('')
  })
  it('keeps captcha-disabled login compatible with form retries', async function () {
    browser = await boot({ config: { enabled: '0' } })
    const form = browser.win.document.getElementById('ne-login-form-pw')
    form.dispatchEvent(
      new browser.win.Event('submit', { bubbles: true, cancelable: true })
    )
    await waitFor(() => browser.calls.length === 1)
    await tick()
    expect(browser.calls[0].body.captcha_verify_param).to.equal('')
    expect(form.querySelector('button[type="submit"]').disabled).to.equal(false)
  })
  it('enforces one SMS send during cooldown across captcha callbacks and tab switches', async function () {
    browser = await boot()
    const { win, instances, calls } = browser
    win.document.querySelector('[data-ol-ne-tab="sms"]').click()
    await tick()
    instances[instances.length - 1].success('SMS_RESULT')
    await tick()
    instances[instances.length - 1].success('ANOTHER_RESULT')
    await tick()
    expect(calls.filter(call => call.url === '/ne/sendcode')).to.have.length(1)
    win.document.querySelector('[data-ol-ne-tab="pw"]').click()
    win.document.querySelector('[data-ol-ne-tab="sms"]').click()
    await tick()
    expect(win.document.getElementById('ne-send-sms-code').disabled).to.equal(
      true
    )
    browser.advance(60000)
    browser.timers[0]()
    win.document.querySelector('[data-ol-ne-tab="pw"]').click()
    win.document.querySelector('[data-ol-ne-tab="sms"]').click()
    expect(win.document.getElementById('ne-send-sms-code').disabled).to.equal(
      false
    )
  })
  it('ignores the old mount callback after switching login methods', async function () {
    browser = await boot()
    const { win, instances, calls } = browser
    const password = instances[0]
    win.document.querySelector('[data-ol-ne-tab="sms"]').click()
    await tick()
    password.success('STALE_PASSWORD_RESULT')
    await tick()
    expect(calls).to.have.length(0)
    expect(
      win.document
        .getElementById('ne-login-form-pw')
        .querySelector('input[name="captcha_verify_param"]').value
    ).to.equal('')
  })
  it('only initializes the latest target when tab mounts race during script loading', async function () {
    browser = await boot({ libraryOnly: true })
    const { win, instances } = browser
    let loaded
    const loading = new Promise(resolve => {
      loaded = resolve
    })
    const controller = win.NeAuthCaptcha.createController({
      holderId: 'ne-captcha-holder',
      loadScript: () => loading,
    })
    controller.applyConfig(config)
    let password = 0
    let sms = 0
    const a = controller.mount('ne-captcha-slot', {
      purpose: 'pw',
      onSuccess: () => {
        password++
      },
    })
    const b = controller.mount('ne-captcha-slot-sms', {
      purpose: 'sms',
      onSuccess: () => {
        sms++
      },
    })
    loaded()
    await Promise.all([a, b])
    expect(instances).to.have.length(1)
    instances[0].success('NEW_TARGET_RESULT')
    expect(password).to.equal(0)
    expect(sms).to.equal(1)
  })
  it('can retry script loading after a failure', async function () {
    browser = await boot({ libraryOnly: true })
    let loads = 0
    const controller = browser.win.NeAuthCaptcha.createController({
      holderId: 'ne-captcha-holder',
      loadScript: async () => {
        if (++loads === 1) throw new Error('offline')
      },
    })
    controller.applyConfig(config)
    await controller.mount('ne-captcha-slot')
    expect(controller.getStatus()).to.equal('unavailable')
    await controller.mount('ne-captcha-slot')
    expect(loads).to.equal(2)
    expect(controller.getStatus()).to.equal('pending')
    expect(browser.instances).to.have.length(1)
  })
})
