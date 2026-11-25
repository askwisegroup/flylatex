// AI 对话的"会话（conversation）"标识与标题派生。
//
// 背景：原来一个 (userId, projectId) 只对应一份 AIChat 文档，messages 直接内嵌，
// 所有查询都是 findOne —— 等于一个项目只有一段对话。要做"新建对话/历史对话/删除对话"，
// 就得让一份文档对应一段对话，用 conversationId 区分。
//
// 这里刻意只放**纯函数**（不 require mongoose），这样单元测试可以直接跑，
// 不用连 Mongo/Redis（跟 commercial/translate-lang.js 一个思路）。

// 历史数据没有 conversationId，统一按这段"默认对话"对待，保证老数据仍能读出来
const DEFAULT_CONVERSATION_ID = 'default'

// 前端生成的会话 id 必须过这个白名单，避免有人塞进 { $ne: null } 之类的东西
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const TITLE_MAX_LENGTH = 30

/**
 * 把外部传进来的 conversationId 规整成安全值；不合法就落到默认会话。
 * @param {*} value
 * @returns {string}
 */
function normalizeConversationId(value) {
  if (typeof value !== 'string') {
    return DEFAULT_CONVERSATION_ID
  }
  const trimmed = value.trim()
  if (!CONVERSATION_ID_PATTERN.test(trimmed)) {
    return DEFAULT_CONVERSATION_ID
  }
  return trimmed
}

function isDefaultConversationId(value) {
  return normalizeConversationId(value) === DEFAULT_CONVERSATION_ID
}

/**
 * 查询条件：默认会话要兼容"历史文档还没有这个字段"的情况。
 * 迁移脚本跑过之后 $exists 那一半就没有匹配了，留着不影响正确性。
 * @param {string} conversationId
 * @returns {object}
 */
function conversationMatch(conversationId) {
  const id = normalizeConversationId(conversationId)
  if (id === DEFAULT_CONVERSATION_ID) {
    return {
      $or: [
        { conversationId: DEFAULT_CONVERSATION_ID },
        { conversationId: { $exists: false } },
        { conversationId: null },
      ],
    }
  }
  return { conversationId: id }
}

/**
 * 会话标题：取第一条用户消息，压成一行，超长截断。
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
function deriveTitle(messages) {
  if (!Array.isArray(messages)) {
    return ''
  }
  const firstUserMessage = messages.find(
    message => message && message.role === 'user' && message.content
  )
  if (!firstUserMessage) {
    return ''
  }
  return truncateTitle(firstUserMessage.content)
}

/**
 * 单条消息 -> 标题（保存消息时用它做 $setOnInsert）
 * @param {{role: string, content: string}} message
 * @returns {string}
 */
function titleFromMessage(message) {
  if (!message || message.role !== 'user' || !message.content) {
    return ''
  }
  return truncateTitle(message.content)
}

function truncateTitle(text) {
  if (typeof text !== 'string') {
    return ''
  }
  // 去掉 markdown 结构符号与所有空白里的换行，压成一行
  const flattened = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flattened) {
    return ''
  }
  if (flattened.length <= TITLE_MAX_LENGTH) {
    return flattened
  }
  return flattened.slice(0, TITLE_MAX_LENGTH) + '…'
}

/**
 * 列表接口的输出：不把 messages 带出去
 * @param {object} doc
 * @returns {{conversationId: string, title: string, messageCount: number, createdAt: Date, updatedAt: Date}}
 */
function toConversationSummary(doc) {
  const messages = Array.isArray(doc.messages) ? doc.messages : []
  const storedTitle = typeof doc.title === 'string' ? doc.title.trim() : ''
  return {
    conversationId: normalizeConversationId(doc.conversationId),
    title: storedTitle || deriveTitle(messages),
    messageCount:
      typeof doc.messageCount === 'number' ? doc.messageCount : messages.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt || doc.createdAt,
  }
}

module.exports = {
  DEFAULT_CONVERSATION_ID,
  CONVERSATION_ID_PATTERN,
  TITLE_MAX_LENGTH,
  normalizeConversationId,
  isDefaultConversationId,
  conversationMatch,
  deriveTitle,
  titleFromMessage,
  truncateTitle,
  toConversationSummary,
}
