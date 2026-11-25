const { expect } = require('chai')
const CpuLimiter = require('../../../app/js/CpuLimiter')

// 这些用例锁定「编译 CPU 不超过多少核」这条底线：
//   绑核是硬限（子进程 / 孙进程全部继承），nice 是软限，两者都不能悄悄消失。
// 纯函数式测试，不 spawn 任何东西 —— 真正的端到端断言在
// LocalCommandRunnerTests 里（用 ps 读 nice 值）。
describe('CpuLimiter', function () {
  describe('parseCpuList / formatCpuList', function () {
    it('parses ranges, lists and single cores', function () {
      expect(CpuLimiter.parseCpuList('2-3')).to.deep.equal([2, 3])
      expect(CpuLimiter.parseCpuList('2,3')).to.deep.equal([2, 3])
      expect(CpuLimiter.parseCpuList('3')).to.deep.equal([3])
      expect(CpuLimiter.parseCpuList('0-1,3')).to.deep.equal([0, 1, 3])
      expect(CpuLimiter.parseCpuList(' 2 - 3 ')).to.deep.equal([2, 3])
    })

    it('returns null for junk so the caller can fall back', function () {
      expect(CpuLimiter.parseCpuList('abc')).to.equal(null)
      expect(CpuLimiter.parseCpuList('3-1')).to.equal(null)
      expect(CpuLimiter.parseCpuList(null)).to.equal(null)
      expect(CpuLimiter.parseCpuList('')).to.equal(null)
    })

    it('compacts a core list back into taskset syntax', function () {
      expect(CpuLimiter.formatCpuList([2, 3])).to.equal('2-3')
      expect(CpuLimiter.formatCpuList([2, 3, 5])).to.equal('2-3,5')
      expect(CpuLimiter.formatCpuList([0, 2])).to.equal('0,2')
      expect(CpuLimiter.formatCpuList([1])).to.equal('1')
      expect(CpuLimiter.formatCpuList([3, 1, 2])).to.equal('1-3')
    })
  })

  describe('computePlan', function () {
    const TASKSET = '/usr/bin/taskset'

    function plan(opts = {}) {
      return CpuLimiter.computePlan({
        env: {},
        settings: {},
        cpuCount: 4,
        tasksetPath: TASKSET,
        allowedCpus: [0, 1, 2, 3],
        ...opts,
      })
    }

    it('pins to the second half of a 4-core box and adds nice', function () {
      const result = plan()
      expect(result.enabled).to.equal(true)
      expect(result.cpusText).to.equal('2-3')
      expect(result.prefix).to.deep.equal([
        TASKSET,
        '-c',
        '2-3',
        'nice',
        '-n',
        '10',
      ])
    })

    it('scales to bigger boxes (8 cores -> 4-7)', function () {
      const result = plan({
        cpuCount: 8,
        allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
      })
      expect(result.cpusText).to.equal('4-7')
      expect(result.cpus.length).to.equal(4)
    })

    it('leaves at least one core for the compile on a 2-core box', function () {
      expect(plan({ cpuCount: 2, allowedCpus: [0, 1] }).cpusText).to.equal('1')
      expect(plan({ cpuCount: 1, allowedCpus: [0] }).cpusText).to.equal('0')
    })

    it('honours CLSI_CPU_LIMIT_CPUS over the derived default', function () {
      const result = plan({ env: { CLSI_CPU_LIMIT_CPUS: '0-1' } })
      expect(result.cpusText).to.equal('0-1')
      expect(result.prefix.slice(0, 3)).to.deep.equal([TASKSET, '-c', '0-1'])
    })

    it('can be switched off entirely', function () {
      const result = plan({ env: { CLSI_CPU_LIMIT: 'off' } })
      expect(result.enabled).to.equal(false)
      expect(result.prefix).to.deep.equal([])
      expect(result.reason).to.match(/disabled/)
    })

    it('drops nice when CLSI_CPU_LIMIT_NICE=0 but keeps the pin', function () {
      const result = plan({ env: { CLSI_CPU_LIMIT_NICE: '0' } })
      expect(result.cpusText).to.equal('2-3')
      expect(result.prefix).to.deep.equal([TASKSET, '-c', '2-3'])
    })

    it('falls back to nice only when taskset is missing', function () {
      const result = plan({ tasksetPath: null })
      expect(result.prefix).to.deep.equal(['nice', '-n', '10'])
      expect(result.reason).to.match(/taskset/)
    })

    it('never derives a core the container is not allowed to use', function () {
      // 容器被 --cpuset-cpus=0-1 限过核时，os.cpus() 仍然报 4 核。
      // 若照 os.cpus() 推出 2-3，taskset 会直接失败、编译全挂。
      const result = plan({ allowedCpus: [0, 1] })
      expect(result.cpusText).to.equal('0-1')
      expect(result.enabled).to.equal(true)
    })

    it('uses every allowed core when the container is already CPU-restricted', function () {
      // 拆分部署：clsi 容器被 compose 限成 cpuset 2-3。
      // 运维已经分配好了，这里再对半砍成 1 个核就是白白浪费一半算力。
      const result = plan({ allowedCpus: [2, 3] })
      expect(result.cpusText).to.equal('2-3')
      expect(result.cpus.length).to.equal(2)
    })

    it('degrades instead of failing when a configured set has no usable core', function () {
      const result = plan({
        env: { CLSI_CPU_LIMIT_CPUS: '2-3' },
        allowedCpus: [0, 1],
      })
      expect(result.enabled).to.equal(false)
      expect(result.reason).to.match(/no usable cpu/)
      expect(result.prefix).to.deep.equal([])
    })

    it('intersects a configured set with the allowed set', function () {
      const result = plan({
        env: { CLSI_CPU_LIMIT_CPUS: '0-3' },
        allowedCpus: [1, 2],
      })
      expect(result.cpusText).to.equal('1-2')
    })
  })

  describe('settings fallback', function () {
    it('reads Settings.clsi.cpuLimit when the env is empty', function () {
      const result = CpuLimiter.computePlan({
        env: {},
        settings: { cpus: '6-7', nice: 5 },
        cpuCount: 8,
        tasksetPath: '/usr/bin/taskset',
        allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7],
      })
      expect(result.cpusText).to.equal('6-7')
      expect(result.nice).to.equal(5)
    })
  })
})
