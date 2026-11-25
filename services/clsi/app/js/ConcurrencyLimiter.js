// FIXED: 2026-11-03 编译并发准入（架构闸门）
//
// 之前编译请求来多少接多少：一次高峰（或几个大项目同时编译）就能把整机 CPU 吃满，
// web / nginx / CLSI 自身的事件循环跟着被饿死 → 整站无响应，只能重启。
// 现在满载时立刻拒绝（web 侧 ClsiManager 已把 503 映射为 unavailable），
// 把「慢死」变成「快速失败」：整站仍可用，用户看到的是"编译器忙，请稍后重试"。
//
// 上限取值：优先 CLSI_MAX_CONCURRENT_COMPILES / Settings.clsi.maxConcurrentCompiles，
// 否则按核数推算（留 2 核给 web 与 CLSI 自身）。一个 latexmk ≈ 1 核。
const os = require('os')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const Errors = require('./Errors')
const CpuLimiter = require('./CpuLimiter')

const RETRY_AFTER_SECONDS = 5

let warnedOverSubscription = false

function getLimit() {
  const configured =
    process.env.CLSI_MAX_CONCURRENT_COMPILES ||
    (Settings.clsi != null ? Settings.clsi.maxConcurrentCompiles : undefined)
  const parsed = parseInt(configured, 10)
  const cpuCapacity = CpuLimiter.capacity()
  if (Number.isFinite(parsed) && parsed > 0) {
    // 显式配置就照办（可能是有意超卖，比如文档说编译都很轻），但留个痕迹：
    // 否则「为什么 6 个编译在抢 2 个核」现场没人查得出来
    if (
      cpuCapacity != null &&
      parsed > cpuCapacity &&
      !warnedOverSubscription
    ) {
      warnedOverSubscription = true
      logger.warn(
        { limit: parsed, cpuCapacity },
        'max concurrent compiles exceeds the cpu budget, compiles will queue on fewer cores'
      )
    }
    return parsed
  }
  const cores = (os.cpus() || []).length || 2
  let limit = Math.max(1, cores - 2)
  // FIXED: 2026-11-10 自动推导的并发数不超过「编译能用的核数」。
  //   绑核已经保证 CPU 总量不超额（超了只是各自变慢），但把 6 个编译塞进
  //   2 个核，每个都慢 3 倍 → 全部撞超时，等于自己把自己拖死。
  //   容量和并发用同一个数，最省事也最自洽。
  if (cpuCapacity != null && limit > cpuCapacity) {
    limit = cpuCapacity
  }
  return limit
}

let inFlight = 0

// 非阻塞获取：拿不到就返回错误，不排队。
// 排队只会让每个请求都变慢、超时值更难判断，而且队列本身就是内存压力。
function tryAcquire() {
  const limit = getLimit()
  if (inFlight >= limit) {
    const error = new Errors.QueueLimitReachedError(
      'compile capacity reached, please retry',
      { inFlight, limit }
    )
    error.overloaded = true
    error.retryAfter = RETRY_AFTER_SECONDS
    return { ok: false, error }
  }

  inFlight++
  let released = false
  return {
    ok: true,
    release() {
      if (released) {
        return
      }
      released = true
      inFlight--
    },
  }
}

function stats() {
  return { inFlight, limit: getLimit() }
}

module.exports = { tryAcquire, stats, getLimit }
