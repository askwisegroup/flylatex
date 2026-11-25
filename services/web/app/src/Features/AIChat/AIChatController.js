const { AIChat } = require('../../models/AIChat')
const OError = require('@overleaf/o-error')
const logger = require('@overleaf/logger')
// FIXED: 2026-10-30 多段对话：会话 id 规整与标题派生（纯函数，见 conversation.js）
const {
  DEFAULT_CONVERSATION_ID,
  normalizeConversationId,
  conversationMatch,
  titleFromMessage,
  toConversationSummary,
} = require('./conversation')

/**
 * 保存单条消息（使用 $push 增量更新）
 * @param {string} userId - 用户 ID
 * @param {string} projectId - 项目 ID
 * @param {object} message - 消息对象 { id, role, content, model, totalTokens, ... }
 * @param {string} [conversationId] - 会话 id，缺省为 'default'（兼容老前端）
 */
async function saveMessage(userId, projectId, message, conversationId) {
  const conversation = normalizeConversationId(conversationId)
  try {
    if (!userId || !projectId || !message) {
      throw new Error('Missing required parameters: userId, projectId, message')
    }

    const result = await AIChat.findOneAndUpdate(
      // FIXED: 2026-10-30 老文档没有 conversationId 字段，默认会话要能命中它
      // OLD: { userId, projectId, isDeleted: false }
      Object.assign({ userId, projectId, isDeleted: false }, conversationMatch(conversation)),
      {
        $push: { messages: message },
        $set: { updatedAt: new Date(), lastMessageAt: new Date() },
        $inc: { messageCount: 1 },
        // 只有新建文档时才写这些，已有对话不受影响
        $setOnInsert: {
          conversationId: conversation,
          title: titleFromMessage(message),
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: false }
    )

    logger.debug(
      { userId, projectId, conversationId: conversation, messageId: message.id },
      'AI chat message saved'
    )

    return result
  } catch (err) {
    logger.err(
      { userId, projectId, conversationId: conversation, err },
      'Error saving AI chat message'
    )
    throw OError.tag(err, 'Error saving AI chat message', {
      userId,
      projectId,
      conversationId: conversation,
    })
  }
}

/**
 * 加载对话记录（默认最后 20 条）
 * @param {string} userId - 用户 ID
 * @param {string} projectId - 项目 ID
 * @param {number} limit - 返回的最大消息数，默认 20
 * @param {string} [conversationId] - 会话 id，缺省为 'default'
 */
async function getMessages(userId, projectId, limit = 20, conversationId) {
  const conversation = normalizeConversationId(conversationId)
  try {
    if (!userId || !projectId) {
      throw new Error('Missing required parameters: userId, projectId')
    }

    const chatHistory = await AIChat.findOne(
      // FIXED: 2026-10-30 按会话取消息
      // OLD: { userId, projectId, isDeleted: false }
      Object.assign({ userId, projectId, isDeleted: false }, conversationMatch(conversation)),
      { messages: { $slice: -limit } }
    )

    if (!chatHistory) {
      logger.debug({ userId, projectId, conversationId: conversation }, 'No chat history found')
      return []
    }

    logger.debug(
      { userId, projectId, conversationId: conversation, messageCount: chatHistory.messages?.length },
      'AI chat messages fetched'
    )

    return chatHistory.messages || []
  } catch (err) {
    logger.err(
      { userId, projectId, conversationId: conversation, err },
      'Error fetching AI chat messages'
    )
    throw OError.tag(err, 'Error fetching AI chat messages', {
      userId,
      projectId,
      conversationId: conversation,
    })
  }
}

/**
 * 加载全部对话记录
 * @param {string} userId - 用户 ID
 * @param {string} projectId - 项目 ID
 * @param {string} [conversationId] - 会话 id，缺省为 'default'
 */
async function getAllMessages(userId, projectId, conversationId) {
  const conversation = normalizeConversationId(conversationId)
  try {
    if (!userId || !projectId) {
      throw new Error('Missing required parameters: userId, projectId')
    }

    const chatHistory = await AIChat.findOne(
      // FIXED: 2026-10-30 按会话取消息
      // OLD: { userId, projectId, isDeleted: false }
      Object.assign({ userId, projectId, isDeleted: false }, conversationMatch(conversation))
    )

    if (!chatHistory) {
      logger.debug({ userId, projectId, conversationId: conversation }, 'No chat history found for getAllMessages')
      return []
    }

    logger.debug(
      { userId, projectId, conversationId: conversation, messageCount: chatHistory.messages?.length },
      'All AI chat messages fetched'
    )

    return chatHistory.messages || []
  } catch (err) {
    logger.err(
      { userId, projectId, conversationId: conversation, err },
      'Error fetching all AI chat messages'
    )
    throw OError.tag(err, 'Error fetching all AI chat messages', {
      userId,
      projectId,
      conversationId: conversation,
    })
  }
}

/**
 * 删除对话记录（逻辑删除）
 * @param {string} userId - 用户 ID
 * @param {string} projectId - 项目 ID
 * @param {string} [conversationId] - 会话 id，缺省为 'default'
 */
async function deleteMessages(userId, projectId, conversationId) {
  const conversation = normalizeConversationId(conversationId)
  try {
    if (!userId || !projectId) {
      throw new Error('Missing required parameters: userId, projectId')
    }

    const result = await AIChat.findOneAndUpdate(
      // FIXED: 2026-10-30 补上 isDeleted:false 并按会话删除。
      // 原来漏了 isDeleted 过滤，多份文档时可能把已删的那份又删一遍，活着的却没动。
      // OLD: { userId, projectId }
      Object.assign({ userId, projectId, isDeleted: false }, conversationMatch(conversation)),
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      },
      { new: true }
    )

    logger.info(
      { userId, projectId, conversationId: conversation },
      'AI chat messages deleted (logical)'
    )

    return result
  } catch (err) {
    logger.err(
      { userId, projectId, conversationId: conversation, err },
      'Error deleting AI chat messages'
    )
    throw OError.tag(err, 'Error deleting AI chat messages', {
      userId,
      projectId,
      conversationId: conversation,
    })
  }
}

/**
 * 删除单条消息（硬删除）
 * @param {string} userId - 用户 ID
 * @param {string} projectId - 项目 ID
 * @param {string} messageId - 消息 ID
 * @param {string} [conversationId] - 会话 id，缺省为 'default'
 */
async function deleteMessage(userId, projectId, messageId, conversationId) {
  const conversation = normalizeConversationId(conversationId)
  try {
    if (!userId || !projectId || !messageId) {
      throw new Error('Missing required parameters: userId, projectId, messageId')
    }

    const result = await AIChat.findOneAndUpdate(
      // FIXED: 2026-10-30 按会话删单条消息
      // OLD: { userId, projectId, isDeleted: false }
      Object.assign({ userId, projectId, isDeleted: false }, conversationMatch(conversation)),
      {
        $pull: { messages: { id: messageId } },
        $set: { updatedAt: new Date() },
        $inc: { messageCount: -1 },
      },
      { new: true }
    )

    // 老文档可能没有 messageCount，$inc 会把它变成 -1；这里纠正回 0
    if (result && result.messageCount != null && result.messageCount < 0) {
      await AIChat.updateOne({ _id: result._id }, { $set: { messageCount: 0 } })
      result.messageCount = 0
    }

    logger.debug(
      { userId, projectId, conversationId: conversation, messageId },
      'AI chat message deleted (hard)'
    )

    return result
  } catch (err) {
    logger.err(
      { userId, projectId, conversationId: conversation, messageId, err },
      'Error deleting specific AI chat message'
    )
    throw OError.tag(err, 'Error deleting specific AI chat message', {
      userId,
      projectId,
      conversationId: conversation,
      messageId,
    })
  }
}

/**
 * 列出某个项目下的所有会话（不含消息正文）
 * FIXED: 2026-10-30 新增：多段对话的历史列表
 * @param {string} userId
 * @param {string} projectId
 * @param {{limit?: number}} [options]
 */
async function listConversations(userId, projectId, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 50
  try {
    if (!userId || !projectId) {
      throw new Error('Missing required parameters: userId, projectId')
    }

    // FIXED: 2026-10-30 用聚合算 messageCount / 首条用户消息：
    // 老文档（没有 conversationId/title/messageCount，用户也可能不跑迁移脚本）
    // 也能拿到准的条数和标题，而不用把整个 messages 数组拉出来。
    const docs = await AIChat.aggregate([
      { $match: { userId, projectId, isDeleted: false } },
      { $sort: { updatedAt: -1 } },
      { $limit: limit },
      {
        $project: {
          conversationId: 1,
          title: 1,
          createdAt: 1,
          updatedAt: 1,
          // $ifNull 兜住"字段不存在 / 为 null"，$size 只接受数组
          messageCount: {
            $ifNull: ['$messageCount', { $size: { $ifNull: ['$messages', []] } }],
          },
          firstUserMessage: {
            $arrayElemAt: [
              {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ['$messages', []] },
                      as: 'm',
                      cond: { $eq: ['$$m.role', 'user'] },
                    },
                  },
                  as: 'u',
                  in: '$$u.content',
                },
              },
              0,
            ],
          },
        },
      },
    ])

    const conversations = docs
      // toConversationSummary 不认识 firstUserMessage，这里转成它需要的形状
      .map(doc =>
        toConversationSummary({
          ...doc,
          messages:
            typeof doc.firstUserMessage === 'string' && doc.firstUserMessage
              ? [{ role: 'user', content: doc.firstUserMessage }]
              : [],
        })
      )
      // 空对话（还没有任何消息）不占用历史列表
      .filter(conversation => conversation.messageCount > 0)

    logger.debug(
      { userId, projectId, count: conversations.length },
      'AI chat conversations listed'
    )

    return conversations
  } catch (err) {
    logger.err(
      { userId, projectId, err },
      'Error listing AI chat conversations'
    )
    throw OError.tag(err, 'Error listing AI chat conversations', {
      userId,
      projectId,
    })
  }
}

/**
 * 删除一整段对话（逻辑删除，只动 AIChat，不动 AiChatHistory 计费记录）
 * FIXED: 2026-10-30 新增
 * @param {string} userId
 * @param {string} projectId
 * @param {string} conversationId
 */
async function deleteConversation(userId, projectId, conversationId) {
  const conversation = normalizeConversationId(conversationId)
  try {
    if (!userId || !projectId) {
      throw new Error('Missing required parameters: userId, projectId')
    }

    const result = await AIChat.findOneAndUpdate(
      Object.assign({ userId, projectId, isDeleted: false }, conversationMatch(conversation)),
      { $set: { isDeleted: true, deletedAt: new Date() } },
      { new: true }
    )

    logger.info(
      { userId, projectId, conversationId: conversation, deleted: result != null },
      'AI chat conversation deleted (logical)'
    )

    return result != null
  } catch (err) {
    logger.err(
      { userId, projectId, conversationId: conversation, err },
      'Error deleting AI chat conversation'
    )
    throw OError.tag(err, 'Error deleting AI chat conversation', {
      userId,
      projectId,
      conversationId: conversation,
    })
  }
}

module.exports = {
  saveMessage,
  getMessages,
  getAllMessages,
  deleteMessages,
  deleteMessage,
  // FIXED: 2026-10-30 多段对话
  listConversations,
  deleteConversation,
  DEFAULT_CONVERSATION_ID,
}
