/**
 * 个人知识库索引的 Mongo 冷存储模型
 *
 * FIXED: 2026-11-10 新增文件。
 *
 * 定位：Redis 是首选热存储（key = kb:index:v1:<userId>，TTL 7 天），
 * Redis 挂掉或数据过期后，从这张表把索引捞回来重建，避免每次都要重新扫全量文档。
 * 所以这里存的是「整份索引对象」，不拆表 —— 拆了反而增加查询复杂度，
 * 而个人级知识库单用户索引通常是几百 KB 级别，单文档存得下。
 *
 * 与 store.js 的契约：store.js 懒 require 本文件，取 KnowledgeIndex 模型，
 * 用到的 API 只有三个：findOneAndUpdate(upsert) / findOne().lean() / deleteOne()。
 *
 * FIXED: 2026-11-10 导出方式对齐仓库现有约定（见 models/AIChat.js）：
 * 直接用 infrastructure/Mongoose 的 mongoose 实例，而不是上游的 BaseSchema.createModel。
 */

const mongoose = require('../infrastructure/Mongoose')

const { Schema } = mongoose

const KnowledgeIndexSchema = new Schema(
  {
    // FIXED: 2026-11-10 索引归属用户
    userId: { type: String, required: true, index: true },

    // FIXED: 2026-11-10 索引格式版本（结构变了就抬版本号，旧数据自然失效）
    version: { type: String, default: 'v1' },

    // FIXED: 2026-11-10 建索引时间（用于判断新鲜度）
    builtAt: { type: Date },

    // FIXED: 2026-11-10 整份索引（indexer.buildIndex 的返回值：{version,builtAt,docs,stats}）
    // 用 Mixed 而不是强类型子文档：文档切分策略/节点字段未来可能演进，
    // 强类型会让每次演进都要跑迁移；这里由 indexer 的 INDEX_VERSION 把关。
    index: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'KnowledgeIndex', minimize: false, timestamps: true }
)

// 同一用户同一版本只允许一条，配合 findOneAndUpdate 的 upsert 做「覆盖写」
KnowledgeIndexSchema.index(
  { userId: 1, version: 1 },
  { unique: true, name: 'knowledge_index_user_version' }
)
// 清理旧版本/长期未更新用的辅助索引
KnowledgeIndexSchema.index({ builtAt: -1 }, { name: 'knowledge_index_built_at' })

exports.KnowledgeIndex = mongoose.model('KnowledgeIndex', KnowledgeIndexSchema)
exports.KnowledgeIndexSchema = KnowledgeIndexSchema

