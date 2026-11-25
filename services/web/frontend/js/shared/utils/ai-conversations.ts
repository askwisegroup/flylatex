// AI 对话的"会话"在前端侧的记账：当前选中哪一段、怎么新建、列表数据长什么样。
//
// 后端按 (userId, projectId, conversationId) 存，conversationId 由前端生成
// （服务端只做白名单校验），这样"点新建对话"不需要额外一次网络请求，
// 也不会产生空对话文档 —— 第一次发消息时 upsert 才真正建库。

export const DEFAULT_CONVERSATION_ID = 'default'

// 与后端 app/src/Features/AIChat/conversation.js 的白名单保持一致
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface ConversationSummary {
  conversationId: string
  title: string
  messageCount: number
  createdAt?: string
  updatedAt?: string
}

/**
 * 新建会话 id。带时间戳前缀，列表排序时天然接近创建顺序；
 * 后半段随机串避免同一毫秒内连点撞车。
 */
export function newConversationId(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function isValidConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value)
}

export function conversationStorageKey(projectId: string): string {
  return `fl-ai-conversation:${projectId}`
}

/**
 * 当前项目上次打开的是哪段对话；没有记录时落到默认会话，
 * 这样老用户（库里只有一份老数据）打开面板还是原来那段。
 */
export function readActiveConversationId(projectId: string): string {
  try {
    const value = window.localStorage.getItem(conversationStorageKey(projectId))
    return isValidConversationId(value) ? value : DEFAULT_CONVERSATION_ID
  } catch {
    return DEFAULT_CONVERSATION_ID
  }
}

export function storeActiveConversationId(projectId: string, id: string) {
  if (!isValidConversationId(id)) return
  try {
    window.localStorage.setItem(conversationStorageKey(projectId), id)
  } catch {
    // 忽略：记不住只是下次回到默认会话，不影响对话本身
  }
}

/**
 * 列表排序：最近有消息的在前。后端已经排过，这里兜一层，
 * 因为本地插入新会话时也要保持同样的顺序。
 */
export function sortConversations(
  conversations: ConversationSummary[]
): ConversationSummary[] {
  return [...conversations].sort((a, b) => {
    const at = Date.parse(a.updatedAt || a.createdAt || '') || 0
    const bt = Date.parse(b.updatedAt || b.createdAt || '') || 0
    return bt - at
  })
}

/**
 * 列表项标题：后端可能派生出空标题（第一条不是用户消息时），用 i18n 兜底文案。
 */
export function displayTitle(title: string, fallback: string): string {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  return trimmed === '' ? fallback : trimmed
}
