const { expect } = require('chai')

const browserCaptcha = require('../../../../../commercial/ne-auth-v2/browser/captcha')
const { resolveCaptchaPlan, ALIYUN_SDK_URL } = browserCaptcha

describe('ne-auth-v2/browser/captcha', function () {
  const full = {
    enabled: '1',
    provider: 'aliyun',
    region: 'cn',
    prefix: 'zskm55',
    sceneId: 's7sgxrti',
  }

  it('暴露阿里云官方 SDK 地址', function () {
    expect(ALIYUN_SDK_URL).to.equal(
      'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
    )
  })

  it('enabled="0" -> skip', function () {
    expect(resolveCaptchaPlan({ enabled: '0' })).to.deep.equal({
      action: 'skip',
    })
  })

  it('enabled="1" 且字段齐全 -> init 并带出 config', function () {
    const plan = resolveCaptchaPlan(full)
    expect(plan.action).to.equal('init')
    expect(plan.config).to.deep.equal({
      region: 'cn',
      prefix: 'zskm55',
      sceneId: 's7sgxrti',
    })
  })

  it('enabled 为数字 0 / 布尔 / 缺失 -> unavailable（不能当作关闭）', function () {
    for (const enabled of [0, false, '', null, undefined, 1, true, 'true']) {
      const plan = resolveCaptchaPlan({ enabled })
      expect(plan.action, `enabled=${String(enabled)}`).to.equal('unavailable')
      expect(plan.message).to.match(/验证码配置/)
    }
  })

  it('captcha 缺失 -> unavailable', function () {
    for (const v of [null, undefined, 'x', 1]) {
      expect(resolveCaptchaPlan(v).action).to.equal('unavailable')
    }
  })

  it('enabled="1" 但 provider / region / prefix / sceneId 有问题 -> unavailable', function () {
    expect(resolveCaptchaPlan({ ...full, provider: 'other' }).action).to.equal(
      'unavailable'
    )
    for (const key of ['region', 'prefix', 'sceneId']) {
      for (const bad of [undefined, null, '', false]) {
        expect(
          resolveCaptchaPlan({ ...full, [key]: bad }).action,
          `${key}=${bad}`
        ).to.equal('unavailable')
      }
    }
  })

  it('controller 在 enabled="0" 时不解 SDK，直接回调成功', async function () {
    let loaded = false
    const states = []
    const c = browserCaptcha.createController({
      loadScript: () => {
        loaded = true
        return Promise.resolve()
      },
      onStatus: s => states.push(s.state),
    })
    c.applyConfig({ enabled: '0' })
    let calledWith = null
    await c.mount('slot', { onSuccess: p => (calledWith = p) })
    expect(loaded).to.equal(false)
    expect(calledWith).to.equal('')
    expect(states).to.include('disabled')
  })

  it('controller 在配置不可用时上报 unavailable 且不加载 SDK', function () {
    let loaded = false
    const states = []
    const c = browserCaptcha.createController({
      loadScript: () => {
        loaded = true
        return Promise.resolve()
      },
      onStatus: s => states.push(s),
    })
    c.applyConfig({ enabled: 0 })
    expect(loaded).to.equal(false)
    expect(states[0].state).to.equal('unavailable')
  })
})
