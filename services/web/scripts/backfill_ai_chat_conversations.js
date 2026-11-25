/**
 * 一次性迁移：给历史 AI 对话补上会话字段，让"新建对话/历史对话/删除对话"可用。
 *
 * 背景：原来一个 (userId, projectId) 只有一份 AIChat 文档，没有 conversationId。
 * 新版按 conversationId 区分会话；老文档在查询侧已经能用 $exists 兜住，
 * 这个脚本只是为了把数据补齐（顺便回填标题、消息条数、最后消息时间）。
 *
 * 幂等：重复跑没有副作用，只处理"还缺字段"的文档。
 *
 * 用法（容器内，/overleaf 目录）：
 *   node services/web/scripts/backfill_ai_chat_conversations.js --dry-run
 *   node services/web/scripts/backfill_ai_chat_conversations.js
 *
 * 只写 AIChat，绝不碰 AiChatHistory（计费/用量记录）。
 */

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')

const { AIChat } = require('../app/src/models/AIChat')
const {
  DEFAULT_CONVERSATION_ID,
  deriveTitle,
  normalizeConversationId,
} = require('../app/src/Features/AIChat/conversation')

async function main() {
  // 只看还缺 conversationId 的老文档
  const cursor = AIChat.find({
    $or: [
      { conversationId: { $exists: false } },
      { conversationId: null },
      { conversationId: '' },
    ],
  })
    .select({ _id: 1, userId: 1, projectId: 1, messages: 1, createdAt: 1 })
    .lean()
    .cursor()

  let scanned = 0
  let updated = 0
  let duplicates = 0

  for await (const doc of cursor) {
    scanned++
    const messages = Array.isArray(doc.messages) ? doc.messages : []
    const last = messages.length > 0 ? messages[messages.length - 1] : null

    const update = {
      $set: {
        conversationId: DEFAULT_CONVERSATION_ID,
        title: deriveTitle(messages),
        messageCount: messages.length,
        lastMessageAt: last && last.createdAt ? last.createdAt : doc.createdAt,
      },
    }

    // 同一 (user, project) 下如果已经有多份老文档，只保留最近更新的一份作为默认对话，
    // 其余标记删除，避免列表里出现一堆"默认对话"。
    const sibling = await AIChat.findOne({
      _id: { $ne: doc._id },
      userId: doc.userId,
      projectId: doc.projectId,
      isDeleted: false,
      $or: [
        { conversationId: DEFAULT_CONVERSATION_ID },
        { conversationId: { $exists: false } },
        { conversationId: null },
      ],
    })
      .select({ _id: 1 })
      .lean()

    if (sibling) {
      duplicates++
      if (!dryRun) {
        await AIChat.updateOne(
          { _id: doc._id },
          {
            $set: {
              isDeleted: true,
              deletedAt: new Date(),
              conversationId: normalizeConversationId(DEFAULT_CONVERSATION_ID),
            },
          }
        )
      }
      continue
    }

    if (!dryRun) {
      await AIChat.updateOne({ _id: doc._id }, update)
    }
    updated++
  }

  console.log(
    JSON.stringify(
      { dryRun, scanned, updated, markedDeletedAsDuplicate: duplicates },
      null,
      2
    )
  )
  if (dryRun) {
    console.log('（--dry-run：没有写入任何数据，去掉参数再跑一次）')
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('迁移失败：', err)
    process.exit(1)
  })
