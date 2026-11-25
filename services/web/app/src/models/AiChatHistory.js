const mongoose = require('../infrastructure/Mongoose')
const { Schema } = mongoose

const AiChatHistorySchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    userName: {
      type: String,
      default: '',
    },
    projectId: {
      type: String,
    },
    projectName: {
      type: String,
      default: '',
    },
    question: {
      type: String,
      default: '',
    },
    answer: {
      type: String,
      default: '',
    },
    model: {
      type: String,
      default: 'unknown',
    },
    inputTokens: {
      type: Number,
      default: 0,
    },
    outputTokens: {
      type: Number,
      default: 0,
    },
    totalTokens: {
      type: Number,
      default: 0,
    },
    // 'api' = 网关返回的真实 usage；'missing' = 网关没回，不估算。
    // 早期的 'wordcount' 估算行由 scripts/migrate_ai_chat_legacy_token_estimates.js
    // 统一改成 'missing'，所以这里不再保留那个取值。
    tokensCalculatedBy: {
      type: String,
      enum: ['api', 'missing'],
      default: 'missing',
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  }
)

// 为 userId 和 createdAt 创建复合索引以优化聚合查询
AiChatHistorySchema.index({ userId: 1, createdAt: -1 })

exports.AiChatHistory = mongoose.model(
  'AiChatHistory',
  AiChatHistorySchema
)
exports.AiChatHistorySchema = AiChatHistorySchema
