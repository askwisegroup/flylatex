const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const webpack = require('webpack')
const babel = require('@babel/core')
const { JSDOM } = require('jsdom')
const crypto = require('crypto')
const pug = require('pug')
const {
  createPasswordConfig,
  decodeLoginPassword,
  ENCODING,
} = require('../../../../commercial/ne-auth-v2/password-transport')

const WEB = path.resolve(__dirname, '../../../..')
const SDK = path.join(WEB, 'commercial/ne-auth-v2/browser/captcha.js')
const PASSWORD_SDK = path.join(
  WEB,
  'commercial/ne-auth-v2/browser/password.js'
)
const BABEL = path.join(WEB, 'babel.config.json')
const HTML = `<!doctype html><html><head></head><body>
<div id="ne-login-i18n"></div>
<button type="button" data-ol-ne-tab="pw">Password</button>
<button type="button" data-ol-ne-tab="sms">SMS</button>
<form id="ne-login-form-pw" data-ol-async-form action="/login" method="POST">
<input name="email" value="old-user@example.com"><input data-ol-ne-password type="password" value="fixture-password">
<input type="hidden" name="password"><input type="hidden" name="ne_password_encoding" value="ne-password-v1">
<div data-ol-form-messages></div><div id="ne-password-status"></div>
<input name="captcha_verify_param" type="hidden">
<div id="ne-captcha-slot"><div id="ne-captcha-holder"></div></div>
<div id="ne-captcha-status"></div><button type="submit" data-ol-disabled-inflight>Login</button></form>
<form id="ne-login-form-sms" hidden><input name="mobile" value="13800000000">
<div id="ne-captcha-slot-sms"></div><div id="ne-captcha-status-sms"></div>
<button id="ne-send-sms-code" type="button">Send</button><button type="submit">Login</button></form>
</body></html>`

describe('NE login production Babel/Webpack integration', function () {
  this.timeout(20000)
  let directory
  let bundle
  let session
  let passwordEncryption
  let loginHtml
  before(async function () {
    session = {
      save(callback) {
        callback()
      },
    }
    passwordEncryption = await createPasswordConfig(session)
    const loginPug = path.join(WEB, 'app/views/user/login.pug')
    // Render the real login content with the layout's form-message mixin.
    loginHtml = pug.render(
      'mixin formMessages()\n  div(data-ol-form-messages)\n' +
        fs.readFileSync(loginPug, 'utf8').replace(/^extends .*\n/, ''),
      { filename: loginPug, translate: key => key, csrfToken: 'fixture-csrf' }
    )
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-login-bundle-'))
    const entry = path.join(directory, 'entry.mjs')
    const fetch = path.join(directory, 'fetch.mjs')
    const debug = path.join(directory, 'debug.mjs')
    const captcha = path.join(directory, 'captcha.mjs')
    const input = path.join(directory, 'input.mjs')
    const names = path.join(directory, 'names.mjs')
    fs.writeFileSync(
      entry,
      `import SDK from ${JSON.stringify(SDK)};
window.__sdk = SDK;
import Password from ${JSON.stringify(PASSWORD_SDK)};
window.__passwordSdk = Password;
import ${JSON.stringify(
        path.join(WEB, 'frontend/js/features/form-helpers/hydrate-form.js')
      )};
import ${JSON.stringify(
        path.join(WEB, 'frontend/js/features/ne-login-captcha.js')
      )};`
    )
    fs.writeFileSync(
      fetch,
      `export function getJSON(url) {
window.__requests.push(url);
return Promise.resolve(window.__config);
}
export class FetchError extends Error { getUserFacingMessage() { return this.message; } }
export function postJSON(url, options) {
window.__posts.push({url, body:options.body});
if (url === '/login') return Promise.reject(new FetchError('Wrong password'));
return Promise.resolve({code:0});
}`
    )
    fs.writeFileSync(
      captcha,
      'export const canSkipCaptcha = async () => true; export const validateCaptchaV2 = async () => "";'
    )
    fs.writeFileSync(input, 'export default function inputValidator() {}')
    fs.writeFileSync(
      names,
      'export default function classNames(name) { return name; }'
    )
    fs.writeFileSync(
      debug,
      'export const debugConsole = {error(error) { window.__errors.push(String(error)); }};'
    )
    const modules = path.dirname(
      path.dirname(require.resolve('core-js/package.json'))
    )
    const loaderModules = path.dirname(
      path.dirname(require.resolve('babel-loader/package.json'))
    )
    const stats = await new Promise((resolve, reject) => {
      webpack(
        {
          mode: 'production',
          context: WEB,
          target: 'web',
          entry,
          output: { path: directory, filename: 'bundle.js' },
          resolve: {
            modules: [modules, 'node_modules'],
            alias: {
              '../infrastructure/fetch-json$': fetch,
              '../../infrastructure/fetch-json$': fetch,
              '@/utils/debugging$': debug,
              './captcha$': captcha,
              './input-validator$': input,
              classnames$: names,
            },
          },
          resolveLoader: { modules: [loaderModules, 'node_modules'] },
          module: {
            rules: [
              {
                test: /\.([jt]sx?|[cm]js)$/,
                exclude: /node_modules/,
                type: 'javascript/auto',
                use: [
                  { loader: 'babel-loader', options: { configFile: BABEL } },
                ],
              },
            ],
          },
        },
        (error, result) => (error ? reject(error) : resolve(result))
      )
    })
    assert.equal(
      stats.hasErrors(),
      false,
      stats.toString({ all: false, errors: true })
    )
    assert.equal(
      stats.hasWarnings(),
      false,
      stats.toString({ all: false, warnings: true })
    )
    bundle = fs.readFileSync(path.join(directory, 'bundle.js'), 'utf8')
  })
  after(function () {
    fs.rmSync(directory, { recursive: true, force: true })
  })
  it('keeps usage polyfills in CommonJS so the UMD SDK has a default export', function () {
    for (const sdk of [SDK, PASSWORD_SDK]) {
      const result = babel.transformFileSync(sdk, {
        configFile: BABEL,
        caller: {
          name: 'babel-loader',
          supportsStaticESM: true,
          supportsDynamicImport: true,
          supportsTopLevelAwait: true,
        },
      }).code
      assert.equal(/^import /m.test(result), false)
    }
  })
  it('boots the minified login module and allows switching to SMS', async function () {
    const dom = new JSDOM(HTML, {
      url: 'https://test.invalid/login',
      runScripts: 'outside-only',
    })
    try {
      const win = dom.window
      win.__errors = []
      win.__requests = []
      win.__posts = []
      win.__config = { captcha: { enabled: '0' }, passwordEncryption }
      Object.defineProperty(win, 'crypto', { value: crypto.webcrypto })
      win.TextEncoder = TextEncoder
      win.eval(bundle)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(typeof win.__sdk.createController, 'function')
      assert.equal(typeof win.__passwordSdk.bindForm, 'function')
      assert.deepEqual(win.__errors, [])
      // FIXED: 2026-11-20 配置请求带时间戳，绕过中间层缓存（路径不变）
      assert.equal(win.__requests.length, 1)
      assert.match(win.__requests[0], /^\/ne\/captcha-config\?_=\d+$/)
      win.document.querySelector('[data-ol-ne-tab="sms"]').click()
      assert.equal(win.document.getElementById('ne-login-form-pw').hidden, true)
      assert.equal(
        win.document.getElementById('ne-login-form-sms').hidden,
        false
      )
    } finally {
      dom.window.close()
    }
  })
  it('encrypts real FormData in the minified bundle and retries a failed login with fresh ciphertext', async function () {
    const dom = new JSDOM(loginHtml, {
      url: 'https://test.invalid/login',
      runScripts: 'outside-only',
    })
    try {
      const win = dom.window
      win.__errors = []
      win.__requests = []
      win.__posts = []
      win.__config = { captcha: { enabled: '0' }, passwordEncryption }
      Object.defineProperty(win, 'crypto', { value: crypto.webcrypto })
      win.TextEncoder = TextEncoder
      win.document.querySelector('[data-ol-ne-password]').value =
        'fixture-password'
      win.document.querySelector('input[name="email"]').value =
        'old-user@example.com'
      win.eval(bundle)
      const form = win.document.getElementById('ne-login-form-pw')
      const button = form.querySelector('button[type="submit"]')
      await waitFor(() => !button.disabled)
      assert.equal(new win.FormData(form).get('password'), '')
      assert.equal(
        form.querySelector('[data-ol-ne-password]').hasAttribute('name'),
        false
      )
      for (let attempt = 0; attempt < 2; attempt++) {
        form.dispatchEvent(
          new win.Event('submit', { bubbles: true, cancelable: true })
        )
        await waitFor(
          () => win.__posts.length === attempt + 1 && !button.disabled
        )
        const body = win.__posts[attempt].body
        assert.equal(body.email, 'old-user@example.com')
        assert.equal(body.ne_password_encoding, ENCODING)
        assert.notEqual(body.password, 'fixture-password')
        assert.equal(
          decodeLoginPassword(body.password, session, ENCODING),
          'fixture-password'
        )
        assert.equal(form.querySelector('input[name="password"]').value, '')
      }
      assert.notEqual(
        win.__posts[0].body.password,
        win.__posts[1].body.password
      )
      assert.deepEqual(win.__errors, [])
    } finally {
      dom.window.close()
    }
  })
})

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Minified login did not settle')
}
