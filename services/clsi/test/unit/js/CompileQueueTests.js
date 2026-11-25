const Path = require('path')
const SandboxedModule = require('sandboxed-module')
const { expect } = require('chai')
const Errors = require('../../../app/js/Errors')

const MODULE_PATH = Path.join(__dirname, '../../../app/js/CompileQueue')

// 编译队列的目的：满载时不要立刻把用户拒掉，而是让请求排一会儿；
// VIP（priority 组）先出队，但普通用户不会被无限期饿死。
describe('CompileQueue', function () {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  beforeEach(function () {
    this.limit = 2
    this.inFlight = 0
    this.Settings = { clsi: {} }
    this.metricsCalls = []
    this.queue = loadQueue(this)
  })

  afterEach(function () {
    delete process.env.CLSI_MAX_CONCURRENT_COMPILES
    delete process.env.CLSI_MAX_QUEUE_LENGTH
    delete process.env.CLSI_MAX_QUEUE_WAIT_MS
    delete process.env.CLSI_QUEUE_AGING_MS
    delete process.env.CLSI_QUEUE_ENABLED
  })

  /**
   * ConcurrencyLimiter 用假实现替掉：容量记账在这里模拟，
   * 便于断言「队列不重复计数」。
   */
  function loadQueue(ctx) {
    const limiter = {
      getLimit: () => ctx.limit,
      stats: () => ({ inFlight: ctx.inFlight, limit: ctx.limit }),
      tryAcquire() {
        if (ctx.inFlight >= ctx.limit) {
          const error = new Errors.QueueLimitReachedError(
            'compile capacity reached, please retry'
          )
          error.overloaded = true
          error.retryAfter = 5
          return { ok: false, error }
        }
        ctx.inFlight++
        let released = false
        return {
          ok: true,
          release() {
            if (released) return
            released = true
            ctx.inFlight--
          },
        }
      },
    }
    ctx.limiter = limiter
    return SandboxedModule.require(MODULE_PATH, {
      requires: {
        '@overleaf/settings': ctx.Settings,
        '@overleaf/logger': {
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
        '@overleaf/metrics': {
          inc(...args) {
            ctx.metricsCalls.push(['inc', ...args])
          },
          timing(...args) {
            ctx.metricsCalls.push(['timing', ...args])
          },
        },
        './Errors': Errors,
        './ConcurrencyLimiter': limiter,
      },
    })
  }

  describe('when capacity is available', function () {
    it('hands out a slot without queueing', async function () {
      const slot = await this.queue.acquire('standard')
      expect(slot.queued).to.equal(false)
      expect(this.limiter.stats().inFlight).to.equal(1)
      expect(this.queue.queueLength()).to.equal(0)
      slot.release()
      expect(this.limiter.stats().inFlight).to.equal(0)
    })
  })

  describe('when capacity is exhausted', function () {
    beforeEach(async function () {
      this.held = [await this.queue.acquire('standard'), await this.queue.acquire('priority')]
      expect(this.limiter.stats().inFlight).to.equal(2)
    })

    afterEach(function () {
      for (const slot of this.held) slot.release()
    })

    it('queues the next request instead of rejecting it', async function () {
      const pending = this.queue.acquire('standard')
      await sleep(0)
      expect(this.queue.queueLength()).to.equal(1)
      this.held[0].release()
      const slot = await pending
      expect(slot.queued).to.equal(true)
      slot.release()
    })

    it('starts priority waiters before standard waiters', async function () {
      const order = []
      const mk = group =>
        this.queue.acquire(group).then(slot => {
          order.push(group)
          slot.release()
        })
      const standardFirst = mk('standard')
      const priority = mk('priority')
      await sleep(0)
      // 释放一个槽位后，拿到槽位者立刻归还，会连锁唤醒下一个，
      // 所以这里只能断言「谁先被唤醒」，不断言总长度
      this.held[0].release()
      await sleep(5)
      expect(order[0]).to.equal('priority')
      await Promise.all([standardFirst, priority])
      expect(order).to.deep.equal(['priority', 'standard'])
    })

    it('lets a long-waiting standard request overtake priority (aging)', async function () {
      // agingMs() 每次出队时读 env，不需要重新加载模块
      process.env.CLSI_QUEUE_AGING_MS = '0'
      const held = this.held
      const order = []
      const mk = group =>
        this.queue.acquire(group).then(slot => {
          order.push(group)
          slot.release()
        })
      const standard = mk('standard')
      await sleep(2)
      const priority = mk('priority')
      await sleep(2)
      held[0].release()
      await sleep(5)
      expect(order[0]).to.equal('standard')
      await Promise.all([standard, priority])
      expect(order).to.deep.equal(['standard', 'priority'])
    })

    it('caps the queue length', async function () {
      process.env.CLSI_MAX_QUEUE_LENGTH = '3'
      const pending = []
      for (let i = 0; i < 3; i++) {
        pending.push(this.queue.acquire('standard').catch(err => err))
      }
      await sleep(0)
      expect(this.queue.queueLength()).to.equal(3)

      let error = null
      try {
        await this.queue.acquire('standard')
      } catch (err) {
        error = err
      }
      expect(error).to.be.instanceOf(Errors.QueueLimitReachedError)
      expect(error.queueReason).to.equal('full')
      expect(error.overloaded).to.equal(true)
      expect(error.retryAfter).to.equal(5)

      // 收尾：释放槽位，排队的请求会依次拿到槽位并自行释放
      for (const p of pending) {
        p.then(slot => {
          if (slot && slot.release) slot.release()
        })
      }
      this.held[0].release()
      this.held[1].release()
      await sleep(20)
    })

    it('rejects a waiter that waited too long', async function () {
      process.env.CLSI_MAX_QUEUE_WAIT_MS = '20'
      const startedAt = Date.now()
      let error = null
      try {
        await this.queue.acquire('standard')
      } catch (err) {
        error = err
      }
      expect(error).to.be.instanceOf(Errors.QueueLimitReachedError)
      expect(error.queueReason).to.equal('timeout')
      expect(Date.now() - startedAt).to.be.at.least(15)
      expect(this.queue.queueLength()).to.equal(0)
    })

    it('falls back to fail-fast when the queue is disabled', async function () {
      process.env.CLSI_QUEUE_ENABLED = 'false'
      const startedAt = Date.now()
      let error = null
      try {
        await this.queue.acquire('priority')
      } catch (err) {
        error = err
      }
      expect(error).to.be.instanceOf(Errors.QueueLimitReachedError)
      expect(error.overloaded).to.equal(true)
      expect(Date.now() - startedAt).to.be.below(20)
      expect(this.queue.queueLength()).to.equal(0)
    })
  })

  describe('group normalisation', function () {
    it('only treats priority as privileged', function () {
      expect(this.queue.normalizeGroup('priority')).to.equal('priority')
      expect(this.queue.normalizeGroup('alpha')).to.equal('standard')
      expect(this.queue.normalizeGroup(undefined)).to.equal('standard')
    })
  })

  describe('stats', function () {
    it('reports queue depth per group', async function () {
      const held = [
        await this.queue.acquire('standard'),
        await this.queue.acquire('standard'),
      ]
      const pending = [
        this.queue.acquire('priority').catch(err => err),
        this.queue.acquire('standard').catch(err => err),
      ]
      await sleep(0)
      const stats = this.queue.stats()
      expect(stats.queued).to.equal(2)
      expect(stats.queuedPriority).to.equal(1)
      expect(stats.queuedStandard).to.equal(1)
      expect(stats.queueLimit).to.equal(10)
      for (const slot of held) slot.release()
      for (const p of pending) {
        p.then(slot => {
          if (slot && slot.release) slot.release()
        })
      }
      await sleep(10)
    })
  })
})
