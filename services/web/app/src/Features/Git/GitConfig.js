const mongoose = require('../../infrastructure/Mongoose')

const { Schema } = mongoose
const { ObjectId } = Schema

/**
 * GitConfig Model - 独立集合，不修改现有 Project/User Schema
 * 存储 Git 仓库配置，关联到 projectId
 */
const GitConfigSchema = new Schema(
  {
    projectId: {
      type: ObjectId,
      required: true,
      index: { unique: true },
      ref: 'Project',
    },
    userId: {
      type: ObjectId,
      required: true,
      ref: 'User',
    },
    // 仓库配置
    url: {
      type: String,
      required: true,
    },
    branch: {
      type: String,
      default: 'main',
    },
    // Git 是协议，平台只用于展示；保留字段兼容旧数据，不再限制枚举或必填。
    platform: {
      type: String,
      default: 'other',
    },
    /**
     * 访问令牌（可空）
     *
     * 为什么单独存一份：公开仓库用匿名 HTTPS 就能 clone / pull，用户是在
     * 「要 push 的时候」才发现需要令牌，这时没有重新 clone 的机会。
     * 有了这个字段就能事后补令牌，而不必重连仓库。
     *
     * 安全约定：这个字段**永远不会**出现在任何 API 响应里，
     * 对外只暴露「有没有」和「末 4 位」（见 GitController.saveGitToken）。
     */
    token: {
      type: String,
      default: null,
      select: false,
    },
    // 同步状态
    lastSync: Date,
    lastCommit: String,
    autoSync: {
      type: Boolean,
      default: false,
    },
    // 创建时间
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    minimize: false,
  }
)

// 更新时间中间件
GitConfigSchema.pre('save', function (next) {
  this.updatedAt = new Date()
  next()
})

// 索引
GitConfigSchema.index({ projectId: 1, userId: 1 })

exports.GitConfig = mongoose.model('GitConfig', GitConfigSchema)
exports.GitConfigSchema = GitConfigSchema
