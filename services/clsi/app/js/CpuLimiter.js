// FIXED: 2026-11-10 编译进程的 CPU 硬隔离（cpuset 绑核 + nice）
//
// 背景：ConcurrencyLimiter 限的是"同时几个编译"，不是"最多几核"。
// 一个 latexmk 会长出 pdflatex / bibtex / makeindex / gnuplot / pythontex …，
// 其中任何一个都可能 fork 或开线程；几个编译叠在一起，4 核实实在在被吃干，
// web / clsi / mongod / nginx 的事件循环被饿死 —— 表现就是整站转圈。
//
// 这里做**物理隔离**：把编译进程钉到一部分核上（sched_setaffinity），
// 剩下的核完全留给 web/clsi/mongo/nginx。绑核是内核级限制，子进程、孙进程
// 全部继承，编译内部怎么 fork / 开线程都跑不出去 —— 这就是"CPU 一定不超过多少"。
//
// 为什么不用 cgroup 的 CPUQuota：容器里没有 systemd，也没有 cgroup 写权限，
// cgcreate / cgexec / systemd-run 都用不了；taskset 走 sched_setaffinity，
// 普通用户即可，且对整棵进程树生效。绑核的缺点是不按比例、只讲"哪几个核"，
// 但对 4 核这种小机器反而更好预期。
//
// nice 是软限、绑核是硬限，两者互补：万一有别的进程也被钉在同一批核上，
// nice 保证关键路径永远优先拿 CPU。
//
// 配置（env 优先，其次 Settings.clsi.cpuLimit）：
//   CLSI_CPU_LIMIT=off          关掉整套（绑核 + nice + 线程池默认值）
//   CLSI_CPU_LIMIT_CPUS=2-3     指定钉到哪些核（也接受 "2,3"）
//   CLSI_CPU_LIMIT_NICE=10      nice 值，<=0 表示不加 nice
// 不配 CPU 集合时按"后半数核心"推算：4 核 → 2-3，8 核 → 4-7，2 核 → 1。
// 推算前会先读 /proc/self/status 的 Cpus_allowed_list：容器若被 --cpuset-cpus
// 限过核（此时 os.cpus() 看到的仍是宿主核数），交集为空就自动降级为不绑核，
// 绝不让 taskset 因为"核不存在"而把编译整个跑挂。
const fs = require('fs')
const os = require('os')
const Path = require('path')
const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')

const DEFAULT_NICE = 10
const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'none', 'disabled'])

// 编译期脚本（pythontex / sagetex / numpy …）默认按核数开线程池。
// 绑核已经限住总量，但一个进程开 4 线程抢 2 核纯属浪费，默认钉成 1。
const THREAD_ENV_DEFAULTS = {
  OMP_NUM_THREADS: '1',
  OPENBLAS_NUM_THREADS: '1',
  MKL_NUM_THREADS: '1',
  NUMEXPR_NUM_THREADS: '1',
}

// "2-3,5" -> [2,3,5]；格式不对返回 null（调用方据此回退默认值）
function parseCpuList(value) {
  if (value == null || value === '') {
    return null
  }
  const text = String(value).trim()
  if (text === '') {
    return null
  }
  const cpus = []
  for (const raw of text.split(',')) {
    const part = raw.trim()
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (to < from) {
        return null
      }
      for (let cpu = from; cpu <= to; cpu++) {
        cpus.push(cpu)
      }
      continue
    }
    if (!/^\d+$/.test(part)) {
      return null
    }
    cpus.push(Number(part))
  }
  return [...new Set(cpus)].sort((a, b) => a - b)
}

// [2,3,5] -> "2-3,5"（taskset 的 --cpu-list 语法）
function formatCpuList(cpus) {
  const sorted = [...new Set(cpus)].sort((a, b) => a - b)
  const parts = []
  let start = null
  let prev = null
  for (const cpu of sorted) {
    if (start === null) {
      start = cpu
      prev = cpu
      continue
    }
    if (cpu === prev + 1) {
      prev = cpu
      continue
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = cpu
    prev = cpu
  }
  if (start !== null) {
    parts.push(start === prev ? `${start}` : `${start}-${prev}`)
  }
  return parts.join(',')
}

// 容器实际允许用的核（cgroup cpuset）。读不到就返回 null，表示"不限制"。
function readAllowedCpus(statusPath) {
  try {
    const status = fs.readFileSync(statusPath || '/proc/self/status', 'utf8')
    const line = status
      .split('\n')
      .find(l => l.startsWith('Cpus_allowed_list:'))
    if (!line) {
      return null
    }
    return parseCpuList(line.slice(line.indexOf(':') + 1))
  } catch (err) {
    return null
  }
}

function findExecutable(name, env, platform) {
  if ((platform || process.platform) !== 'linux') {
    return null
  }
  const dirs = String((env || process.env).PATH || '')
    .split(Path.delimiter)
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = Path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch (err) {
      // 继续找
    }
  }
  return null
}

// 默认取"后半数核心"：小机器上编译占一半，交互路径留一半。
function defaultCpus(usable) {
  const sorted = [...usable].sort((a, b) => a - b)
  return sorted.slice(Math.floor(sorted.length / 2))
}

function pick(envValue, settingValue) {
  return envValue !== undefined && envValue !== '' ? envValue : settingValue
}

function computePlan(opts = {}) {
  const env = opts.env || process.env
  const settings =
    opts.settings !== undefined
      ? opts.settings || {}
      : (Settings.clsi && Settings.clsi.cpuLimit) || {}
  const cpuCount = opts.cpuCount || (os.cpus() || []).length || 1
  const tasksetPath =
    opts.tasksetPath !== undefined
      ? opts.tasksetPath
      : findExecutable('taskset', env, opts.platform)
  const allowedCpus =
    opts.allowedCpus !== undefined
      ? opts.allowedCpus
      : readAllowedCpus(opts.statusPath)

  const empty = reason => ({
    enabled: false,
    reason,
    cpus: [],
    cpusText: '',
    nice: 0,
    prefix: [],
  })

  const switchValue = String(pick(env.CLSI_CPU_LIMIT, settings.enabled))
    .trim()
    .toLowerCase()
  if (OFF_VALUES.has(switchValue)) {
    return empty('disabled by CLSI_CPU_LIMIT')
  }

  const usable =
    allowedCpus && allowedCpus.length > 0
      ? allowedCpus
      : Array.from({ length: cpuCount }, (_, i) => i)

  // 容器本身已经限过核（cpuset 是全部核的真子集）说明运维已经分配好了，
  // 这时再对半砍一刀是错的：拆分部署里 clsi 容器拿到 2 核，它就该用满 2 核。
  const restricted =
    allowedCpus != null &&
    allowedCpus.length > 0 &&
    allowedCpus.length < cpuCount
  const configured = parseCpuList(pick(env.CLSI_CPU_LIMIT_CPUS, settings.cpus))
  const requested = configured || (restricted ? usable : defaultCpus(usable))
  // 容器可能被 cpuset 限过核：取交集，避免 taskset 因"核不存在"直接失败
  const cpus = requested.filter(cpu => usable.includes(cpu))
  if (cpus.length === 0) {
    return empty('no usable cpu in cpuset')
  }

  const niceRaw = pick(env.CLSI_CPU_LIMIT_NICE, settings.nice)
  const niceParsed = parseInt(niceRaw, 10)
  const nice = Number.isFinite(niceParsed) ? niceParsed : DEFAULT_NICE

  const cpusText = formatCpuList(cpus)
  const prefix = []
  if (tasksetPath) {
    prefix.push(tasksetPath, '-c', cpusText)
  }
  if (nice > 0) {
    prefix.push('nice', '-n', String(nice))
  }

  return {
    enabled: prefix.length > 0,
    reason: tasksetPath ? null : 'taskset not found, only nice applied',
    cpus,
    cpusText,
    nice,
    prefix,
  }
}

let cachedPlan = null

function plan() {
  if (cachedPlan == null) {
    cachedPlan = computePlan()
    // LOG_LEVEL=info 的生产环境也要能看见这一条：这是"CPU 到底限没限住"的唯一证据
    if (cachedPlan.enabled) {
      logger.info(
        {
          cpus: cachedPlan.cpusText,
          cores: cachedPlan.cpus.length,
          nice: cachedPlan.nice,
          wrapper: cachedPlan.prefix,
        },
        'compile cpu limits enabled'
      )
    } else {
      logger.warn(
        { reason: cachedPlan.reason },
        'compile cpu limits not applied'
      )
    }
  }
  return cachedPlan
}

function prefix() {
  return plan().prefix
}

// 可供编译同时使用的核数；未启用绑核时返回 null（表示"没有 CPU 层面的上限"）
function capacity() {
  const current = plan()
  return current.enabled && current.cpus.length > 0 ? current.cpus.length : null
}

function envDefaults() {
  return plan().enabled ? { ...THREAD_ENV_DEFAULTS } : {}
}

function resetCacheForTests() {
  cachedPlan = null
}

module.exports = {
  plan,
  prefix,
  capacity,
  envDefaults,
  computePlan,
  parseCpuList,
  formatCpuList,
  readAllowedCpus,
  findExecutable,
  resetCacheForTests,
}
