const { expect } = require('chai')

const {
  normalizeLoginArgs,
  isAuthV2Enabled,
  buildUserInfoResult,
  toLegacyLoginError,
} = require('../../../../../commercial/ne-auth-v2/adapter')
const {
  KIND,
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2/errors')

describe('ne-auth-v2/adapter', function () {
  describe('normalizeLoginArgs（向后兼容旧签名）', function () {
    // 注意：normalizeLoginArgs 接收的是「第 3、第 4 个位置参数」，
    // 对应 login(username, passwd, arg3, arg4)
    it('login(username, password, cb) 形态（第 3 参是回调）', function () {
      const cb = () => {}
      const r = normalizeLoginArgs(cb, undefined)
      expect(r.cb).to.equal(cb)
      expect(r.captchaVerifyParam).to.equal(undefined)
    })

    it('login(username, password, captcha, cb) 形态', function () {
      const cb = () => {}
      const r = normalizeLoginArgs('CAPTCHA', cb)
      expect(r.cb).to.equal(cb)
      expect(r.captchaVerifyParam).to.equal('CAPTCHA')
    })

    it('captcha 位置传 undefined 时仍能识别 cb', function () {
      const cb = () => {}
      const r = normalizeLoginArgs(undefined, cb)
      expect(r.cb).to.equal(cb)
      expect(r.captchaVerifyParam).to.equal(undefined)
    })
  })

  describe('isAuthV2Enabled', function () {
    it('默认启用', function () {
      expect(isAuthV2Enabled(undefined)).to.equal(true)
      expect(isAuthV2Enabled({})).to.equal(true)
      expect(isAuthV2Enabled({ ne: {} })).to.equal(true)
      expect(isAuthV2Enabled({ ne: { authV2: true } })).to.equal(true)
    })
    it('显式 false 才回退到 V1', function () {
      expect(isAuthV2Enabled({ ne: { authV2: false } })).to.equal(false)
    })
  })

  describe('buildUserInfoResult', function () {
    const tokens = {
      accessToken: 'a2.TOKEN',
      refreshToken: 'r2.REFRESH',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresIn: 86400,
      expiresAt: 1791686930,
      sessionExpiresAt: 1791772430,
      profile: {
        accountId: '10001',
        email: 'fromlogin@example.com',
        mobile: '',
      },
    }
    const profile = {
      account_id: 10001,
      nick_name: '测试用户',
      name: '测试用户',
      type_txt: 'VIP会员',
      icon_url: 'http://avatar/x.png',
      inst_name: '北京师范大学',
      mobile: '15810024047',
      email: 'frominfo@example.com',
      type: 2,
      vip_end: '2031-12-31',
    }

    it('包含 AuthenticationManager 依赖的全部字段', function () {
      const r = buildUserInfoResult(tokens, profile, 'user@example.com')
      expect(r.code).to.equal(0)
      expect(r.msg).to.equal('success')
      expect(r.nick_name).to.equal('测试用户')
      expect(r.name).to.equal('测试用户')
      expect(r.type_txt).to.equal('VIP会员')
      expect(r.icon_url).to.equal('http://avatar/x.png')
      expect(r.account_id).to.equal(10001)
      expect(r.inst_name).to.equal('北京师范大学')
      expect(r.mobile).to.equal('15810024047')
      expect(r.login_id).to.equal('user@example.com')
    })

    it('/user/info 优先于登录响应字段', function () {
      const r = buildUserInfoResult(tokens, profile, 'u')
      expect(r.email).to.equal('frominfo@example.com')
      expect(r.mobile).to.equal('15810024047')
    })

    it('/user/info 取不到时回退到登录响应，且不丢关键字段', function () {
      const r = buildUserInfoResult(tokens, null, 'u')
      expect(r.code).to.equal(0)
      expect(r.account_id).to.equal('10001')
      expect(r.email).to.equal('fromlogin@example.com')
      // 缺失字段以空串兜底，避免下游出现 undefined
      expect(r.nick_name).to.equal('')
      expect(r.inst_name).to.equal('')
    })

    it('透传 V2 令牌，且不影响既有字段语义', function () {
      const r = buildUserInfoResult(tokens, profile, 'u')
      expect(r.token).to.equal('a2.TOKEN')
      expect(r.accessToken).to.equal('a2.TOKEN')
      expect(r.refreshToken).to.equal('r2.REFRESH')
      expect(r.tokenType).to.equal('Bearer')
      expect(r.expiresIn).to.equal(900)
    })

    it('login_id 在调用方未传时回退到 account_id', function () {
      const r = buildUserInfoResult(tokens, profile, '')
      expect(r.login_id).to.equal(10001)
    })

    it('保留 CARSI 侧需要的 type / vip_end', function () {
      const r = buildUserInfoResult(tokens, profile, 'u')
      expect(r.type).to.equal(2)
      expect(r.vip_end).to.equal('2031-12-31')
    })

    it('tokens 为空也不抛错', function () {
      const r = buildUserInfoResult(null, null, 'u')
      expect(r.code).to.equal(0)
      expect(r.account_id).to.equal('')
    })
  })

  describe('toLegacyLoginError（映射为原 {code,msg} 形态）', function () {
    it('所有分支都返回 code=500 且 msg 非空', function () {
      const kinds = [
        KIND.CAPTCHA_FAILED,
        KIND.CAPTCHA_UNAVAILABLE,
        KIND.INVALID_CLIENT,
        KIND.CLIENT_UPGRADE_REQUIRED,
        KIND.INVALID_GRANT,
        KIND.SLOW_DOWN,
        KIND.TEMPORARILY_UNAVAILABLE,
        KIND.NETWORK,
        KIND.UNKNOWN,
      ]
      for (const kind of kinds) {
        const r = toLegacyLoginError(new NeAuthError(kind, { msg: 'x' }))
        expect(r.code, kind).to.equal(500)
        expect(r.msg, kind).to.be.a('string')
        expect(r.msg.length, kind).to.be.greaterThan(0)
      }
    })

    it('CAPTCHA_FAILED 给出可操作提示（而不是 NE 的“身份验证失败”）', function () {
      const r = toLegacyLoginError(
        new NeAuthError(KIND.CAPTCHA_FAILED, { msg: '身份验证失败' })
      )
      expect(r.msg).to.match(/验证码/)
    })

    it('INVALID_REQUEST 透传 NE 原文（如“密码错误”）', function () {
      const r = toLegacyLoginError(
        new NeAuthError(KIND.INVALID_REQUEST, { msg: '密码错误' })
      )
      expect(r.msg).to.equal('密码错误')
    })

    it('未知错误也能给出兜底文案', function () {
      expect(toLegacyLoginError(null).msg).to.equal('登录失败')
      expect(toLegacyLoginError(new Error('boom')).msg).to.equal('boom')
    })
  })
})
