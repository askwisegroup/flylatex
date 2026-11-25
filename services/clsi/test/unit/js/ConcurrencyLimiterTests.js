const Path = require('path')
const SandboxedModule = require('sandboxed-module')
const { expect } = require('chai')
const Errors = require('../../../app/js/Errors')

const MODULE_PATH = Path.join(__dirname, '../../../app/js/ConcurrencyLimiter')

// 并发闸门的目的：满载时快速失败，而不是让编译把整机 CPU 吃满、把 web 饿死。
describe('ConcurrencyLimiter', function () {
  beforeEach(function () {
    delete process.env.CLSI_MAX_CONCURRENT_COMPILES
    this.Settings = {}
    this.cores = 4
    this.cpuCapacity = null // 未启用绑核：并发数只看核数
    this.limiter = loadLimiter(this)
  })

  afterEach(function () {
    delete process.env.CLSI_MAX_CONCURRENT_COMPILES
  })

  function loadLimiter(ctx) {
    ctx.os = { cpus: () => new Array(ctx.cores).fill({}) }
    return SandboxedModule.require(MODULE_PATH, {
      requires: {
        os: ctx.os,
        '@overleaf/settings': ctx.Settings,
        './Errors': Errors,
        './CpuLimiter': { capacity: () => ctx.cpuCapacity },
      },
    })
  }

  it('defaults to cores - 2 (leaving room for web and CLSI itself)', function () {
    expect(this.limiter.getLimit()).to.equal(2) // 4 核 → 2
  })

  it('never goes below 1 on a tiny machine', function () {
    this.cores = 2
    this.limiter = loadLimiter(this)
    expect(this.limiter.getLimit()).to.equal(1)
  })

  // FIXED: 2026-11-10 并发数与「编译能用的核数」对齐
  it('clamps the derived default to the number of cores compiles may use', function () {
    this.cores = 8 // 8 核按 cores-2 推出 6
    this.cpuCapacity = 3 // 但绑核只给了 3 个核
    this.limiter = loadLimiter(this)
    expect(this.limiter.getLimit()).to.equal(3)
  })

  it('lets an explicit limit exceed the cpu budget (operator knows best)', function () {
    process.env.CLSI_MAX_CONCURRENT_COMPILES = '5'
    this.cpuCapacity = 2
    expect(this.limiter.getLimit()).to.equal(5)
  })

  it('honours CLSI_MAX_CONCURRENT_COMPILES', function () {
    process.env.CLSI_MAX_CONCURRENT_COMPILES = '5'
    expect(this.limiter.getLimit()).to.equal(5)
  })

  it('honours Settings.clsi.maxConcurrentCompiles', function () {
    this.Settings.clsi = { maxConcurrentCompiles: 7 }
    expect(this.limiter.getLimit()).to.equal(7)
  })

  it('rejects with an overloaded error once full', function () {
    const a = this.limiter.tryAcquire()
    const b = this.limiter.tryAcquire()
    expect(a.ok).to.equal(true)
    expect(b.ok).to.equal(true)

    const c = this.limiter.tryAcquire()
    expect(c.ok).to.equal(false)
    expect(c.error).to.be.instanceOf(Errors.QueueLimitReachedError)
    expect(c.error.overloaded).to.equal(true)
    expect(c.error.retryAfter).to.be.a('number')
  })

  it('frees a slot on release, and release is idempotent', function () {
    const a = this.limiter.tryAcquire()
    this.limiter.tryAcquire()
    expect(this.limiter.tryAcquire().ok).to.equal(false)

    a.release()
    a.release() // 重复释放不能把计数减成负数

    expect(this.limiter.stats().inFlight).to.equal(1)
    expect(this.limiter.tryAcquire().ok).to.equal(true)
  })

  it('reports in-flight and limit', function () {
    this.limiter.tryAcquire()
    expect(this.limiter.stats()).to.deep.equal({ inFlight: 1, limit: 2 })
  })
})
