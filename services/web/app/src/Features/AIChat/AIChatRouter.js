const AuthenticationController = require('../Authentication/AuthenticationController')
const {
  saveMessage,
  getMessages,
  getAllMessages,
  deleteMessages,
  deleteMessage,
  // FIXED: 2026-10-30 多段对话
  listConversations,
  deleteConversation,
} = require('./AIChatController')
const { expressify } = require('@overleaf/promise-utils')

module.exports = {
  apply(webRouter, privateApiRouter) {
    webRouter.post(
      '/api/ai-chat/save-message',
      AuthenticationController.requireLogin(),
      expressify(async (req, res, next) => {
        const userId = req.user?._id?.toString()
        // FIXED: 2026-10-30 带上会话 id（老前端不传时后端按 'default' 处理）
        const { projectId, message, conversationId } = req.body

        if (!userId || !projectId || !message) {
          return res.status(400).json({
            success: false,
            error: 'Missing required fields: projectId, message',
          })
        }

        const result = await saveMessage(userId, projectId, message, conversationId)

        return res.json({
          success: true,
          data: result,
        })
      })
    )

    webRouter.get(
      '/api/ai-chat/messages',
      AuthenticationController.requireLogin(),
      expressify(async (req, res, next) => {
        const userId = req.user?._id?.toString()
        const { projectId, limit = 20, conversationId } = req.query

        if (!userId || !projectId) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: projectId',
          })
        }

        const messages = await getMessages(
          userId,
          projectId,
          parseInt(limit, 10),
          conversationId
        )

        return res.json({
          success: true,
          data: messages,
        })
      })
    )

    // FIXED: 2026-10-30 会话列表（不含消息正文）
    webRouter.get(
      '/api/ai-chat/conversations',
      AuthenticationController.requireLogin(),
      expressify(async (req, res, next) => {
        const userId = req.user?._id?.toString()
        const { projectId, limit } = req.query

        if (!userId || !projectId) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: projectId',
          })
        }

        const conversations = await listConversations(userId, projectId, {
          limit: limit ? parseInt(limit, 10) : undefined,
        })

        return res.json({
          success: true,
          data: conversations,
        })
      })
    )

    // FIXED: 2026-10-30 删除整段对话（只删 AIChat，不动 AiChatHistory 计费记录）
    webRouter.delete(
      '/api/ai-chat/conversations/:conversationId',
      AuthenticationController.requireLogin(),
      expressify(async (req, res, next) => {
        const userId = req.user?._id?.toString()
        const { conversationId } = req.params
        const { projectId } = req.query

        if (!userId || !projectId || !conversationId) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: projectId, conversationId',
          })
        }

        const deleted = await deleteConversation(userId, projectId, conversationId)

        return res.json({
          success: true,
          data: { deleted },
        })
      })
    )

    webRouter.get(
      '/api/ai-chat/messages/all',
      AuthenticationController.requireLogin(),
      expressify(async (req, res, next) => {
        const userId = req.user?._id?.toString()
        const { projectId, conversationId } = req.query

        if (!userId || !projectId) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: projectId',
          })
        }

        const messages = await getAllMessages(userId, projectId, conversationId)

        return res.json({
          success: true,
          data: messages,
        })
      })
    )

    webRouter.delete(
      '/api/ai-chat/messages',
      AuthenticationController.requireLogin(),
      expressify(async (req, res, next) => {
        const userId = req.user?._id?.toString()
        const { projectId, conversationId } = req.query

        if (!userId || !projectId) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: projectId',
          })
        }

        const result = await deleteMessages(userId, projectId, conversationId)

        return res.json({
          success: true,
          message: 'Messages deleted successfully',
          data: result,
        })
      })
    )

    webRouter.delete(
      '/api/ai-chat/messages/:messageId',
      AuthenticationController.requireLogin(),
      expressify(async (req, res, next) => {
        const userId = req.user?._id?.toString()
        const { messageId } = req.params
        const { projectId, conversationId } = req.query

        if (!userId || !projectId || !messageId) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: projectId, messageId',
          })
        }

        const result = await deleteMessage(
          userId,
          projectId,
          messageId,
          conversationId
        )

        return res.json({
          success: true,
          message: 'Message deleted successfully',
          data: result,
        })
      })
    )
  },
}
