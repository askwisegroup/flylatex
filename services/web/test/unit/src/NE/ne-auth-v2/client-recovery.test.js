const { expect } = require('chai')
const {
  createClient,
  normalizeTokens,
  KIND,
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2')

const TOKEN_DATA = {
  access_token: 'a2.valid',
  refresh_token: 'r2.valid',
  token_type: 'Bearer',
  account_id: 10001,
}

function clientFor(response) {
  return createClient({
    clientId: 'flylatex',
    request: async () => ({ status: 200, body: JSON.stringify(response) }),
  })
}

async function expectKind(promise, kind) {
  try {
    await promise
  } catch (error) {
    expect(error).to.be.instanceOf(NeAuthError)
    expect(error.kind).to.equal(kind)
    return error
  }
  throw new Error(`Expected ${kind}`)
}

describe('ne-auth-v2/client identity recovery', function () {
  it('rejects a successful response that lacks a complete token pair', async function () {
    const client = clientFor({ code: 0 })
    await expectKind(
      client.loginWithSmsCode({ mobile: '13800000000', code: '123456' }),
      KIND.INVALID_RESPONSE
    )
    expect(() => normalizeTokens({ access_token: 'only-access' })).to.throw(
      NeAuthError
    )
  })
  it('wraps malformed public parameters instead of leaking TypeError', async function () {
    const client = clientFor({ code: 0 })
    for (const method of [
      'loginWithPassword',
      'sendLoginSms',
      'loginWithSmsCode',
      'exchangeCode',
      'refresh',
      'logout',
    ]) {
      await expectKind(client[method](null), KIND.INVALID_REQUEST)
    }
  })
  it('wraps unavailable password encryption configuration', async function () {
    const client = clientFor({
      code: 0,
      data: { public_key: 'broken-key', captcha: { enabled: '0' } },
    })
    await expectKind(
      client.loginWithPassword({
        target: 'old-user@example.com',
        password: 'unchanged',
      }),
      KIND.INVALID_RESPONSE
    )
  })
  it('preserves a verified account ID when the profile read is temporarily unavailable', async function () {
    const client = clientFor({
      code: 3000,
      data: { error: 'temporarily_unavailable' },
    })
    const result = await client.resolveUserInfo(
      normalizeTokens(TOKEN_DATA),
      '13800000000'
    )
    expect(result.account_id).to.equal('10001')
    expect(result.login_id).to.equal('13800000000')
    expect(result.token).to.equal(TOKEN_DATA.access_token)
  })
  it('does not invent an identity when both sources are unavailable', async function () {
    const client = clientFor({ code: 3000 })
    await expectKind(
      client.resolveUserInfo(
        normalizeTokens({ ...TOKEN_DATA, account_id: undefined }),
        '13800000000'
      ),
      KIND.TEMPORARILY_UNAVAILABLE
    )
  })
  it('does not fall back after authentication itself has expired', async function () {
    const client = clientFor({ code: 2001, data: { error: 'invalid_grant' } })
    await expectKind(
      client.resolveUserInfo(normalizeTokens(TOKEN_DATA), '13800000000'),
      KIND.INVALID_GRANT
    )
  })
  it('rejects inconsistent account IDs instead of associating another account', async function () {
    const client = clientFor({ code: 0, data: { account_id: 9999 } })
    await expectKind(
      client.resolveUserInfo(normalizeTokens(TOKEN_DATA), '13800000000'),
      KIND.INVALID_RESPONSE
    )
  })
  it('rejects invalid profile identifiers before legacy user creation', async function () {
    const client = clientFor({ code: 0, data: { account_id: {}, type: 1 } })
    await expectKind(
      client.resolveUserInfo(
        normalizeTokens({ ...TOKEN_DATA, account_id: undefined }),
        '',
        { requireProfile: true }
      ),
      KIND.INVALID_RESPONSE
    )
  })
  it('CARSI requires a readable profile and known entitlements', async function () {
    const unavailable = clientFor({ code: 3000 })
    await expectKind(
      unavailable.resolveUserInfo(normalizeTokens(TOKEN_DATA), '', {
        requireProfile: true,
      }),
      KIND.TEMPORARILY_UNAVAILABLE
    )
    const incomplete = clientFor({
      code: 0,
      data: { account_id: 10001, type: 2 },
    })
    await expectKind(
      incomplete.resolveUserInfo(normalizeTokens(TOKEN_DATA), '', {
        requireProfile: true,
        requireEntitlements: true,
      }),
      KIND.INVALID_RESPONSE
    )
    const valid = clientFor({
      code: 0,
      data: { account_id: 10001, type: 2, vip_end: '2031-12-31' },
    })
    const result = await valid.resolveUserInfo(
      normalizeTokens(TOKEN_DATA),
      '',
      { requireProfile: true, requireEntitlements: true }
    )
    expect(result.type).to.equal(2)
    expect(result.vip_end).to.equal('2031-12-31')
  })
  it('does not advertise an uncertain write request as retryable', async function () {
    const client = createClient({
      clientId: 'flylatex',
      request: async () => {
        throw new Error('response lost')
      },
    })
    const error = await expectKind(
      client.loginWithSmsCode({ mobile: '13800000000', code: '123456' }),
      KIND.NETWORK
    )
    expect(error.retriable).to.equal(false)
  })
})
