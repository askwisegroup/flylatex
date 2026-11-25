// FIXED: 2026-11-05 启动时清理上一轮遗留的编译进程组
//
// 背景：编译是以 detached 方式启动的（latexmk 成为独立进程组的组长），
// 只有这样「超时 / 停止编译」才能用 process.kill(-pid) 整组杀干净（见
// LocalCommandRunner）。代价是：CLSI 的 node 进程如果不是正常退出
// （runit `sv restart clsi-sharelatex`、OOM、崩溃），正在跑的进程组会被
// init 收养继续吃 CPU，而 ProcessTable 是内存表，重启后就不知道它们是谁、
// 属于哪个项目 —— 只能靠重启整个容器。
//
// 这里是那道兜底：启动时（还没开始接受编译请求）扫一遍 /proc，
// 把本机仍存活、且组长就是 latexmk 的进程组 SIGKILL 掉。
//
// 安全性：
//   - 只在 Linux 上做（依赖 /proc）；
//   - dockerRunner 模式跳过（一次性容器由 docker 自己回收）；
//   - 只处理「组长的 pid == 自己的 pgid」的进程，也就是我们自己 detached
//     启动的那种进程组；别人的普通进程就算命令里带 latexmk 也不会被牵连；
//   - 跳过僵死进程（Z），它们已经不占 CPU，杀了也没意义。
const fs = require('fs')
const Path = require('path')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')

// 我们启动的命令首进程（_buildLatexCommand 里固定是 latexmk，
// 配了 strace / latexmkCommandPrefix 时它只是命令行里的某一个参数）
const COMPILER_BINARIES = new Set(['latexmk'])

// /proc/<pid>/stat 的 comm 字段可能含空格和括号，取最后一个 ')' 之后的部分：
// 剩余字段依次是 state, ppid, pgrp, session, ...
function parseStat(stat) {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return {
    state: rest[0],
    ppid: Number(rest[1]),
    pgid: Number(rest[2]),
  }
}

function readArgv(procDir, pid) {
  const raw = fs.readFileSync(Path.join(procDir, pid, 'cmdline'), 'utf8')
  return raw.split('\0').filter(Boolean)
}

function isCompileCommand(argv) {
  return argv.some(arg => COMPILER_BINARIES.has(Path.basename(arg)))
}

function reapStaleCompiles(opts = {}) {
  const platform = opts.platform || process.platform
  const procDir = opts.procDir || '/proc'
  const kill = opts.kill || process.kill
  const dockerRunner =
    opts.dockerRunner !== undefined
      ? opts.dockerRunner
      : Boolean(Settings.clsi?.dockerRunner)
  const result = { killed: [] }

  if (platform !== 'linux' || dockerRunner) {
    return result
  }

  let entries
  try {
    entries = fs.readdirSync(procDir)
  } catch (err) {
    // 没有 /proc（裁剪过的镜像）不该影响启动
    logger.warn({ err }, 'cannot scan for stale compiles, skipping')
    return result
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    const pid = Number(entry)
    if (pid === process.pid) {
      continue
    }
    let argv, stat
    try {
      argv = readArgv(procDir, entry)
      stat = parseStat(fs.readFileSync(Path.join(procDir, entry, 'stat'), 'utf8'))
    } catch (err) {
      continue // 进程在这期间退出了
    }
    if (!isCompileCommand(argv)) {
      continue
    }
    if (stat.pgid !== pid) {
      continue // 不是进程组组长，不是我们 spawn 出来的东西
    }
    if (stat.state === 'Z') {
      continue
    }
    try {
      kill(-pid, 'SIGKILL') // 整个组：latexmk + pdflatex / bibtex / makeindex ...
      result.killed.push({ pid, command: argv.join(' ').slice(0, 120) })
    } catch (err) {
      if (err.code !== 'ESRCH') {
        logger.warn({ err, pid }, 'failed to reap stale compile process group')
      }
    }
  }

  if (result.killed.length > 0) {
    logger.warn(
      { count: result.killed.length, killed: result.killed },
      'reaped stale compile process groups left by the previous run'
    )
  } else {
    logger.debug('no stale compile process groups found')
  }
  return result
}

module.exports = { reapStaleCompiles, parseStat, isCompileCommand }
