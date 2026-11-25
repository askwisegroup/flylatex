const assert = require('assert')
const crypto = require('crypto')
const {
  createClient,
  KIND,
} = require('../../../../../commercial/ne-auth-v2')

describe('ne-auth-v2/live captcha emergency switch', function () {
  let enabled
  let dictionaryFails
  let calls
  let client
  let publicKey

  before(function () {
    publicKey = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey
  })
  beforeEach(function () {
    enabled = '1'
    dictionaryFails = false
    calls = []
    client = createClient({
      clientId: 'flylatex',
      async request(method, url, options) {
        const pathname = new URL(url).pathname
        calls.push({ pathname, form: options.form })
        if (pathname === '/user/dict') {
          if (dictionaryFails) throw new Error('offline')
          return {
            status: 200,
            body: JSON.stringify({
              code: 0,
              data: {
                public_key: publicKey,
                captcha:
                  enabled === '0'
                    ? { enabled: '0' }
                    : {
                        enabled,
                        provider: 'aliyun',
                        region: 'cn',
                        prefix: 'fixture',
                        sceneId: 'fixture',
                      },
              },
            }),
          }
        }
        return {
          status: 200,
          body: JSON.stringify({
            code: 0,
            data: {
              access_token: 'a2.fixture',
              refresh_token: 'r2.fixture',
              account_id: 10001,
            },
          }),
        }
      },
    })
  })

  for (const method of ['loginWithPassword', 'sendLoginSms']) {
    const params = {
      target: 'old-user@example.com',
      password: 'fixture-password',
      mobile: '13800000000',
    }
    const endpoint =
      method === 'sendLoginSms' ? '/util/sendcode' : '/user/passwordlogin'

    it(`${method} reads the switch again, omits stale captcha after disable, and requires a fresh result after re-enable`, async function () {
      await assert.rejects(
        client[method](params),
        error => error.kind === KIND.INVALID_REQUEST
      )
      assert.equal(
        calls.some(call => call.pathname === endpoint),
        false
      )
      enabled = '0'
      await client[method]({ ...params, captchaVerifyParam: 'STALE' })
      const disabled = calls.find(call => call.pathname === endpoint)
      assert.equal(
        Object.hasOwnProperty.call(disabled.form, 'captcha_verify_param'),
        false
      )
      enabled = '1'
      await assert.rejects(
        client[method](params),
        error => error.kind === KIND.INVALID_REQUEST
      )
      await client[method]({ ...params, captchaVerifyParam: 'FRESH' })
      assert.equal(calls.filter(call => call.pathname === endpoint).length, 2)
      assert.equal(calls[calls.length - 1].form.captcha_verify_param, 'FRESH')
      assert.equal(
        calls.filter(call => call.pathname === '/user/dict').length,
        4
      )
    })

    it(`${method} never treats a dictionary failure as the emergency switch being off`, async function () {
      dictionaryFails = true
      await assert.rejects(
        client[method](params),
        error => error.kind === KIND.NETWORK
      )
      assert.equal(
        calls.some(call => call.pathname === endpoint),
        false
      )
    })
  }

  it('SMS code login does not require or fetch the human-verification configuration', async function () {
    dictionaryFails = true
    await client.loginWithSmsCode({ mobile: '13800000000', code: '123456' })
    assert.deepEqual(
      calls.map(call => call.pathname),
      ['/user/codelogin']
    )
  })
})
