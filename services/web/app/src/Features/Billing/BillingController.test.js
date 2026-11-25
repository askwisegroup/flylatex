/**
 * `GET /api/billing/ledger` 的响应契约。
 *
 * 这个接口喂的是设置页的「充值记录」，所以钉住 4 件会直接影响用户观感的事：
 *   1. 未登录 / 账本未开启时**返回 200 + enabled:false**，让页面显示「暂无记录」
 *      而不是一个红色报错（设置页只对已登录用户渲染，这里拿到匿名请求说明
 *      cookie 丢了，不该当成错误处理）。
 *   2. 微单位到货币单位的换算只做一次，且 1e6 精确（100_000_000 → 100.00）。
 *   3. 账本读失败时**不抛**，转成 ok:false + reason，前端只提示一次。
 *   4. limit 有上下限，避免一次把整本账拉出来。
 */
const test = require('node:test')
const assert = require('node:assert')

const Billing = require('./index')
const Controller = require('./BillingController')

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

/** 用一张表把所有被 stub 的方法恢复原状，避免用例之间互相污染。 */
function stub(overrides) {
  const saved = new Map()
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Billing[key])
    Billing[key] = value
  }
  return () => {
    for (const [key, value] of saved) Billing[key] = value
  }
}

const baseStubs = {
  currency: () => 'SGD',
  isLedgerEnabled: () => true,
  balance: async () => ({ balanceMicros: 87_500_000, currency: 'SGD' }),
  listLedger: async () => [],
}

async function call(req, overrides = {}) {
  const restore = stub({ ...baseStubs, ...overrides })
  const res = fakeRes()
  try {
    await Controller.ledger(req, res)
  } finally {
    restore()
  }
  return res
}

test('未登录时返回 200 而不是 401', async () => {
  const res = await call({ session: {} })
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.body.ok, true)
  assert.strictEqual(res.body.enabled, false)
  assert.strictEqual(res.body.reason, 'not_logged_in')
  assert.deepStrictEqual(res.body.entries, [])
})

test('账本未开启时返回空列表而不是报错', async () => {
  const res = await call(
    { session: { user: { _id: 'u1' } } },
    { isLedgerEnabled: () => false }
  )
  assert.strictEqual(res.body.ok, true)
  assert.strictEqual(res.body.enabled, false)
  assert.strictEqual(res.body.balance, null)
  assert.deepStrictEqual(res.body.entries, [])
})

test('把微单位换算成货币单位，并保留最近流水', async () => {
  const res = await call(
    { session: { user: { _id: 'u1' } } },
    {
      listLedger: async () => [
        {
          _id: 'e1',
          kind: 'grant',
          amount_micros: 100_000_000,
          balance_after_micros: 100_000_000,
          at: new Date('2026-11-10T02:00:00.000Z'),
          status: 'applied',
          note: '首次登录赠送',
        },
        {
          _id: 'e2',
          kind: 'charge',
          amount_micros: -2_500_000,
          balance_after_micros: 97_500_000,
          at: new Date('2026-11-12T02:00:00.000Z'),
          status: 'pending',
        },
      ],
    }
  )

  assert.strictEqual(res.body.ok, true)
  assert.strictEqual(res.body.enabled, true)
  assert.strictEqual(res.body.currency, 'SGD')
  assert.strictEqual(res.body.balance, 87.5)

  const [grant, charge] = res.body.entries
  assert.strictEqual(grant.amount, 100)
  assert.strictEqual(grant.balanceAfter, 100)
  assert.strictEqual(grant.at, '2026-11-10T02:00:00.000Z')
  assert.strictEqual(grant.note, '首次登录赠送')
  assert.strictEqual(charge.amount, -2.5)
  assert.strictEqual(charge.balanceAfter, 97.5)
  // 缺省值不能让前端拿到 undefined
  assert.strictEqual(charge.note, '')
  assert.strictEqual(charge.status, 'pending')
})

test('账本读失败时转成 ok:false，不抛给路由', async () => {
  const res = await call(
    { session: { user: { _id: 'u1' } } },
    {
      listLedger: async () => {
        throw new Error('mongo down')
      },
    }
  )
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.body.ok, false)
  assert.strictEqual(res.body.reason, 'ledger_unavailable')
  assert.deepStrictEqual(res.body.entries, [])
})

test('limit 有上下限', async () => {
  const seen = []
  const overrides = {
    listLedger: async ({ limit }) => {
      seen.push(limit)
      return []
    },
  }

  await call({ session: { user: { _id: 'u1' } }, query: {} }, overrides)
  await call({ session: { user: { _id: 'u1' } }, query: { limit: '5' } }, overrides)
  await call({ session: { user: { _id: 'u1' } }, query: { limit: '999' } }, overrides)
  await call({ session: { user: { _id: 'u1' } }, query: { limit: '0' } }, overrides)
  await call(
    { session: { user: { _id: 'u1' } }, query: { limit: 'abc' } },
    overrides
  )

  assert.deepStrictEqual(seen, [20, 5, 50, 1, 20])
})
