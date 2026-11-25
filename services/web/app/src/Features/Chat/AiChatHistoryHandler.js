const { AiChatHistory } = require('../../models/AiChatHistory')
const logger = require('@overleaf/logger')

/**
 * 只有 `tokensCalculatedBy: 'api'` 的行才是网关返回的真实用量；
 * `'missing'`（网关没回 usage）的行数字本来就是 0，不参与统计。
 *
 * 2026-05 之前那批按字数估算的 'wordcount' 行已由
 * scripts/migrate_ai_chat_legacy_token_estimates.js 清理归零，
 * 所以这里不再需要额外排除条件。
 */
const realUsageTokens = field => ({
  $sum: {
    $cond: [{ $eq: ['$tokensCalculatedBy', 'api'] }, `$${field}`, 0],
  },
})

/**
 * 获取用户的 AI 聊天历史统计信息
 * @param {ObjectId|string} userId - 用户ID
 * @returns {Promise<Object>} 包含总 tokens 和其他统计信息的对象
 */
async function getUserChatStatistics(userId) {
  try {
    // 确保 userId 是字符串格式（可能是 ObjectId 对象）
    const userIdString = typeof userId === 'string' ? userId : userId.toString()
    const stats = await AiChatHistory.aggregate([
      {
        $match: { userId: userIdString },
      },
      {
        $group: {
          _id: '$userId',
          totalInputTokens: realUsageTokens('inputTokens'),
          totalOutputTokens: realUsageTokens('outputTokens'),
          totalTokens: realUsageTokens('totalTokens'),
          // 对话次数照常统计全部记录，只有 token 需要「真实」口径
          chatCount: { $sum: 1 },
          lastChatDate: { $max: '$createdAt' },
          modelsUsed: { $addToSet: '$model' },
        },
      },
    ])

    if (stats.length === 0) {
      return {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        chatCount: 0,
        lastChatDate: null,
        modelsUsed: [],
      }
    }

    return stats[0]
  } catch (err) {
    logger.error(
      { userId, err },
      'Error getting user chat statistics'
    )
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      chatCount: 0,
      lastChatDate: null,
      modelsUsed: [],
    }
  }
}

/**
 * 获取用户的 tokens 总使用量
 * @param {ObjectId|string} userId - 用户ID
 * @returns {Promise<number>} 总 tokens 数
 */
async function getUserTotalTokens(userId) {
  try {
    // 确保 userId 是字符串格式（可能是 ObjectId 对象）
    const userIdString = typeof userId === 'string' ? userId : userId.toString()
    console.log(`[AiChatHistoryHandler] Querying tokens for userId: ${userIdString} (original type: ${typeof userId})`)
    const result = await AiChatHistory.aggregate([
      {
        $match: { userId: userIdString },
      },
      {
        $group: {
          _id: '$userId',
          totalTokens: realUsageTokens('totalTokens'),
        },
      },
    ])

    console.log(`[AiChatHistoryHandler] Aggregation result:`, result)
    const totalTokens = result.length > 0 ? result[0].totalTokens : 0
    console.log(`[AiChatHistoryHandler] ✓ Total tokens for user ${userIdString}: ${totalTokens}`)
    return totalTokens
  } catch (err) {
    logger.error(
      { userId, err },
      'Error getting user total tokens'
    )
    console.error(`[AiChatHistoryHandler] ✗ Error getting tokens for ${userId}:`, err.message)
    return 0
  }
}

/**
 * 获取用户的聊天分布统计（按模型、计算方式等）
 * @param {ObjectId|string} userId - 用户ID
 * @returns {Promise<Object>} 详细的统计信息
 */
async function getUserTokensBreakdown(userId) {
  try {
    // 确保 userId 是字符串格式（可能是 ObjectId 对象）
    const userIdString = typeof userId === 'string' ? userId : userId.toString()
    const breakdown = await AiChatHistory.aggregate([
      {
        $match: { userId: userIdString },
      },
      {
        $group: {
          _id: {
            model: '$model',
            calculatedBy: '$tokensCalculatedBy',
          },
          tokens: realUsageTokens('totalTokens'),
          chatCount: { $sum: 1 },
          inputTokens: realUsageTokens('inputTokens'),
          outputTokens: realUsageTokens('outputTokens'),
        },
      },
      {
        $sort: { tokens: -1 },
      },
    ])

    return breakdown
  } catch (err) {
    logger.error(
      { userId, err },
      'Error getting user tokens breakdown'
    )
    return []
  }
}

/**
 * 记录一条聊天历史
 * @param {Object} chatData - 聊天数据
 * @returns {Promise<Object>} 保存的聊天记录
 */
async function saveChatHistory(chatData) {
  try {
    const chatRecord = new AiChatHistory(chatData)
    const saved = await chatRecord.save()
    return saved
  } catch (err) {
    logger.error(
      { chatData, err },
      'Error saving chat history'
    )
    throw err
  }
}

/**
 * 批量记录聊天历史
 * @param {Array<Object>} chatDataList - 聊天数据列表
 * @returns {Promise<Array>} 保存的聊天记录列表
 */
async function saveChatHistoryBatch(chatDataList) {
  try {
    const saved = await AiChatHistory.insertMany(chatDataList)
    return saved
  } catch (err) {
    logger.error(
      { count: chatDataList.length, err },
      'Error saving chat history batch'
    )
    throw err
  }
}

/**
 * 获取用户在特定时间范围内的 tokens 使用情况
 * @param {ObjectId|string} userId - 用户ID
 * @param {Date} startDate - 开始日期
 * @param {Date} endDate - 结束日期
 * @returns {Promise<number>} 指定时间范围内的总 tokens
 */
async function getUserTokensInRange(userId, startDate, endDate) {
  try {
    const result = await AiChatHistory.aggregate([
      {
        $match: {
          userId: userId,
          createdAt: {
            $gte: startDate,
            $lte: endDate,
          },
        },
      },
      {
        $group: {
          _id: '$userId',
          totalTokens: realUsageTokens('totalTokens'),
        },
      },
    ])

    return result.length > 0 ? result[0].totalTokens : 0
  } catch (err) {
    logger.error(
      { userId, startDate, endDate, err },
      'Error getting user tokens in range'
    )
    return 0
  }
}

module.exports = {
  getUserChatStatistics,
  getUserTotalTokens,
  getUserTokensBreakdown,
  saveChatHistory,
  saveChatHistoryBatch,
  getUserTokensInRange,
}
