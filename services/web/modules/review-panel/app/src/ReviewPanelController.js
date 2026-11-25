const ChatApiHandler = require('../../../../app/src/Features/Chat/ChatApiHandler')
const ChatController = require('../../../../app/src/Features/Chat/ChatController')
const EditorRealTimeController = require('../../../../app/src/Features/Editor/EditorRealTimeController')
const SessionManager = require('../../../../app/src/Features/Authentication/SessionManager')
const UserInfoManager = require('../../../../app/src/Features/User/UserInfoManager')
const UserInfoController = require('../../../../app/src/Features/User/UserInfoController')
const HttpErrorHandler = require('../../../../app/src/Features/Errors/HttpErrorHandler')
const DocstoreManager = require('../../../../app/src/Features/Docstore/DocstoreManager')
const DocumentUpdaterHandler = require('../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler')
const { Project } = require('../../../../app/src/models/Project')

// =============================================================================
// FIXED: 2026-11-13 审阅面板控制器（批注部分）。
//
// 数据都存在 chat 服务里（线程 + 消息），这里只做三件事：
//   1) 鉴权由路由层的 AuthorizationMiddleware 完成，这里只取当前用户
//   2) 调 ChatApiHandler 落库
//   3) 用 EditorRealTimeController 把变更广播给项目房间（其他人的面板实时更新）
//
// 与 Pro 版（modules/track-changes/TrackChangesController.mjs）的差异：
//   - Pro 在 resolve / reopen / deleteThread 时还会调
//     `DocumentUpdaterHandler.resolveThread(...)` 去同步文档里的 range；
//     CE 的 document-updater 没有这三个 HTTP 接口（我们的
//     DocumentUpdaterHandler 只有 acceptChanges / deleteThread），所以这里跳过。
//     影响：线程状态与评论本身完全正常，只是「已解决」的高亮在刷新后可能
//     仍留在文档里，直到下一次文档重新加载。后续补 doc-updater 接口即可消除。
//   - Pro 允许「评审者删除自己的评论」，CE 简化为要求可写权限（见 Router 注释）。
// =============================================================================

// 复用 ChatController 里的用户信息注入，避免重复实现一套（项目规范：优先复用）
function injectUserInfoIntoThreads(threads) {
  return new Promise((resolve, reject) => {
    ChatController._injectUserInfoIntoThreads(threads, (error, result) => {
      if (error != null) {
        return reject(error)
      }
      resolve(result)
    })
  })
}

async function getLoggedInUser(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    HttpErrorHandler.forbidden(req, res)
    return null
  }
  const user = await UserInfoManager.promises.getPersonalInfo(userId)
  return { userId, user: UserInfoController.formatPersonalInfo(user) }
}

const ReviewPanelController = {
  async getThreads(req, res, next) {
    try {
      const { project_id: projectId } = req.params
      const threads = await ChatApiHandler.promises.getThreads(projectId)
      await injectUserInfoIntoThreads(threads)
      res.json(threads)
    } catch (error) {
      next(error)
    }
  },

  // 修订（track changes）开关。
  //
  // 语义与前端 ReviewPanelController.js 完全对齐：
  //   - { on: true }                       → 全员开启（owner + 所有 collaborator）
  //   - { on_for: { userId: bool } }       → 逐人设置（前端只传布尔值）
  //   - { on_for_guests: true }            → 匿名/链接用户也跟踪
  // 存到 project.track_changes，并把最终状态广播给项目房间，
  // 其他人的面板据此即时更新（客户端自己不维护第二份状态）。
  async toggleTrackChanges(req, res, next) {
    try {
      const { project_id: projectId } = req.params
      const project = await Project.findById(projectId, {
        track_changes: 1,
        owner_ref: 1,
        collaberator_refs: 1,
      }).lean()
      if (!project) {
        return HttpErrorHandler.notFound(req, res)
      }

      const previous =
        project.track_changes instanceof Object ? project.track_changes : {}
      const { __guests__: previousGuests, ...previousMembers } = previous

      const state = {}
      if (typeof req.body.on === 'boolean') {
        // 全员统一设置
        const value = req.body.on
        if (project.owner_ref) state[project.owner_ref.toString()] = value
        for (const ref of project.collaberator_refs || []) {
          state[ref.toString()] = value
        }
      } else {
        // 逐人设置：前端传的就是布尔值；兼容一下旧格式 { value: bool }
        const incoming =
          req.body.on_for instanceof Object ? req.body.on_for : previousMembers
        for (const [userId, raw] of Object.entries(incoming)) {
          state[userId] =
            raw instanceof Object && raw !== null ? !!raw.value : !!raw
        }
      }

      const guests =
        typeof req.body.on_for_guests === 'boolean'
          ? req.body.on_for_guests
          : previousGuests === true
      if (guests) state.__guests__ = true

      await Project.updateOne({ _id: projectId }, { track_changes: state })
      EditorRealTimeController.emitToRoom(
        projectId,
        'toggle-track-changes',
        state
      )
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },

  // 接受某文档里指定的变更。
  // 真正的合并逻辑在 document-updater（DocumentManager.acceptChanges →
  // RangesManager.acceptChanges），这里只负责：先广播让别人的编辑器即时生效，
  // 再落库。顺序与 Pro 版一致（先广播，请求慢也不影响协作者的观感）。
  async acceptChanges(req, res, next) {
    try {
      const { project_id: projectId, doc_id: docId } = req.params
      const changeIds = req.body.change_ids
      if (!Array.isArray(changeIds) || changeIds.length === 0) {
        return HttpErrorHandler.badRequest(req, res, 'change_ids 不能为空')
      }
      EditorRealTimeController.emitToRoom(
        projectId,
        'accept-changes',
        docId,
        changeIds
      )
      await DocumentUpdaterHandler.promises.acceptChanges(
        projectId,
        docId,
        changeIds
      )
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },

  // 文档里的 range（评论锚点所在区间）。
  // 先把 document-updater 里还在内存的文档刷到 mongo，再读 docstore，
  // 否则刚加的评论可能读不到（与 Pro 版的做法一致）。
  async getAllRanges(req, res, next) {
    try {
      const { project_id: projectId } = req.params
      await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
      const docs = await DocstoreManager.promises.getAllRanges(projectId)
      res.json(docs.map(doc => ({ id: doc._id, ranges: doc.ranges ?? {} })))
    } catch (error) {
      next(error)
    }
  },

  // 变更作者列表。
  // 前端已经知道当前 owner/members 的名字，这里补的是「已经离开项目、
  // 但文档里还留着未接受变更」的作者，否则面板上这些变更显示不出人名。
  // FIXED: 2026-11-13 跟踪修改上线后从「返回空数组」改成真实实现。
  async getChangesUsers(req, res, next) {
    try {
      const { project_id: projectId } = req.params
      await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
      const docs = await DocstoreManager.promises.getAllRanges(projectId)

      const userIds = new Set()
      for (const doc of docs) {
        const changes = doc.ranges?.changes ?? {}
        for (const changeId of Object.keys(changes)) {
          const userId = changes[changeId]?.user_id
          if (userId) userIds.add(userId.toString())
        }
      }

      const users = await Promise.all(
        Array.from(userIds).map(userId =>
          UserInfoManager.promises
            .getPersonalInfo(userId)
            .then(user => UserInfoController.formatPersonalInfo(user))
            .catch(() => null) // 用户可能已被删除，跳过而不是整体 500
        )
      )
      res.json(users.filter(Boolean))
    } catch (error) {
      next(error)
    }
  },

  async sendComment(req, res, next) {
    try {
      const { project_id: projectId, thread_id: threadId } = req.params
      const { content } = req.body
      const current = await getLoggedInUser(req, res)
      if (!current) return
      const message = await ChatApiHandler.promises.sendComment(
        projectId,
        threadId,
        current.userId,
        content
      )
      message.user = current.user
      EditorRealTimeController.emitToRoom(
        projectId,
        'new-comment',
        threadId,
        message
      )
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },

  async editMessage(req, res, next) {
    try {
      const { project_id: projectId, thread_id: threadId } = req.params
      const { message_id: messageId } = req.params
      const { content } = req.body
      const current = await getLoggedInUser(req, res)
      if (!current) return
      await ChatApiHandler.promises.editMessage(
        projectId,
        threadId,
        messageId,
        current.userId,
        content
      )
      EditorRealTimeController.emitToRoom(
        projectId,
        'edit-message',
        threadId,
        messageId,
        content
      )
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },

  async deleteMessage(req, res, next) {
    try {
      const { project_id: projectId, thread_id: threadId } = req.params
      const { message_id: messageId } = req.params
      const current = await getLoggedInUser(req, res)
      if (!current) return
      await ChatApiHandler.promises.deleteMessage(
        projectId,
        threadId,
        messageId
      )
      EditorRealTimeController.emitToRoom(
        projectId,
        'delete-message',
        threadId,
        messageId
      )
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },

  async resolveThread(req, res, next) {
    try {
      const { project_id: projectId, thread_id: threadId } = req.params
      const current = await getLoggedInUser(req, res)
      if (!current) return
      await ChatApiHandler.promises.resolveThread(
        projectId,
        threadId,
        current.userId
      )
      EditorRealTimeController.emitToRoom(
        projectId,
        'resolve-thread',
        threadId,
        current.user
      )
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },

  async reopenThread(req, res, next) {
    try {
      const { project_id: projectId, thread_id: threadId } = req.params
      const current = await getLoggedInUser(req, res)
      if (!current) return
      await ChatApiHandler.promises.reopenThread(projectId, threadId)
      EditorRealTimeController.emitToRoom(projectId, 'reopen-thread', threadId)
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },

  async deleteThread(req, res, next) {
    try {
      const { project_id: projectId, thread_id: threadId } = req.params
      const current = await getLoggedInUser(req, res)
      if (!current) return
      await ChatApiHandler.promises.deleteThread(projectId, threadId)
      EditorRealTimeController.emitToRoom(projectId, 'delete-thread', threadId)
      res.sendStatus(204)
    } catch (error) {
      next(error)
    }
  },
}

module.exports = ReviewPanelController
