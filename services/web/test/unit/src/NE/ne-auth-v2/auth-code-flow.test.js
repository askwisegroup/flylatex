const { expect } = require('chai')
const http = require('http')

const {
  createClient,
} = require('../../../../../commercial/ne-auth-v2/client')
const {
  createAuthCodeFlow,
} = require('../../../../../commercial/ne-auth-v2/auth-code-flow')
const {
  KIND,
  NeAuthError,
} = require('../../../../../commercial/ne-auth-v2/errors')
const { startMockNe } = require('./fixtures/mock-ne-server')
const {
  createMemoryTransactionStore,
} = require('../../../../../commercial/ne-auth-v2/transaction-store')

const REDIRECT = 'https://www.example.com/ne-auth-callback'

async function expectKind(promise, kind) {
  try {
    await promise
    throw new Error(`预期抛出 ${kind}`)
  } catch (e) {
    if (!(e instanceof NeAuthError)) throw e
    expect(e.kind).to.equal(kind)
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

describe('ne-auth-v2/auth-code-flow', function () {
  this.timeout(15000)

  let mock
  let client

  before(async function () {
    mock = await startMockNe({})
    client = createClient({
      baseUrl: mock.baseUrl,
      clientId: 'flylatex',
      redirectUri: REDIRECT,
    })
  })
  after(async function () {
    await mock.close()
  })

  it('begin(mode=password) 返回带五项参数的授权 URL 并保存事务', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    const url = new URL(tx.url)
    expect(url.pathname).to.equal('/user/authorize')
    // FIXED: 2026-10-23 授权码入口改用 client_id（新指南两个入口统一）
    expect(url.searchParams.get('client_id')).to.equal('flylatex')
    expect(url.searchParams.get('app')).to.equal(null)
    expect(url.searchParams.get('redirect')).to.equal(REDIRECT)
    expect(url.searchParams.get('state')).to.equal(tx.state)
    expect(url.searchParams.get('code_challenge')).to.equal(
      // challenge 由 verifier 推导，可用库函数复核
      require('../../../../../commercial/ne-auth-v2/pkce').challengeFromVerifier(
        tx.verifier
      )
    )
    expect(url.searchParams.get('code_challenge_method')).to.equal('S256')
    expect(flow.hasTransaction(tx.state)).to.equal(true)
    expect(flow.pendingCount()).to.equal(1)
  })

  it('begin(mode=carsi) 自动从字典取入口地址', async function () {
    const flow = createAuthCodeFlow({ client })
    mock.requests.length = 0
    const tx = await flow.begin({ mode: 'carsi' })
    const url = new URL(tx.url)
    expect(url.pathname).to.equal('/user/carsiauthorize')
    // FIXED: 2026-10-23 两个授权入口统一使用 client_id
    expect(url.searchParams.get('client_id')).to.equal('flylatex')
    expect(url.searchParams.get('app')).to.equal(null)
    expect(url.searchParams.get('code_challenge_method')).to.equal('S256')
    // 用字典地址，必须真的查过字典
    expect(mock.requests.filter(r => r.path === '/user/dict')).to.have.length(1)
  })

  it('begin(mode=carsi) 已提供入口地址时不再查字典', async function () {
    const flow = createAuthCodeFlow({ client })
    mock.requests.length = 0
    const tx = await flow.begin({
      mode: 'carsi',
      carsiAuthorizeUrl: `${mock.baseUrl}/user/carsiauthorize`,
    })
    expect(new URL(tx.url).pathname).to.equal('/user/carsiauthorize')
    expect(mock.requests.filter(r => r.path === '/user/dict')).to.have.length(0)
  })

  it('完整流程：发起 → 回调 → 兑换令牌', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    const issued = await getJson(`${tx.url}&mock_format=json`)
    expect(issued.state).to.equal(tx.state)

    const { tokens, mode, attempt } = await flow.complete({
      code: issued.code,
      state: tx.state,
    })
    expect(tokens.accessToken).to.match(/^a2\./)
    expect(tokens.refreshToken).to.match(/^r2\./)
    expect(mode).to.equal('password')
    expect(attempt).to.equal(1)
    expect(flow.hasTransaction(tx.state)).to.equal(false)
  })

  it('CARSI 完整流程同样可用', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin({ mode: 'carsi' })
    const issued = await getJson(`${tx.url}&mock_format=json`)
    const { tokens, mode } = await flow.complete({
      code: issued.code,
      state: tx.state,
    })
    expect(tokens.accessToken).to.match(/^a2\./)
    expect(mode).to.equal('carsi')
  })

  it('state 不匹配 -> state_invalid（不兑换）', async function () {
    const flow = createAuthCodeFlow({ client })
    await flow.begin()
    const e = await expectKind(
      flow.complete({ code: 'c2.x', state: 'not-my-state' }),
      KIND.STATE_INVALID
    )
    expect(e.message).to.match(/重新发起认证/)
    expect(e.requiresRelogin).to.equal(false)
  })

  it('缺少 state -> state_invalid', async function () {
    const flow = createAuthCodeFlow({ client })
    await expectKind(flow.complete({ code: 'c2.x' }), KIND.STATE_INVALID)
  })

  it('事务一次性消费：重复回调被拒，且 code 不会被重复兑换', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    const issued = await getJson(`${tx.url}&mock_format=json`)

    await flow.complete({ code: issued.code, state: tx.state })
    await expectKind(
      flow.complete({ code: issued.code, state: tx.state }),
      KIND.STATE_INVALID
    )
  })

  it('事务超过 10 分钟 -> state_invalid', async function () {
    let clock = 1_000_000
    const flow = createAuthCodeFlow({ client, now: () => clock })
    const tx = await flow.begin()
    clock += 10 * 60 * 1000 + 1
    await expectKind(
      flow.complete({ code: 'c2.x', state: tx.state }),
      KIND.STATE_INVALID
    )
    expect(flow.hasTransaction(tx.state)).to.equal(false)
  })

  it('失败回调 login_required -> 需重新登录，且不可自动重发起', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    const e = await expectKind(
      flow.complete({ error: 'login_required', state: tx.state }),
      KIND.INVALID_GRANT
    )
    expect(e.relaunchable).to.equal(false)
  })

  it('失败回调 server_error -> 可自动重发起一次', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    const e = await expectKind(
      flow.complete({ error: 'server_error', state: tx.state }),
      KIND.TEMPORARILY_UNAVAILABLE
    )
    expect(e.relaunchable).to.equal(true)
    expect(e.attempt).to.equal(1)
  })

  it('失败回调 temporarily_unavailable -> 可自动重发起一次', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    const e = await expectKind(
      flow.complete({ error: 'temporarily_unavailable', state: tx.state }),
      KIND.TEMPORARILY_UNAVAILABLE
    )
    expect(e.relaunchable).to.equal(true)
  })

  it('第二次尝试再遇 server_error -> 不再重发起（不循环重试）', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx1 = await flow.begin()
    const e1 = await expectKind(
      flow.complete({ error: 'server_error', state: tx1.state }),
      KIND.TEMPORARILY_UNAVAILABLE
    )
    expect(e1.relaunchable).to.equal(true)

    const tx2 = await flow.begin({ attempt: e1.attempt + 1 })
    const e2 = await expectKind(
      flow.complete({ error: 'server_error', state: tx2.state }),
      KIND.TEMPORARILY_UNAVAILABLE
    )
    expect(e2.relaunchable).to.equal(false)
    expect(e2.attempt).to.equal(2)
  })

  it('自动重发起后可以正常走完（新 state / 新 verifier）', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx1 = await flow.begin()
    const e1 = await expectKind(
      flow.complete({ error: 'server_error', state: tx1.state }),
      KIND.TEMPORARILY_UNAVAILABLE
    )

    const tx2 = await flow.begin({ attempt: e1.attempt + 1 })
    expect(tx2.state).to.not.equal(tx1.state)
    expect(tx2.verifier).to.not.equal(tx1.verifier)

    const issued = await getJson(`${tx2.url}&mock_format=json`)
    const { tokens } = await flow.complete({
      code: issued.code,
      state: tx2.state,
    })
    expect(tokens.accessToken).to.match(/^a2\./)
  })

  it('失败回调 access_denied -> invalid_request（用户取消）', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    const e = await expectKind(
      flow.complete({
        error: 'access_denied',
        errorDescription: 'user cancelled',
        state: tx.state,
      }),
      KIND.INVALID_REQUEST
    )
    expect(e.relaunchable).to.equal(false)
    expect(e.message).to.match(/access_denied/)
  })

  it('失败回调也会消费事务（不可重放）', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    await flow
      .complete({ error: 'access_denied', state: tx.state })
      .catch(() => {})
    expect(flow.hasTransaction(tx.state)).to.equal(false)
    await expectKind(
      flow.complete({ code: 'c2.x', state: tx.state }),
      KIND.STATE_INVALID
    )
  })

  it('回调缺少 code 且无 error -> invalid_request', async function () {
    const flow = createAuthCodeFlow({ client })
    const tx = await flow.begin()
    await expectKind(flow.complete({ state: tx.state }), KIND.INVALID_REQUEST)
  })

  it('purgeExpired 清掉过期事务', async function () {
    let clock = 0
    const flow = createAuthCodeFlow({ client, now: () => clock })
    await flow.begin()
    await flow.begin()
    expect(flow.pendingCount()).to.equal(2)
    clock += 10 * 60 * 1000 + 1
    flow.purgeExpired()
    expect(flow.pendingCount()).to.equal(0)
  })

  it('不同浏览器不能消费同一授权事务，原浏览器仍可完成', async function () {
    const flow = createAuthCodeFlow({ client, requireBinding: true })
    const tx = await flow.begin({ binding: 'original-browser' })
    const issued = await getJson(`${tx.url}&mock_format=json`)
    await expectKind(
      flow.complete({
        state: tx.state,
        code: issued.code,
        binding: 'other-browser',
      }),
      KIND.STATE_INVALID
    )
    expect(flow.hasTransaction(tx.state)).to.equal(true)
    const result = await flow.complete({
      state: tx.state,
      code: issued.code,
      binding: 'original-browser',
    })
    expect(result.tokens.accessToken).to.match(/^a2\./)
  })

  it('两个 flow 共享存储时回调可换实例，但只兑换一次', async function () {
    const store = createMemoryTransactionStore()
    const a = createAuthCodeFlow({ client, store, requireBinding: true })
    const b = createAuthCodeFlow({ client, store, requireBinding: true })
    const tx = await a.begin({ binding: 'browser' })
    const issued = await getJson(`${tx.url}&mock_format=json`)
    const result = await Promise.allSettled([
      a.complete({ state: tx.state, code: issued.code, binding: 'browser' }),
      b.complete({ state: tx.state, code: issued.code, binding: 'browser' }),
    ])
    expect(result.filter(value => value.status === 'fulfilled')).to.have.length(
      1
    )
    expect(
      result.find(value => value.status === 'rejected').reason.kind
    ).to.equal(KIND.STATE_INVALID)
  })

  it('失败回调同样拒绝过期事务，不自动重发起', async function () {
    let clock = 1000
    const flow = createAuthCodeFlow({ client, now: () => clock })
    const tx = await flow.begin()
    clock += 10 * 60 * 1000 + 1
    const error = await expectKind(
      flow.complete({ state: tx.state, error: 'server_error' }),
      KIND.STATE_INVALID
    )
    expect(error.relaunchable).to.equal(false)
  })
  it('要求浏览器绑定的 flow 不消费其他调用方留下的无绑定事务', async function () {
    const store = createMemoryTransactionStore()
    const legacy = createAuthCodeFlow({ client, store })
    const bound = createAuthCodeFlow({ client, store, requireBinding: true })
    const tx = await legacy.begin()
    await expectKind(
      bound.complete({ state: tx.state, code: 'unused', binding: 'browser' }),
      KIND.STATE_INVALID
    )
    expect(legacy.hasTransaction(tx.state)).to.equal(true)
  })
})
