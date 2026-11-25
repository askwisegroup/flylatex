const { expect } = require('chai')
const http = require('http')

const {
  createClient,
} = require('../../../../../commercial/ne-auth-v2/client')
const {
  KIND,
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2/errors')
const {
  startMockNe,
  DEFAULT_CLIENT_ID,
  DEFAULT_VALID_CAPTCHA,
  DEFAULT_SMS_CODE,
} = require('./fixtures/mock-ne-server')

/** 断言 promise 以指定 kind 的 NeAuthError 拒绝 */
async function expectKind(promise, kind, msg) {
  try {
    await promise
    throw new Error(`预期抛出 ${kind}，但成功返回`)
  } catch (e) {
    if (!(e instanceof NeAuthError)) throw e
    expect(e.kind, msg || e.message).to.equal(kind)
    return e
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, res => {
        let body = ''
        res.on('data', c => (body += c))
        res.on('end', () => resolve(JSON.parse(body)))
      })
      .on('error', reject)
  })
}

describe('ne-auth-v2/client', function () {
  this.timeout(15000)

  function makeClient(mock, extra) {
    return createClient({
      baseUrl: mock.baseUrl,
      clientId: extra && extra.clientId ? extra.clientId : DEFAULT_CLIENT_ID,
      redirectUri: 'https://www.example.com/ne-auth-callback',
      clientSecret: (extra && extra.clientSecret) || '',
    })
  }

  describe('未启用验证码（enabled="0"）', function () {
    let mock
    let ne

    before(async function () {
      mock = await startMockNe({ captchaEnabled: false })
      ne = makeClient(mock)
    })
    after(async function () {
      await mock.close()
    })

    it('dict() 归一化字典字段', async function () {
      const d = await ne.dict()
      expect(d.publicKey).to.match(/^-----BEGIN PUBLIC KEY-----/)
      expect(d.carsiAuthorizeUrl).to.include('/user/carsiauthorize')
      expect(d.captcha.enabled).to.equal('0')
    })

    it('captchaConfig() 返回 enabled=false', async function () {
      const c = await ne.captchaConfig()
      expect(c.enabled).to.equal(false)
    })

    it('密码登录成功并归一化令牌与用户信息', async function () {
      const t = await ne.loginWithPassword({
        target: 'demo@example.com',
        password: 'Passw0rd!',
      })
      expect(t.accessToken).to.match(/^a2\./)
      expect(t.refreshToken).to.match(/^r2\./)
      expect(t.tokenType).to.equal('Bearer')
      expect(t.expiresIn).to.equal(900)
      expect(t.refreshExpiresIn).to.equal(86400)
      expect(t.profile.accountId).to.equal('10001')
      expect(t.profile.email).to.equal('demo@example.com')
    })

    it('密码用字典公钥加密后提交，服务端能解出原文', async function () {
      mock.requests.length = 0
      await ne.loginWithPassword({
        target: 'demo@example.com',
        password: 'Passw0rd!',
      })
      const req = mock.requests.find(r => r.path === '/user/passwordlogin')
      expect(req.form.auth_version).to.equal('2')
      expect(req.form.client_id).to.equal(DEFAULT_CLIENT_ID)
      expect(req.form.password).to.match(/^[A-Za-z0-9+/]+={0,2}$/)
      expect(req.form.password).to.not.include('Passw0rd!')
      expect(req.form).to.not.have.property('captcha_verify_param')
    })

    it('密码错误 -> 参数错误（通用失败文案）', async function () {
      const e = await expectKind(
        ne.loginWithPassword({ target: 'demo@example.com', password: 'WRONG' }),
        KIND.INVALID_REQUEST
      )
      expect(e.msg).to.match(/密码错误/)
    })

    it('账号不存在 -> 同样返回参数错误', async function () {
      await expectKind(
        ne.loginWithPassword({
          target: 'nobody@example.invalid',
          password: 'x',
        }),
        KIND.INVALID_REQUEST
      )
    })

    it('client_id 不匹配 -> invalid_client', async function () {
      const bad = makeClient(mock, { clientId: 'not_registered' })
      await expectKind(
        bad.loginWithPassword({
          target: 'demo@example.com',
          password: 'Passw0rd!',
        }),
        KIND.INVALID_CLIENT
      )
    })

    it('缺少 target/password 时本地即拒绝', async function () {
      await expectKind(
        ne.loginWithPassword({ target: '', password: 'x' }),
        KIND.INVALID_REQUEST
      )
      await expectKind(
        ne.loginWithPassword({ target: 'a', password: '' }),
        KIND.INVALID_REQUEST
      )
    })

    it('短信登录两步都成功', async function () {
      const sent = await ne.sendLoginSms({ mobile: '13800000000' })
      expect(sent.sent).to.equal(true)
      const t = await ne.loginWithSmsCode({
        mobile: '13800000000',
        code: DEFAULT_SMS_CODE,
      })
      expect(t.accessToken).to.match(/^a2\./)
      expect(t.profile.accountId).to.equal('659497')
      expect(t.profile.mobile).to.equal('13800000000')
    })

    it('发送短信接口不携带 auth_version / client_id（按指南）', async function () {
      mock.requests.length = 0
      await ne.sendLoginSms({ mobile: '13800000000' })
      const req = mock.requests.find(r => r.path === '/util/sendcode')
      expect(req.form.type).to.equal('2')
      expect(req.form.target).to.equal('13800000000')
      expect(req.form).to.not.have.property('auth_version')
      expect(req.form).to.not.have.property('client_id')
    })

    it('短信码错误 -> 被拒', async function () {
      const e = await expectKind(
        ne.loginWithSmsCode({ mobile: '13800000000', code: '000000' }),
        KIND.UNKNOWN
      )
      expect(e.msg).to.match(/验证码错误/)
    })

    it('短信码按字符串提交，保留前导零', async function () {
      mock.requests.length = 0
      await ne
        .loginWithSmsCode({ mobile: '13800000000', code: '012345' })
        .catch(() => {})
      const req = mock.requests.find(r => r.path === '/user/codelogin')
      expect(req.form.code).to.equal('012345')
    })

    it('refresh 与 logout、Bearer 业务接口', async function () {
      const t = await ne.loginWithPassword({
        target: 'demo@example.com',
        password: 'Passw0rd!',
      })
      // 轮换间隔默认 60 秒 -> 立即刷新会 slow_down
      const slow = await expectKind(
        ne.refresh({ refreshToken: t.refreshToken, requestId: 'a'.repeat(32) }),
        KIND.SLOW_DOWN
      )
      expect(slow.retryAfter).to.be.a('number')

      const info = await ne.getUserInfo(t.accessToken)
      expect(info.account_id).to.equal(10001)

      const out = await ne.logout({ refreshToken: t.refreshToken })
      expect(out.revoked).to.equal(true)
    })

    it('refresh 缺少 request_id -> invalid_request', async function () {
      const t = await ne.loginWithPassword({
        target: 'demo@example.com',
        password: 'Passw0rd!',
      })
      await expectKind(
        ne.refresh({ refreshToken: t.refreshToken }),
        KIND.INVALID_REQUEST
      )
    })

    it('无效字符串令牌调用业务接口 -> invalid_grant', async function () {
      await expectKind(ne.getUserInfo('not-a-token'), KIND.INVALID_GRANT)
    })
  })

  describe('启用验证码（enabled="1"）', function () {
    let mock
    let ne

    before(async function () {
      mock = await startMockNe({ captchaEnabled: true })
      ne = makeClient(mock)
    })
    after(async function () {
      await mock.close()
    })

    it('captchaConfig() 返回启用与阿里云参数', async function () {
      const c = await ne.captchaConfig()
      expect(c.enabled).to.equal(true)
      expect(c.provider).to.equal('aliyun')
      expect(c.sceneId).to.equal('mockscene')
    })

    it('缺少 captcha_verify_param 时本地拒绝，提示完成验证且不发送空结果', async function () {
      mock.requests.length = 0
      const error = await expectKind(
        ne.loginWithPassword({
          target: 'demo@example.com',
          password: 'Passw0rd!',
        }),
        KIND.INVALID_REQUEST
      )
      expect(error.msg).to.match(/先完成人机验证/)
      const req = mock.requests.find(r => r.path === '/user/passwordlogin')
      expect(req).to.equal(undefined)
    })

    it('伪造验证码 -> captcha_failed（身份验证失败）', async function () {
      await expectKind(
        ne.loginWithPassword({
          target: 'demo@example.com',
          password: 'Passw0rd!',
          captchaVerifyParam: 'FAKE',
        }),
        KIND.CAPTCHA_FAILED
      )
    })

    it('有效验证码 -> 登录成功', async function () {
      const t = await ne.loginWithPassword({
        target: 'demo@example.com',
        password: 'Passw0rd!',
        captchaVerifyParam: DEFAULT_VALID_CAPTCHA,
      })
      expect(t.accessToken).to.match(/^a2\./)
    })

    it('发送短信同样需要验证码', async function () {
      await expectKind(
        ne.sendLoginSms({ mobile: '13800000000' }),
        KIND.INVALID_REQUEST
      )
      const ok = await ne.sendLoginSms({
        mobile: '13800000000',
        captchaVerifyParam: DEFAULT_VALID_CAPTCHA,
      })
      expect(ok.sent).to.equal(true)
    })
  })

  describe('授权码 / CARSI 与 PKCE', function () {
    let mock
    let ne

    before(async function () {
      mock = await startMockNe({})
      ne = makeClient(mock)
    })
    after(async function () {
      await mock.close()
    })

    it('buildAuthorizeUrl 携带全部五项参数', function () {
      const { state, challenge } = ne.newTransaction()
      const url = new URL(ne.buildAuthorizeUrl({ state, challenge }))
      expect(url.pathname).to.equal('/user/authorize')
      // FIXED: 2026-10-23 授权码入口改用 client_id（新指南两个入口统一）
      expect(url.searchParams.get('client_id')).to.equal(DEFAULT_CLIENT_ID)
      expect(url.searchParams.get('app')).to.equal(null)
      expect(url.searchParams.get('redirect')).to.equal(
        'https://www.example.com/ne-auth-callback'
      )
      expect(url.searchParams.get('state')).to.equal(state)
      expect(url.searchParams.get('code_challenge')).to.equal(challenge)
      expect(url.searchParams.get('code_challenge_method')).to.equal('S256')
    })

    it('buildCarsiUrl 在字典地址上追加同样的五项参数', async function () {
      const d = await ne.dict()
      const { state, challenge } = ne.newTransaction()
      const url = new URL(
        ne.buildCarsiUrl({
          carsiAuthorizeUrl: d.carsiAuthorizeUrl,
          state,
          challenge,
        })
      )
      expect(url.pathname).to.equal('/user/carsiauthorize')
      // FIXED: 2026-10-14 CARSI 入口改用 client_id（不再用 app）
      expect(url.searchParams.get('client_id')).to.equal(DEFAULT_CLIENT_ID)
      expect(url.searchParams.get('app')).to.equal(null)
      expect(url.searchParams.get('code_challenge_method')).to.equal('S256')
    })

    it('buildCarsiUrl 缺少字典地址时报错', function () {
      expect(() =>
        ne.buildCarsiUrl({ carsiAuthorizeUrl: '', state: 'x', challenge: 'y' })
      ).to.throw(NeAuthError)
    })

    it('授权码兑换令牌（完整 PKCE 流程）', async function () {
      const { state, verifier, challenge } = ne.newTransaction()
      const authUrl =
        ne.buildAuthorizeUrl({ state, challenge }) + '&mock_format=json'
      const issued = await getJson(authUrl)
      expect(issued.state).to.equal(state)

      const t = await ne.exchangeCode({
        code: issued.code,
        codeVerifier: verifier,
      })
      expect(t.accessToken).to.match(/^a2\./)
      expect(t.refreshToken).to.match(/^r2\./)
    })

    it('同一授权码不能重复兑换', async function () {
      const { state, verifier, challenge } = ne.newTransaction()
      const issued = await getJson(
        ne.buildAuthorizeUrl({ state, challenge }) + '&mock_format=json'
      )
      await ne.exchangeCode({ code: issued.code, codeVerifier: verifier })
      await expectKind(
        ne.exchangeCode({ code: issued.code, codeVerifier: verifier }),
        KIND.INVALID_GRANT
      )
    })

    it('code_verifier 不匹配 -> invalid_grant', async function () {
      const { state, challenge } = ne.newTransaction()
      const issued = await getJson(
        ne.buildAuthorizeUrl({ state, challenge }) + '&mock_format=json'
      )
      await expectKind(
        ne.exchangeCode({ code: issued.code, codeVerifier: 'a'.repeat(64) }),
        KIND.INVALID_GRANT
      )
    })

    it('state 不匹配时应被调用方拒绝（回调校验语义）', async function () {
      const t1 = ne.newTransaction()
      const issued = await getJson(
        ne.buildAuthorizeUrl({ state: t1.state, challenge: t1.challenge }) +
          '&mock_format=json'
      )
      const t2 = ne.newTransaction()
      expect(issued.state).to.not.equal(t2.state)
    })
  })

  describe('保密客户端与网络错误', function () {
    it('配置 clientSecret 时会随登录请求提交', async function () {
      const mock = await startMockNe({ clientSecret: 's3cret' })
      try {
        const good = makeClient(mock, { clientSecret: 's3cret' })
        const t = await good.loginWithPassword({
          target: 'demo@example.com',
          password: 'Passw0rd!',
        })
        expect(t.accessToken).to.match(/^a2\./)

        const bad = makeClient(mock, { clientSecret: 'wrong' })
        await expectKind(
          bad.loginWithPassword({
            target: 'demo@example.com',
            password: 'Passw0rd!',
          }),
          KIND.INVALID_CLIENT
        )

        const none = makeClient(mock, {})
        await expectKind(
          none.loginWithPassword({
            target: 'demo@example.com',
            password: 'Passw0rd!',
          }),
          KIND.INVALID_CLIENT
        )
      } finally {
        await mock.close()
      }
    })

    it('client_secret 随四个后端接口提交', async function () {
      const mock = await startMockNe({ clientSecret: 's3cret' })
      try {
        const ne = makeClient(mock, { clientSecret: 's3cret' })
        await ne.loginWithPassword({
          target: 'demo@example.com',
          password: 'Passw0rd!',
        })
        await ne.loginWithSmsCode({
          mobile: '13800000000',
          code: DEFAULT_SMS_CODE,
        })
        const tx = ne.newTransaction()
        const issued = await getJson(
          ne.buildAuthorizeUrl({ state: tx.state, challenge: tx.challenge }) +
            '&mock_format=json'
        )
        const tokens = await ne.exchangeCode({
          code: issued.code,
          codeVerifier: tx.verifier,
        })
        // 刷新请求也要带 client_secret；立即刷新会 slow_down，但请求已发出
        await expectKind(
          ne.refresh({
            refreshToken: tokens.refreshToken,
            requestId: 'a'.repeat(32),
          }),
          KIND.SLOW_DOWN
        )
        await ne.logout({ refreshToken: tokens.refreshToken })

        const forms = path =>
          mock.requests.filter(r => r.path === path).map(r => r.form)
        for (const path of [
          '/user/passwordlogin',
          '/user/codelogin',
          '/user/token',
          '/user/sessionlogout',
        ]) {
          const requests = forms(path)
          expect(requests, path).to.not.be.empty
          for (const form of requests) {
            expect(form.client_secret, path).to.equal('s3cret')
          }
        }
      } finally {
        await mock.close()
      }
    })

    it('服务不可达 -> network 错误（可重试）', async function () {
      // 端口 1 不会有人监听
      const dead = createClient({
        baseUrl: 'http://127.0.0.1:1',
        clientId: 'flylatex',
      })
      const e = await expectKind(dead.dict(), KIND.NETWORK)
      expect(e.retriable).to.equal(true)
    })

    it('createClient 缺少 clientId 时立即报错', function () {
      expect(() => createClient({})).to.throw(NeAuthError)
    })
  })
})
