const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const Path = require('path')

const {
  reapStaleCompiles,
  parseStat,
  isCompileCommand,
} = require('../../../app/js/StaleCompileReaper')

// 覆盖《CLSI 拆分与编译隔离》里的孤儿进程场景：
// CLSI 被 sv restart / OOM 杀掉后，detached 的 latexmk 进程组会被 init 收养，
// 下次启动必须把它们清掉；同时不能误杀非组长的普通进程。
describe('StaleCompileReaper', function () {
  let procDir

  function fakeProcess(pid, { argv, pgid, state = 'S', ppid = 1 }) {
    const dir = Path.join(procDir, String(pid))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(Path.join(dir, 'cmdline'), argv.join('\0') + '\0')
    // 真实 stat 形如: 123 (latexmk) S 1 123 123 0 -1 ...
    fs.writeFileSync(
      Path.join(dir, 'stat'),
      `${pid} (${Path.basename(argv[0])}) ${state} ${ppid} ${pgid} ${pgid} 0 -1 0 0`
    )
  }

  function statOf(pid) {
    return fs.readFileSync(Path.join(procDir, String(pid), 'stat'), 'utf8')
  }

  beforeEach(function () {
    procDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'reaper-'))
    fs.mkdirSync(Path.join(procDir, 'self'), { recursive: true }) // 非数字目录应被忽略
  })

  afterEach(function () {
    fs.rmSync(procDir, { recursive: true, force: true })
  })

  describe('parseStat', function () {
    it('reads state/ppid/pgid after the comm field', function () {
      const stat = '4242 (latexmk (old)) S 1 4242 4242 0 -1 0 0'
      expect(parseStat(stat)).to.deep.equal({
        state: 'S',
        ppid: 1,
        pgid: 4242,
      })
    })
  })

  describe('isCompileCommand', function () {
    it('matches latexmk anywhere in argv (strace / prefix 场景)', function () {
      expect(isCompileCommand(['latexmk', '-cd'])).to.equal(true)
      expect(
        isCompileCommand(['strace', '-o', 'strace', '-ff', 'latexmk', '-cd'])
      ).to.equal(true)
      expect(isCompileCommand(['/usr/bin/latexmk'])).to.equal(true)
      expect(isCompileCommand(['sleep', '800'])).to.equal(false)
    })
  })

  describe('reapStaleCompiles', function () {
    it('kills the whole group of a leftover compile leader', function () {
      fakeProcess(4242, { argv: ['latexmk', '-cd', '-jobname=output'], pgid: 4242 })
      const killed = []
      const result = reapStaleCompiles({
        platform: 'linux',
        procDir,
        dockerRunner: false,
        kill: (target, signal) => killed.push({ target, signal }),
      })

      expect(killed).to.deep.equal([{ target: -4242, signal: 'SIGKILL' }])
      expect(result.killed).to.have.length(1)
      expect(result.killed[0].pid).to.equal(4242)
    })

    it('ignores non-leader latexmk processes (别人的普通进程)', function () {
      fakeProcess(4300, { argv: ['latexmk'], pgid: 4200 })
      const killed = []
      reapStaleCompiles({
        platform: 'linux',
        procDir,
        dockerRunner: false,
        kill: (target, signal) => killed.push({ target, signal }),
      })
      expect(killed).to.deep.equal([])
    })

    it('ignores zombies and non-compile processes', function () {
      fakeProcess(4301, { argv: ['latexmk'], pgid: 4301, state: 'Z' })
      fakeProcess(4302, { argv: ['sleep', '800'], pgid: 4302 })
      const killed = []
      reapStaleCompiles({
        platform: 'linux',
        procDir,
        dockerRunner: false,
        kill: (target, signal) => killed.push({ target, signal }),
      })
      expect(killed).to.deep.equal([])
    })

    it('does nothing off Linux or with the docker runner', function () {
      fakeProcess(4242, { argv: ['latexmk'], pgid: 4242 })
      const killed = []
      const kill = target => killed.push(target)

      expect(
        reapStaleCompiles({ platform: 'darwin', procDir, kill }).killed
      ).to.deep.equal([])
      expect(
        reapStaleCompiles({
          platform: 'linux',
          procDir,
          dockerRunner: true,
          kill,
        }).killed
      ).to.deep.equal([])
      expect(killed).to.deep.equal([])
    })

    it('swallows ESRCH (组已消失) and keeps going', function () {
      fakeProcess(4242, { argv: ['latexmk'], pgid: 4242 })
      fakeProcess(4243, { argv: ['latexmk'], pgid: 4243 })
      const targets = []
      const result = reapStaleCompiles({
        platform: 'linux',
        procDir,
        dockerRunner: false,
        kill: target => {
          targets.push(target)
          if (target === -4242) {
            const err = new Error('no such process')
            err.code = 'ESRCH'
            throw err
          }
        },
      })
      expect(targets).to.deep.equal([-4242, -4243])
      expect(result.killed.map(k => k.pid)).to.deep.equal([4243])
    })

    it('does not touch entries whose stat cannot be read', function () {
      fs.mkdirSync(Path.join(procDir, '4244'), { recursive: true })
      fs.writeFileSync(Path.join(procDir, '4244', 'cmdline'), 'latexmk\0')
      // 故意不写 stat
      const killed = []
      const result = reapStaleCompiles({
        platform: 'linux',
        procDir,
        dockerRunner: false,
        kill: target => killed.push(target),
      })
      expect(result.killed).to.deep.equal([])
      expect(killed).to.deep.equal([])
      expect(statOf).to.be.a('function')
    })
  })
})
