// FIXED: 2026-11 编译排队（在 ConcurrencyLimiter 的「满载即拒」之上加一层有界队列）
//
// 背景：ConcurrencyLimiter 满载时直接 503，用户看到「编译器忙，请稍后重试」。
// 高峰期普通用户和 VIP 一起被拒，谁也编不了；而其实只要多等十几秒就能排上。
//
// 现在的模型：
//   同时编译数 = ConcurrencyLimiter.getLimit()（保持原值，不超卖 CPU）
//   等待队列长度上限 = CLSI_MAX_QUEUE_LENGTH（默认 10，全局共享）
//   单个请求最长排队 = CLSI_MAX_QUEUE_WAIT_MS（默认 90s）
//   出队顺序：priority 组（VIP）优先；同组 FIFO；
//            standard 组头部等待超过 CLSI_QUEUE_AGING_MS（默认 30s）则插到 priority 前面，
//            防止 VIP 持续涌入把普通用户饿死。
//
// 队列满 / 排太久 → 仍然 503（error.overloaded = true，沿用 CompileController 的
// status='overloaded' 映射），只是把「立刻拒」变成「排不上才拒」。
//
// 关闭队列（回到旧的快速失败）：CLSI_QUEUE_ENABLED=false
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const Metrics = require('@overleaf/metrics')
const Errors = require('./Errors')
const ConcurrencyLimiter = require('./ConcurrencyLimiter')

const DEFAULT_MAX_QUEUE_LENGTH = 10
const DEFAULT_MAX_WAIT_MS = 90 * 1000
const DEFAULT_AGING_MS = 30 * 1000
const RETRY_AFTER_SECONDS = 5

const PRIVILEGED_GROUP = 'priority'
const DEFAULT_GROUP = 'standard'

// 每个组的等待队列（FIFO）。privileged 组先出队。
const waiters = {
  [PRIVILEGED_GROUP]: [],
  [DEFAULT_GROUP]: [],
}

let enqueuedTotal = 0

function intFromEnv(name, fallback) {
  const parsed = parseInt(process.env[name], 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function clsiSetting(key) {
  return Settings.clsi != null ? Settings.clsi[key] : undefined
}

function isDisabled() {
  const flag = process.env.CLSI_QUEUE_ENABLED
  if (flag == null || flag === '') {
    return false
  }
  return ['false', '0', 'off', 'no'].includes(String(flag).toLowerCase())
}

function maxQueueLength() {
  const configured = clsiSetting('maxQueueLength')
  return intFromEnv('CLSI_MAX_QUEUE_LENGTH', Number.isFinite(configured) ? configured : DEFAULT_MAX_QUEUE_LENGTH)
}

function maxWaitMs() {
  const configured = clsiSetting('maxQueueWaitMs')
  return intFromEnv('CLSI_MAX_QUEUE_WAIT_MS', Number.isFinite(configured) ? configured : DEFAULT_MAX_WAIT_MS)
}

function agingMs() {
  const configured = clsiSetting('queueAgingMs')
  return intFromEnv('CLSI_QUEUE_AGING_MS', Number.isFinite(configured) ? configured : DEFAULT_AGING_MS)
}

/**
 * 只把 priority 当特权组，别的值（alpha / 未知值）都按普通组处理：
 * 免得部署方随手加了 compileGroup 就把普通用户饿死。
 */
function normalizeGroup(group) {
  return group === PRIVILEGED_GROUP ? PRIVILEGED_GROUP : DEFAULT_GROUP
}

function queueLength() {
  return waiters[PRIVILEGED_GROUP].length + waiters[DEFAULT_GROUP].length
}

function oldestWaitMs() {
  let oldest = 0
  const now = Date.now()
  for (const group of [PRIVILEGED_GROUP, DEFAULT_GROUP]) {
    const head = waiters[group][0]
    if (head != null) {
      oldest = Math.max(oldest, now - head.enqueuedAt)
    }
  }
  return oldest
}

function stats() {
  return {
    ...ConcurrencyLimiter.stats(),
    queued: queueLength(),
    queuedPriority: waiters[PRIVILEGED_GROUP].length,
    queuedStandard: waiters[DEFAULT_GROUP].length,
    queueLimit: maxQueueLength(),
    oldestWaitMs: oldestWaitMs(),
  }
}

function overloadError(reason, message, info) {
  const error = new Errors.QueueLimitReachedError(message, info)
  error.overloaded = true
  error.retryAfter = RETRY_AFTER_SECONDS
  error.queueReason = reason
  return error
}

function removeWaiter(waiter) {
  const queue = waiters[waiter.group]
  const index = queue.indexOf(waiter)
  if (index !== -1) {
    queue.splice(index, 1)
  }
}

/**
 * 出队：priority 优先，但 standard 头部等太久（老化）就插队，
 * 保证普通用户在 VIP 持续涌入时也不会无限等。
 */
function pickNext() {
  const privileged = waiters[PRIVILEGED_GROUP][0]
  const standard = waiters[DEFAULT_GROUP][0]
  if (privileged == null && standard == null) {
    return null
  }
  if (privileged == null) {
    return waiters[DEFAULT_GROUP].shift()
  }
  if (standard != null && Date.now() - standard.enqueuedAt >= agingMs()) {
    return waiters[DEFAULT_GROUP].shift()
  }
  return waiters[PRIVILEGED_GROUP].shift()
}

/**
 * 有槽位空出来时，把等待者按顺序唤醒。
 * 容量仍然由 ConcurrencyLimiter 记账（这里只做排队，不重复计数）。
 */
function drain() {
  if (isDisabled()) {
    return
  }
  for (;;) {
    if (queueLength() === 0) {
      return
    }
    const slot = ConcurrencyLimiter.tryAcquire()
    if (!slot.ok) {
      return
    }
    const next = pickNext()
    if (next == null) {
      // 理论上不会发生（上面已确认有等待者），保守起见把槽位还回去
      slot.release()
      return
    }
    next.settled = true
    clearTimeout(next.timer)
    const waitedMs = Date.now() - next.enqueuedAt
    const queuedSlot = makeSlot(next.group, slot)
    queuedSlot.queued = true
    Metrics.timing('compile-queue-wait', waitedMs, 1, next.metricsOpts)
    if (waitedMs > 0) {
      logger.debug(
        { group: next.group, waitedMs, ...stats() },
        'compile starts after queueing'
      )
    }
    next.resolve(queuedSlot)
  }
}

function makeSlot(group, slot) {
  return {
    group,
    queued: false,
    release() {
      // 先还容量，再唤醒等待者，避免「还了但没人被唤醒」的窗口
      slot.release()
      drain()
    },
  }
}

/**
 * 获取一个编译槽位：有空位直接给，否则排队。
 * 队列满或排队超时 → reject(QueueLimitReachedError)，调用方按 overloaded 处理。
 */
function acquire(group, metricsOpts) {
  const normalized = normalizeGroup(group)
  const direct = ConcurrencyLimiter.tryAcquire()
  if (direct.ok) {
    return Promise.resolve(makeSlot(normalized, direct))
  }
  if (isDisabled()) {
    // 队列关闭：保持旧的快速失败行为
    Metrics.inc('compiles-rejected-overload', 1, metricsOpts)
    return Promise.reject(direct.error)
  }
  if (queueLength() >= maxQueueLength()) {
    Metrics.inc('compile-queue-rejected-full', 1, metricsOpts)
    logger.warn(
      { group: normalized, ...stats() },
      'compile queue full, rejecting request'
    )
    return Promise.reject(
      overloadError(
        'full',
        'compile queue is full, please retry',
        { group: normalized, ...stats() }
      )
    )
  }

  enqueuedTotal++
  Metrics.inc('compile-queue-enqueued', 1, metricsOpts)
  return new Promise((resolve, reject) => {
    const waiter = {
      group: normalized,
      enqueuedAt: Date.now(),
      metricsOpts,
      resolve,
      reject,
      settled: false,
      timer: null,
    }
    waiter.timer = setTimeout(() => {
      if (waiter.settled) {
        return
      }
      waiter.settled = true
      removeWaiter(waiter)
      const waitedMs = Date.now() - waiter.enqueuedAt
      Metrics.inc('compile-queue-rejected-timeout', 1, metricsOpts)
      logger.warn(
        { group: normalized, waitedMs, ...stats() },
        'compile waited too long in queue, rejecting request'
      )
      reject(
        overloadError(
          'timeout',
          'waited too long for a compile slot, please retry',
          { group: normalized, waitedMs, ...stats() }
        )
      )
    }, maxWaitMs())
    if (typeof waiter.timer.unref === 'function') {
      waiter.timer.unref()
    }
    waiters[normalized].push(waiter)
    logger.debug(
      { group: normalized, ...stats() },
      'compile queued, waiting for a slot'
    )
  })
}

// 测试用：清空内部状态（不改动 ConcurrencyLimiter 的 inFlight）
function _resetForTests() {
  for (const group of [PRIVILEGED_GROUP, DEFAULT_GROUP]) {
    for (const waiter of waiters[group]) {
      clearTimeout(waiter.timer)
      waiter.settled = true
    }
    waiters[group].length = 0
  }
  enqueuedTotal = 0
}

module.exports = {
  acquire,
  stats,
  queueLength,
  maxQueueLength,
  maxWaitMs,
  agingMs,
  normalizeGroup,
  isDisabled,
  // 兼容旧调用点：直接透传容量计算
  getLimit: ConcurrencyLimiter.getLimit,
  _resetForTests,
  // 供测试观察
  get _enqueuedTotal() {
    return enqueuedTotal
  },
}
