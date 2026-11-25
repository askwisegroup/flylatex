const { expect } = require('chai')

const {
  normalizeCaptcha,
  requiresCaptcha,
} = require('../../../../../commercial/ne-auth-v2/captcha')
const {
  KIND,
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2/errors')

describe('ne-auth-v2/captcha', function () {
  const full = {
    enabled: '1',
    provider: 'aliyun',
    region: 'cn',
    prefix: 'zskm55',
    sceneId: 's7sgxrti',
  }

  it('enabled="0" 时判定为关闭', function () {
    const r = normalizeCaptcha({ enabled: '0' })
    expect(r.enabled).to.equal(false)
    expect(requiresCaptcha({ enabled: '0' })).to.equal(false)
  })

  it('enabled="1" 且字段齐全时判定为启用', function () {
    const r = normalizeCaptcha(full)
    expect(r).to.deep.equal({
      enabled: true,
      provider: 'aliyun',
      region: 'cn',
      prefix: 'zskm55',
      sceneId: 's7sgxrti',
    })
    expect(requiresCaptcha(full)).to.equal(true)
  })

  // 指南：数字 0、缺失或其他异常值不能当作关闭
  it('enabled 为数字 0 时视为配置不可用（不能当作关闭）', function () {
    expect(() => normalizeCaptcha({ enabled: 0 })).to.throw(NeAuthError)
    try {
      normalizeCaptcha({ enabled: 0 })
    } catch (e) {
      expect(e.kind).to.equal(KIND.CAPTCHA_UNAVAILABLE)
    }
  })

  it('enabled 缺失 / 非 "0"/"1" 字符串 -> 配置不可用', function () {
    for (const enabled of [undefined, null, '', 'true', 'yes', true, 1, '2']) {
      expect(() => normalizeCaptcha({ enabled })).to.throw(NeAuthError)
    }
  })

  it('captcha 本身缺失或非对象 -> 配置不可用', function () {
    for (const v of [undefined, null, 'x', 123, []]) {
      expect(() => normalizeCaptcha(v)).to.throw(NeAuthError)
    }
  })

  it('enabled="1" 但 provider 不是 aliyun -> 配置不可用', function () {
    expect(() => normalizeCaptcha({ ...full, provider: 'other' })).to.throw(
      NeAuthError
    )
    expect(() => normalizeCaptcha({ ...full, provider: undefined })).to.throw(
      NeAuthError
    )
  })

  it('enabled="1" 但 region/prefix/sceneId 缺失或空串/false/null -> 配置不可用', function () {
    for (const key of ['region', 'prefix', 'sceneId']) {
      for (const bad of [undefined, null, '', false, 0]) {
        expect(
          () => normalizeCaptcha({ ...full, [key]: bad }),
          `${key}=${bad}`
        ).to.throw(NeAuthError)
      }
    }
  })

  it('enabled="0" 时即使其他字段未配置也不报错（不初始化组件）', function () {
    const r = normalizeCaptcha({ enabled: '0' })
    expect(r.enabled).to.equal(false)
    expect(r.sceneId).to.equal('')
  })

  it('错误信息提示可读', function () {
    try {
      normalizeCaptcha({ enabled: '1', provider: 'aliyun' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.message).to.match(/验证码配置/)
    }
  })
})
