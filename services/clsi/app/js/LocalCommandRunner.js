/* eslint-disable
    no-return-assign,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let CommandRunner
const { spawn } = require('child_process')
const { promisify } = require('util')
const _ = require('lodash')
const logger = require('@overleaf/logger')
// FIXED: 2026-11-10 所有编译子进程统一钉核 + nice（见 CpuLimiter 顶部说明）
const CpuLimiter = require('./CpuLimiter')

logger.debug('using standard command runner')

// FIXED: 2026-11-03 超时与「停止编译」真正生效
// 之前的问题（分离 web/clsi 前后都一样）：
//   1) run() 完全忽略 timeout 参数，病态项目（\loop、超大 TikZ）能永久占核；
//   2) spawn 缺 detached，子进程与 node 同进程组，kill() 的 process.kill(-pid)
//      按 PGID 查找必然 ESRCH → 「停止编译」全链路失效。
// 两处必须一起修，只加定时器是无效的（杀不掉）。

// SIGTERM 之后再等多久发 SIGKILL（与超时共用同一套升级逻辑）
const KILL_GRACE_MS = 10 * 1000

// pid -> SIGKILL 兜底定时器。进程正常退出时必须清除，
// 否则 pid 被复用后可能杀到无关进程组。
const sigkillTimers = new Map()

function escalateToSigkill(pid) {
  if (sigkillTimers.has(pid)) {
    return
  }
  const timer = setTimeout(() => {
    sigkillTimers.delete(pid)
    try {
      process.kill(-pid, 'SIGKILL') // 整个进程组（latexmk + pdflatex/bibtex/...）
    } catch (err) {
      // 进程组已经不存在，正常情况（SIGTERM 已生效）
    }
  }, KILL_GRACE_MS)
  timer.unref()
  sigkillTimers.set(pid, timer)
}

function clearSigkillTimer(pid) {
  const timer = sigkillTimers.get(pid)
  if (timer) {
    clearTimeout(timer)
    sigkillTimers.delete(pid)
  }
}

module.exports = CommandRunner = {
  run(
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    callback
  ) {
    let key, value
    callback = _.once(callback)
    command = Array.from(command).map(arg =>
      arg.toString().replace('$COMPILE_DIR', directory)
    )
    // FIXED: 2026-11-10 编译前挂上任务集前缀（taskset -c … nice -n …）。
    //   taskset / nice 都是 execvp 原地替换，不 fork：pid 不变，
    //   所以 detached 进程组、「停止编译」的 kill(-pid)、
    //   StaleCompileReaper 认组长的逻辑全都不受影响。
    const argv = CpuLimiter.prefix().concat(command)
    logger.debug({ projectId, command: argv, directory }, 'running command')
    // FIXED: 2026-11-03 超时已生效，这条警告不再准确（仍无沙箱，保留可观测性）
    // OLD: logger.warn('timeouts and sandboxing are not enabled with CommandRunner')
    logger.debug(
      { projectId, timeout },
      'command runner: sandboxing is not enabled'
    )

    // merge environment settings
    const env = {}
    for (key in process.env) {
      value = process.env[key]
      env[key] = value
    }
    // FIXED: 2026-11-10 线程池默认值（OMP/OpenBLAS/MKL…=1）：绑核限的是总量，
    //   单个进程再开 4 个线程去抢 2 核只是互相伤害。请求自带的环境变量优先。
    const envBase = CpuLimiter.envDefaults()
    for (key in envBase) {
      if (env[key] == null) {
        env[key] = envBase[key]
      }
    }
    for (key in environment) {
      value = environment[key]
      env[key] = value
    }

    // run command as detached process so it has its own process group (which can be killed if needed)
    const proc = spawn(argv[0], argv.slice(1), {
      cwd: directory,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      // FIXED: 2026-11-03 必须有 detached，子进程才会成为独立进程组组长，
      //   否则 process.kill(-pid) 按 PGID 查找必然 ESRCH（注释早就写了，代码里却漏了）
      // OLD: 无 detached 选项
      detached: true,
    })

    const pid = proc.pid

    let stdout = ''
    proc.stdout.setEncoding('utf8').on('data', data => (stdout += data))

    // FIXED: 2026-11-03 墙钟超时（timeout 单位是毫秒，由 RequestParser 从秒换算而来）
    let timedOut = false
    let timeoutTimer = null
    if (pid && timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        logger.warn(
          { projectId, pid, timeout },
          'compile timeout reached, killing process group'
        )
        try {
          process.kill(-pid, 'SIGTERM')
        } catch (err) {
          // 已退出
        }
        escalateToSigkill(pid)
      }, timeout)
      timeoutTimer.unref()
    }

    // 收尾：清定时器（超时定时器 + SIGKILL 兜底），避免 pid 复用时误杀
    const settle = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      // FIXED: 2026-11-05 超时场景不要清掉 SIGKILL 兜底：
      //   组长可能在忽略 SIGTERM 后自己先退出（close 提前触发），
      //   而组里其它进程（pdflatex/bibtex）还在跑。留着兜底，10s 后再整组 SIGKILL 一次；
      //   组已消失时 process.kill 抛 ESRCH，被兜底里的 try/catch 吞掉，无副作用。
      // OLD: clearSigkillTimer(pid)
      if (!timedOut) {
        clearSigkillTimer(pid)
      }
    }

    proc.on('error', function (err) {
      settle()
      logger.err(
        { err, projectId, command, directory },
        'error running command'
      )
      return callback(err)
    })

    proc.on('close', function (code, signal) {
      settle()
      let err
      logger.debug({ code, signal, timedOut, projectId }, 'command exited')
      // FIXED: 2026-11-03 超时判定优先于 SIGTERM：
      //   超时时我们主动发 SIGTERM，若先判 signal 会被误报成 terminated（状态错、指标不计数）
      if (timedOut) {
        err = new Error('compile timed out')
        err.timedout = true
        // FIXED: 2026-11-03 把实际生效的超时值（毫秒）带出去，
        //   上层要回传给前端/打日志，否则只知道“超时了”，不知道是 300 还是 600 秒
        err.timeout = timeout
        return callback(err)
      } else if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        // signal from kill method below
        err = new Error('terminated')
        err.terminated = true
        return callback(err)
      } else if (code === 1) {
        // exit status from chktex
        err = new Error('exited')
        err.code = code
        return callback(err)
      } else {
        return callback(null, { stdout })
      }
    })

    return proc.pid
  }, // return process id to allow job to be killed if necessary

  kill(pid, callback) {
    if (callback == null) {
      callback = function () {}
    }
    if (!pid) {
      return callback()
    }
    try {
      process.kill(-pid) // kill all processes in group
    } catch (err) {
      // FIXED: 2026-11-03 进程组已不存在（ESRCH）视为成功：停止是幂等操作，
      //   否则连点两次「停止编译」第二次会报 500（用户看到的就是「点了没反应」）
      // OLD: return callback(err)
      if (err.code === 'ESRCH') {
        clearSigkillTimer(pid)
        return callback()
      }
      return callback(err)
    }
    // FIXED: 2026-11-03 SIGTERM 是「请求退出」不是「立刻死」，10s 后仍未退出则 SIGKILL
    escalateToSigkill(pid)
    return callback()
  },
}

module.exports.promises = {
  run: promisify(CommandRunner.run),
  kill: promisify(CommandRunner.kill),
}
