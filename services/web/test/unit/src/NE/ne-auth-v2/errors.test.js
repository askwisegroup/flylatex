const { expect } = require('chai')

const {
  KIND,
  NeAuthError,
  classifyResponse,
  networkError,
} = require('../../../../../commercial/ne-auth-v2/errors')

describe('ne-auth-v2/errors', function () {
  it('code=0 视为成功', function () {
    expect(classifyResponse({ code: 0, msg: '', data: {} }, 200)).to.equal(null)
  })

  it('1000 -> invalid_request', function () {
    const e = classifyResponse({ code: 1000, msg: '参数错误' }, 200)
    expect(e).to.be.instanceOf(NeAuthError)
    expect(e.kind).to.equal(KIND.INVALID_REQUEST)
    expect(e.code).to.equal(1000)
    expect(e.retriable).to.equal(false)
  })

  it('1000 + unsupported_grant_type -> unsupported_grant_type', function () {
    const e = classifyResponse(
      { code: 1000, msg: '', data: { error: 'unsupported_grant_type' } },
      200
    )
    expect(e.kind).to.equal(KIND.UNSUPPORTED_GRANT_TYPE)
  })

  it('2000 + invalid_client -> invalid_client', function () {
    const e = classifyResponse(
      { code: 2000, data: { error: 'invalid_client' } },
      200
    )
    expect(e.kind).to.equal(KIND.INVALID_CLIENT)
  })

  it('2000 + invalid_origin -> invalid_origin', function () {
    const e = classifyResponse(
      { code: 2000, data: { error: 'invalid_origin' } },
      200
    )
    expect(e.kind).to.equal(KIND.INVALID_ORIGIN)
  })

  it('2000 + slow_down -> slow_down 且带 retry_after', function () {
    const e = classifyResponse(
      { code: 2000, data: { error: 'slow_down', retry_after: 30 } },
      200
    )
    expect(e.kind).to.equal(KIND.SLOW_DOWN)
    expect(e.retryAfter).to.equal(30)
    // slow_down 不应导致重新登录
    expect(e.requiresRelogin).to.equal(false)
  })

  it('2000 + msg=身份验证失败 -> captcha_failed（无 data.error）', function () {
    const e = classifyResponse({ code: 2000, msg: '身份验证失败' }, 200)
    expect(e.kind).to.equal(KIND.CAPTCHA_FAILED)
  })

  it('2001 + invalid_grant -> invalid_grant，要求重新登录与刷新令牌', function () {
    const e = classifyResponse(
      { code: 2001, data: { error: 'invalid_grant' } },
      200
    )
    expect(e.kind).to.equal(KIND.INVALID_GRANT)
    expect(e.requiresRelogin).to.equal(true)
    expect(e.shouldRefreshToken).to.equal(true)
  })

  it('2001 + data.error=client_upgrade_required -> client_upgrade_required', function () {
    const e = classifyResponse(
      { code: 2001, msg: 'x', data: { error: 'client_upgrade_required' } },
      200
    )
    expect(e.kind).to.equal(KIND.CLIENT_UPGRADE_REQUIRED)
    expect(e.requiresRelogin).to.equal(true)
    expect(e.shouldRefreshToken).to.equal(false)
  })

  it('2001 只有 msg=client_upgrade_required 时也能识别（data.error 缺失）', function () {
    const e = classifyResponse(
      { code: 2001, msg: 'client_upgrade_required' },
      200
    )
    expect(e.kind).to.equal(KIND.CLIENT_UPGRADE_REQUIRED)
  })

  it('3000 -> temporarily_unavailable，重试安全性由具体操作确定', function () {
    const e = classifyResponse(
      { code: 3000, data: { error: 'temporarily_unavailable' } },
      200
    )
    expect(e.kind).to.equal(KIND.TEMPORARILY_UNAVAILABLE)
    expect(e.retriable).to.equal(false)
  })

  it('非 JSON（HTML 错误页）-> unknown', function () {
    const e = classifyResponse(null, 200)
    expect(e.kind).to.equal(KIND.UNKNOWN)
    expect(e.httpStatus).to.equal(200)
  })

  it('未知 code -> unknown', function () {
    expect(classifyResponse({ code: 9999 }, 200).kind).to.equal(KIND.UNKNOWN)
  })

  it('网络错误默认不允许盲目重放写请求', function () {
    const e = networkError(new Error('ECONNREFUSED'))
    expect(e.kind).to.equal(KIND.NETWORK)
    expect(e.retriable).to.equal(false)
    expect(e.message).to.match(/ECONNREFUSED/)
  })

  it('明确的只读请求可以标记为安全重试', function () {
    expect(
      networkError(new Error('offline'), { retrySafe: true }).retriable
    ).to.equal(true)
  })
})
