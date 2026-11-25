'use strict'

/**
 * 充值订单 ↔ 账本 的集成测试。
 *
 * 用真实 Mongo（本地/CI 起的那个），因为这里要验证的恰恰是**并发与原子性**：
 * 「同一个回调来两次只入账一次」「金额不一致必须拒绝」这类保证
 * 在 mock 数据库上是验证不出来的。
 *
 * 没有可用 Mongo 时自动跳过，不让本地跑测试的人被环境卡住。
 */

const test = require('node:test')
const assert = require('node:assert')

process.env.DEPLOYMENT_PROFILE = 'sg'
process.env.BILLING_PROVIDER = 'fake'
process.env.BILLING_CURRENCY = 'SGD'
process.env.BILLING_LEDGER_ENABLED = '1'
process.env.MONGO_URL =
  process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sharelatex_test_billing'

const Settings = require('@overleaf/settings')

// 探测 Mongo 是否可用（1.5s 内连不上就跳过整个文件）
const mongoReachable = (() => {
  const net = require('net')
  const url = new URL(process.env.MONGO_URL)
  return new Promise(resolve => {
    const socket = net.connect(
      { host: url.hostname, port: Number(url.port) || 27017 },
      () => {
        socket.destroy()
        resolve(true)
      }
    )
    socket.setTimeout(1500)
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
})()

let db = null
let Checkout = null
let Ledger = null
let Fake = null

test.before(async () => {
  if (!(await mongoReachable)) return
  const mongodb = require('../../infrastructure/mongodb')
  await mongodb.waitForDb()
  db = mongodb.db
  Checkout = require('./checkout')
  Ledger = require('./ledger')
  Fake = require('./providers/fake')
  await db.collection('billing_orders').deleteMany({})
  await db.collection('billing_ledger').deleteMany({})
  await db.collection('billing_accounts').deleteMany({})
})

test.after(async () => {
  if (!db) return
  await db.collection('billing_orders').deleteMany({})
  await db.collection('billing_ledger').deleteMany({})
  await db.collection('billing_accounts').deleteMany({})
  const mongodb = require('../../infrastructure/mongodb')
  await mongodb.client.close()
})

const skip = () => (!db ? { skip: 'mongo 不可用' } : {})

function makeUserId() {
  const { ObjectId } = require('../../infrastructure/mongodb')
  return String(new ObjectId())
}

async function balanceOf(userId) {
  const row = await Ledger.balance(userId)
  return row ? row.balanceMicros : 0
}

test('下单：落到订单表并返回本地收银台地址', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  const result = await Checkout.createTopup({
    userId,
    amountMicros: 100_000_000,
    currency: 'SGD',
  })
  assert.ok(result.orderId)
  assert.match(result.checkoutUrl, /^\/billing\/mock\/checkout\//)
  assert.strictEqual(result.amountMicros, 100_000_000)

  const order = await Checkout.getOrder(result.orderId)
  assert.strictEqual(order.status, 'created')
  assert.strictEqual(order.provider, 'fake')
  assert.strictEqual(order.provider_ref, `mock_${result.orderId}`)
})

test('下单：非法金额/币种直接拒，不落库', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  await assert.rejects(
    () => Checkout.createTopup({ userId, amountMicros: 0, currency: 'SGD' }),
    /金额必须为正/
  )
  await assert.rejects(
    () => Checkout.createTopup({ userId, amountMicros: 100, currency: 'JPY' }),
    /币种与账本不一致/
  )
  await assert.rejects(
    () =>
      Checkout.createTopup({
        userId,
        amountMicros: Checkout.MAX_TOPUP_MICROS + 1,
        currency: 'SGD',
      }),
    /超过单笔上限/
  )
})

test('回调入账：余额增加，订单变 paid', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  const { orderId } = await Checkout.createTopup({
    userId,
    amountMicros: 100_000_000,
    currency: 'SGD',
  })
  const order = await Checkout.getOrder(orderId)
  const { body } = Fake.buildSignedEvent({ order })
  const event = JSON.parse(body)

  const result = await Checkout.applyPaidEvent({ event, provider: Fake })
  assert.strictEqual(result.credited, true)
  assert.strictEqual(await balanceOf(userId), 100_000_000)

  const after = await Checkout.getOrder(orderId)
  assert.strictEqual(after.status, 'paid')
  assert.ok(after.paid_at)

  const ledgerRows = await db
    .collection('billing_ledger')
    .find({ user_id: order.user_id, kind: 'topup' })
    .toArray()
  assert.strictEqual(ledgerRows.length, 1)
  assert.strictEqual(ledgerRows[0].amount_micros, 100_000_000)
  assert.strictEqual(ledgerRows[0].idempotency_key, `topup:order:${orderId}`)
})

test('重复回调：只入账一次（渠道重投是常态）', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  const { orderId } = await Checkout.createTopup({
    userId,
    amountMicros: 50_000_000,
    currency: 'SGD',
  })
  const order = await Checkout.getOrder(orderId)
  const event = JSON.parse(Fake.buildSignedEvent({ order }).body)

  const first = await Checkout.applyPaidEvent({ event, provider: Fake })
  const second = await Checkout.applyPaidEvent({ event, provider: Fake })
  const third = await Checkout.applyPaidEvent({ event, provider: Fake })

  assert.strictEqual(first.credited, true)
  assert.strictEqual(second.credited, false)
  assert.strictEqual(second.duplicate, true)
  assert.strictEqual(third.credited, false)
  assert.strictEqual(await balanceOf(userId), 50_000_000, '余额只能加一次')
})

test('并发回调：并发五次仍然只加一次', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  const { orderId } = await Checkout.createTopup({
    userId,
    amountMicros: 30_000_000,
    currency: 'SGD',
  })
  const order = await Checkout.getOrder(orderId)
  const event = JSON.parse(Fake.buildSignedEvent({ order }).body)

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      Checkout.applyPaidEvent({ event, provider: Fake }).catch(error => ({
        error: error.message,
      }))
    )
  )
  const credited = results.filter(r => r && r.credited).length
  assert.strictEqual(credited, 1, '只能有一个请求真正入账')
  assert.strictEqual(await balanceOf(userId), 30_000_000)
})

test('金额不一致：拒绝入账并留痕（绝不按回调金额加钱）', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  const { orderId } = await Checkout.createTopup({
    userId,
    amountMicros: 10_000_000,
    currency: 'SGD',
  })
  const order = await Checkout.getOrder(orderId)
  const event = JSON.parse(Fake.buildSignedEvent({ order }).body)
  // 攻击者/渠道把金额改成 100 倍
  event.data.object.amount = 1_000_000

  const result = await Checkout.applyPaidEvent({ event, provider: Fake })
  assert.strictEqual(result.credited, false)
  assert.strictEqual(result.reason, 'amount_mismatch')
  assert.strictEqual(await balanceOf(userId), 0, '一分钱都不能入账')

  const after = await Checkout.getOrder(orderId)
  assert.strictEqual(after.status, 'created', '订单应保持可重试状态')
})

test('币种不一致：拒绝入账', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  const { orderId } = await Checkout.createTopup({
    userId,
    amountMicros: 10_000_000,
    currency: 'SGD',
  })
  const order = await Checkout.getOrder(orderId)
  const event = JSON.parse(Fake.buildSignedEvent({ order }).body)
  event.data.object.currency = 'USD'

  const result = await Checkout.applyPaidEvent({ event, provider: Fake })
  assert.strictEqual(result.reason, 'currency_mismatch')
  assert.strictEqual(await balanceOf(userId), 0)
})

test('找不到订单：不入账，且标记为需人工核对', async t => {
  if (!db) return t.skip('mongo 不可用')
  const event = {
    id: 'evt_unknown',
    name: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_unknown',
        amount: 10000,
        currency: 'SGD',
        status: 'SUCCEEDED',
      },
    },
  }
  const result = await Checkout.applyPaidEvent({ event, provider: Fake })
  assert.strictEqual(result.credited, false)
  assert.strictEqual(result.reason, 'order_not_found')
})

test('充值记录按时间倒序，金额已格式化', async t => {
  if (!db) return t.skip('mongo 不可用')
  const userId = makeUserId()
  const a = await Checkout.createTopup({
    userId,
    amountMicros: 10_000_000,
    currency: 'SGD',
  })
  const b = await Checkout.createTopup({
    userId,
    amountMicros: 20_000_000,
    currency: 'SGD',
  })
  const rows = await Checkout.listOrders(userId)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].orderId, b.orderId, '最新的在前')
  assert.strictEqual(rows[1].orderId, a.orderId)
  assert.strictEqual(rows[0].amount, '20.00')
})
