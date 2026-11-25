/**
 * FIXED: 2026-11-16 从编译结果里挑出「能交给 AI 修」的错误。
 *
 * 踩过的坑（线上表现：AI 修复返回「这次编译没有可定位到源码文件的错误」）：
 *   compile context 里的 `logEntries` **不是数组**，而是
 *     { errors: [], warnings: [], typesetting: [], all: [] }
 *   （见 features/pdf-preview/util/output-files.js:52 与 :134）
 *   之前直接 Array.isArray 判断，永远为 false → 前端发出去的是空数组 →
 *   后端只能回「没有可定位的错误」。所以这里对两种结构都兜住，
 *   并把「结构变了」这件事用单测钉死（collect-errors.test.ts）。
 */

export type CompileErrorForFix = {
  file: string
  line: number
  message: string
}

type MaybeLogEntry = {
  level?: string
  message?: unknown
  messageComponent?: unknown
  content?: unknown
  file?: string
  line?: number
}

type LogEntries =
  | MaybeLogEntry[]
  | { all?: MaybeLogEntry[]; errors?: MaybeLogEntry[] }

/** 一次最多 6 条，与后端 MAX_ERRORS 对齐 */
export const MAX_ERRORS = 6

function messageOf(entry: MaybeLogEntry): string {
  if (typeof entry.message === 'string' && entry.message.trim()) {
    return entry.message
  }
  if (typeof entry.content === 'string' && entry.content.trim()) {
    return entry.content
  }
  // message 可能是 React 组件（messageComponent），这时退回 content；
  // 都没有就跳过（没法给模型看）
  return ''
}

export function collectErrors(
  logEntries: LogEntries | null | undefined
): CompileErrorForFix[] {
  if (!logEntries) {
    return []
  }

  let entries: MaybeLogEntry[]
  if (Array.isArray(logEntries)) {
    entries = logEntries
  } else if (Array.isArray(logEntries.all)) {
    entries = logEntries.all
  } else if (Array.isArray(logEntries.errors)) {
    entries = logEntries.errors
  } else {
    entries = []
  }

  // 真 error 排前面，带位置的 warning 排后面（模型先看确定的错）
  const hardErrors: CompileErrorForFix[] = []
  const softWarnings: CompileErrorForFix[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    // FIXED: 2026-11-16 除了 error，也收「带行号的 warning」：
    // Citation undefined / 缺 bib key 这类在 LaTeX 日志里常常是 warning，
    // 但完全可修（用户最常问的就是这个）。没有行号的 warning（Overfull hbox 等）
    // 信息量太低，仍然跳过，免得把模型带偏。
    const isError = entry.level === 'error'
    const isLocatableWarning =
      entry.level === 'warning' &&
      typeof entry.line === 'number' &&
      entry.line > 0 &&
      typeof entry.file === 'string' &&
      entry.file.trim().length > 0
    if (!isError && !isLocatableWarning) {
      continue
    }
    const message = messageOf(entry).trim()
    if (!message) {
      continue
    }
    const file =
      typeof entry.file === 'string' ? entry.file.replace(/^\.\//, '') : ''
    const line =
      typeof entry.line === 'number' && entry.line > 0 ? entry.line : 0
    const key = `${file}|${line}|${message.slice(0, 100)}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const item = { file, line, message }
    if (isError) {
      hardErrors.push(item)
    } else {
      softWarnings.push(item)
    }
    if (hardErrors.length + softWarnings.length >= MAX_ERRORS) {
      break
    }
  }

  return [...hardErrors, ...softWarnings].slice(0, MAX_ERRORS)
}
