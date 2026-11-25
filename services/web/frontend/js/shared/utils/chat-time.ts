/**
 * FIXED: 2026-11-17 AI 面板消息时间戳（提问/回复下方、功能按钮前面）。
 *
 * 需求来自「想知道从提问到回复到底花了多久」：
 *  - 当天：只显示 24 进制时间，精确到秒（`14:05:09`）；
 *  - 非当天（同年）：`MM-DD HH:MM:SS`；
 *  - 跨年：`YYYY-MM-DD HH:MM:SS`；
 *  - 手机端宽度不够，**优先保住「时间」**：历史消息去掉秒，只留 `MM-DD HH:MM`
 *    （跨年同样保留日期，否则同一个「09:12」分不清是哪一天）。
 *
 * 时间戳本身走 `--fl-text-muted`（见 ai-chat.less），三套主题自动跟随。
 * 这里只做纯函数，方便单测；渲染见 shared/components/ai-message-time.tsx。
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export interface MessageTimeParts {
  /** 日期部分：当天为空字符串（不显示） */
  date: string
  /** 时间部分：当天带秒；窄屏下的历史消息只到分 */
  clock: string
  /** 完整时间，放 title / aria-label，避免窄屏丢了信息就只能靠猜 */
  full: string
  /** 机器可读时间（`<time datetime>` 用），始终是完整 ISO 本地时间 */
  iso: string
}

export interface FormatMessageTimeOptions {
  /** 手机端（<= 767px）：历史消息省略秒 */
  isMobile?: boolean
  /** 注入「现在」，便于单测；默认取系统时间 */
  now?: Date
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatMessageTime(
  value: string | number | Date | null | undefined,
  { isMobile = false, now = new Date() }: FormatMessageTimeOptions = {}
): MessageTimeParts | null {
  const d = toDate(value)
  if (d == null) return null

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const sameYear = d.getFullYear() === now.getFullYear()

  const hhmmss = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds()
  )}`
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`

  const date = sameDay
    ? ''
    : sameYear
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  // 当天必须精确到秒（这是需求里唯一强制的精度）；历史消息在窄屏让位给日期
  const clock = isMobile && !sameDay ? hhmm : hhmmss

  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const full = `${sameDay ? '' : `${ymd} `}${hhmmss}`

  return { date, clock, full, iso: `${ymd}T${hhmmss}` }
}

/** 用时文案（不带单位前缀，语言无关）：`8.4s` / `1m12s` */
export function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return ''
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)}ms`
  if (elapsedMs < 60000) return `${(elapsedMs / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m${pad(seconds)}s`
}

export interface TimedMessage {
  id: string
  role: string
  createdAt?: string | number | Date | null
}

/**
 * 每条回复的耗时 = 本条 createdAt - 它前面最近那条提问的 createdAt。
 *
 * 用「上一条提问」而不是「上一条消息」：中间可能夹着错误占位 / 恢复占位，
 * 那些不该改变语义。缺任一端时间戳就跳过（老消息没有 createdAt）。
 */
export function computeElapsedByMessageId(
  messages: TimedMessage[]
): Record<string, number> {
  const result: Record<string, number> = {}
  let lastUserAt: number | null = null

  for (const message of messages) {
    const at = toDate(message.createdAt)?.getTime() ?? null
    if (message.role === 'user') {
      lastUserAt = at
      continue
    }
    if (message.role !== 'assistant') continue
    if (at == null || lastUserAt == null) continue
    const elapsed = at - lastUserAt
    if (elapsed >= 0) result[message.id] = elapsed
    // 一轮结束后清掉锚点：下一条回复必须跟新的提问配对
    lastUserAt = null
  }

  return result
}
