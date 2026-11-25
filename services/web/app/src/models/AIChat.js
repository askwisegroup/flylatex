const mongoose = require('../infrastructure/Mongoose')

const { Schema } = mongoose

// FIXED: 2026-11 工具步骤（"读取文件 main.tex → 修改内容 → 编译"）现在也进历史。
// 之前只在本次会话的内存里，切走页面/重开历史就只剩一段结论，
// 用户看不到这一轮到底做了什么；run 恢复做完后这个落差更明显。
const StepSchema = new Schema(
  {
    id: { type: String },
    /** 原始工具名，只用于映射展示文案 */
    name: { type: String },
    /** 参数摘要，例如 main.tex */
    detail: { type: String },
    status: { type: String, enum: ['running', 'done', 'error'] },
    message: { type: String },
    error: { type: String },
    durationMs: { type: Number },
  },
  { _id: false }
)

// 单条消息的 schema
const MessageSchema = new Schema(
  {
    id: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true },
    model: { type: String },
    totalTokens: { type: Number },
    inputTokens: { type: Number },
    outputTokens: { type: Number },
    processMarkdown: { type: String },
    // FIXED: 2026-11 这一轮执行过的工具步骤（老消息没有这个字段，前端按空处理）
    steps: [StepSchema],
    statusHistory: [{ type: String }],
    showProcess: { type: Boolean },
    images: [{
      url: { type: String },
      name: { type: String }
    }],
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
)

// 对话记录的 schema
// FIXED: 2026-10-30 一个项目支持多段对话：同一 (userId, projectId) 下用 conversationId 区分。
// 历史文档没有 conversationId，按 'default' 对待（见 Features/AIChat/conversation.js）。
const AIChatSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    conversationId: { type: String, default: 'default', index: true },
    title: { type: String, default: '' },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date },
    messages: [MessageSchema],
    isDeleted: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date },
  },
  { minimize: false }
)

// 创建复合索引以加快查询
AIChatSchema.index({ userId: 1, projectId: 1 })
AIChatSchema.index({ isDeleted: 1, updatedAt: -1 })
// FIXED: 2026-10-30 会话列表 + 按会话定位
AIChatSchema.index(
  { userId: 1, projectId: 1, isDeleted: 1, updatedAt: -1 },
  { name: 'ai_chat_conversation_list' }
)
AIChatSchema.index(
  { userId: 1, projectId: 1, conversationId: 1 },
  { name: 'ai_chat_conversation_lookup' }
)

exports.AIChat = mongoose.model('AIChat', AIChatSchema)
exports.AIChatSchema = AIChatSchema
