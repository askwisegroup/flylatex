const { expect } = require('chai')

const CommandRunner = require('../../../app/js/LocalCommandRunner')

// 这些用例覆盖《CLSI 拆分与编译隔离》§4.6 的回归点：
// 超时必须真的杀进程组、停止必须真的生效、错误字段必须与 DockerRunner 对齐。
describe('LocalCommandRunner', function () {
  this.timeout(15000)

  const DIRECTORY = __dirname

  function run(command, timeout) {
    return new Promise(resolve => {
      const pid = CommandRunner.run(
        'project-id',
        command,
        DIRECTORY,
        null,
        timeout,
        {},
        null,
        (err, output) => resolve({ err, output, pid })
      )
    })
  }

  describe('run', function () {
    it('returns stdout on success and does not flag a timeout', async function () {
      const { err, output } = await run(['echo', 'hello'], 5000)
      expect(err).to.not.exist
      expect(output.stdout).to.equal('hello\n')
    })

    it('reports exit code 1 (chktex failure) as exited, not timedout', async function () {
      const { err } = await run(['sh', '-c', 'exit 1'], 5000)
      expect(err).to.exist
      expect(err.code).to.equal(1)
      expect(err.message).to.equal('exited')
      expect(err.timedout).to.not.equal(true)
      expect(err.terminated).to.not.equal(true)
    })

    it('kills the process group and flags timedout when the timeout is reached', async function () {
      const startedAt = Date.now()
      const { err, pid } = await run(['sleep', '30'], 300)
      const elapsed = Date.now() - startedAt

      expect(err).to.exist
      expect(err.timedout).to.equal(true)
      // 超时优先于 SIGTERM：不能同时报 terminated，否则上层状态与指标都会出错
      expect(err.terminated).to.not.equal(true)
      // 必须远早于 sleep 30s 自然结束
      expect(elapsed).to.be.below(5000)
      // 整个进程组必须已被杀干净（ESRCH = 不存在）
      expect(() => process.kill(-pid, 0)).to.throw()
    })

    it('leaves no process group behind when the command is killed', async function () {
      const result = await new Promise(resolve => {
        const pid = CommandRunner.run(
          'project-id',
          ['sleep', '30'],
          DIRECTORY,
          null,
          30000,
          {},
          null,
          (err, output) => resolve({ err, output })
        )
        setTimeout(() => {
          CommandRunner.kill(pid, err => {
            expect(err).to.not.exist
          })
        }, 100)
      })

      expect(result.err).to.exist
      expect(result.err.terminated).to.equal(true)
    })
  })

  // FIXED: 2026-11-10 CPU 隔离的端到端断言
  // 光测 CpuLimiter 的纯函数不算数 —— 真正的风险是"前缀没挂到真正的 spawn 上"
  // 或者挂了却把 pid / 进程组搞坏。这里直接读子进程自己的 nice 值，
  // 并顺带确认 detached 进程组仍然成立（超时杀组依赖它）。
  describe('cpu limiting wrapper', function () {
    it('passes the nice value through to the compile process', async function () {
      const { err, output } = await run(['sh', '-c', 'ps -o nice= -p $$'], 5000)
      expect(err).to.not.exist
      // 默认 CLSI_CPU_LIMIT_NICE=10；在 Linux 上还会有 taskset 前缀，
      // 但无论哪种平台，子进程都必须真的降到 10。
      expect(Number(output.stdout.trim())).to.equal(10)
    })

    it('keeps the compile as its own process-group leader (kill(-pid) depends on it)', function () {
      const { execSync } = require('child_process')
      const pid = CommandRunner.run(
        'project-id',
        ['sleep', '30'],
        DIRECTORY,
        null,
        60000,
        {},
        null,
        () => {}
      )
      try {
        // nice / taskset 必须 execvp 原地替换（不 fork），否则组长就变成了
        // 包装程序，pgid 与 pid 对不上，「停止编译」和超时整组杀都会落空。
        const pgid = Number(execSync(`ps -o pgid= -p ${pid}`).toString().trim())
        expect(pgid).to.equal(pid)
      } finally {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch (err) {
          // 已经退出
        }
      }
    })
  })

  describe('kill', function () {
    it('is idempotent when the process group no longer exists', function (done) {
      CommandRunner.kill(999999, err => {
        expect(err).to.not.exist
        done()
      })
    })

    it('does not throw when there is no pid', function (done) {
      CommandRunner.kill(null, err => {
        expect(err).to.not.exist
        done()
      })
    })
  })
})
