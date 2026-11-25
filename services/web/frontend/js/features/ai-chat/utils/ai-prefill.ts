/**
 * FIXED: 2026-11-16 选区浮条「问 AI」→ 把选中的内容放进 AI 面板的输入框。
 *
 * 为什么要有「待消费的 prefill」：AI 面板可能**还没挂载**（用户第一次打开），
 * 此刻派发事件没人听。所以：先存一份 pending，
 *   · 面板已挂载 → 监听事件直接吃；
 *   · 面板未挂载 → 挂载时 consume 一次。
 * 两条路都不会丢文本，也不会重复填入（consume 后即清空）。
 */

export const AI_PREFILL_EVENT = 'fl-ai:prefill'

/** 太长的选区不往里塞：输入框是给人改的，不是贴整篇 */
export const AI_PREFILL_MAX_CHARS = 4000

let pendingText: string | null = null

export function setAiPrefill(text: string) {
  const trimmed = (text || '').slice(0, AI_PREFILL_MAX_CHARS).trim()
  if (!trimmed) {
    return false
  }
  pendingText = trimmed
  return true
}

export function consumeAiPrefill(): string | null {
  const text = pendingText
  pendingText = null
  return text
}

/** 供面板使用：把待填内容拼到已有草稿后面（已有草稿时换行分隔，不覆盖用户已写的字） */
export function mergePrefill(current: string, incoming: string): string {
  if (!current.trim()) {
    return incoming
  }
  return `${current.replace(/\s+$/, '')}\n\n${incoming}`
}
