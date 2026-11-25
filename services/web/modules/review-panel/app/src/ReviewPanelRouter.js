const AuthorizationMiddleware = require('../../../../app/src/Features/Authorization/AuthorizationMiddleware')
const ReviewPanelController = require('./ReviewPanelController')

// =============================================================================
// FIXED: 2026-11-13 审阅面板（行内批注）路由。
//
// 路径必须与**前端实际调用**完全一致 —— 前端有两套调用方：
//   - Angular 面板：frontend/js/ide/review-panel/controllers/ReviewPanelController.js
//   - React 面板：frontend/js/features/review-panel/context/threads-context.tsx
// 注意 resolve / reopen 在现有前端里是**不带 doc_id** 的
//   POST /project/:pid/thread/:tid/resolve
// （Pro 版是带 doc_id 的，照抄会 404，以本仓库前端为准）
//
// 权限取舍（FIXED: 2026-11 引入 reviewer 档后重新划分）：
//   - 读线程 / 读 ranges / 读变更作者：能读项目即可（readOnly 也能看到讨论）
//   - 发/改/删评论：`ensureUserCanCommentOnProject`
//     （owner / readAndWrite / review；纯 readOnly 不能评论）
//     前端 PermissionsManager 的 comment 标志与服务端保持同一口径，
//     否则 pure readOnly 会看到输入框但发出去 403。
//   - 解决/重开讨论、删除整条线程、开关跟踪修改、接受修改：要求「可写」
//     （前端 comment-entry.tsx 的 resolve 按钮就是 `permissions.comment && permissions.write`，
//       服务端放到 comment 会出现「能调接口但界面上没按钮」的不一致，所以维持 write）
//   - 匿名链接用户（restricted token member）全部拦掉：blockRestrictedUserFromProject
//
// FIXED: 2026-11 修正过期注释
// OLD: 「跟踪修改（track changes）相关路由没有实现：/track_changes 与 /changes/accept
//       依赖未实现的后端逻辑，界面侧已由 defaultFeatures.trackChanges = false 关闭。」
// 实际状态：下面两条路由**已实现**（ReviewPanelController.toggleTrackChanges /
// acceptChanges → DocumentUpdaterHandler.acceptChanges → RangesManager.acceptChanges），
// 且 Settings.defaultFeatures.trackChanges 已是 true。原注释是补齐路由前的草稿，
// 留着会让后来者以为功能未开而不去排查真正的开关问题。
// =============================================================================
module.exports = {
  apply(webRouter) {
    // FIXED: 2026-11-13 修订（track changes）相关路由。
    // 前端 ReviewPanelController.js（Angular）与 source-editor 的 React 面板都会调用：
    //   POST /project/:pid/track_changes                      （开关，1124 行）
    //   POST /project/:pid/doc/:did/changes/accept            （接受，723 行）
    // 缺这两条时「接受」会 404、开关会静默失败。
    webRouter.post(
      '/project/:project_id/track_changes',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      ReviewPanelController.toggleTrackChanges
    )

    webRouter.post(
      '/project/:project_id/doc/:doc_id/changes/accept',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      ReviewPanelController.acceptChanges
    )

    // 批注列表
    webRouter.get(
      '/project/:project_id/threads',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanReadProject,
      ReviewPanelController.getThreads
    )

    // 文档里的 range（评论锚点、变更区间）。前端打开面板时会拉一次，
    // 缺这条会 404 并在控制台报错，评论也无法定位到具体行。
    webRouter.get(
      '/project/:project_id/ranges',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanReadProject,
      ReviewPanelController.getAllRanges
    )

    // 变更作者列表。跟踪修改未启用，这里返回空数组即可（前端拿它补用户名）。
    webRouter.get(
      '/project/:project_id/changes/users',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanReadProject,
      ReviewPanelController.getChangesUsers
    )

    // 发评论
    webRouter.post(
      '/project/:project_id/thread/:thread_id/messages',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanCommentOnProject,
      ReviewPanelController.sendComment
    )

    // 改 / 删自己的评论
    webRouter.post(
      '/project/:project_id/thread/:thread_id/messages/:message_id/edit',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanCommentOnProject,
      ReviewPanelController.editMessage
    )
    webRouter.delete(
      '/project/:project_id/thread/:thread_id/messages/:message_id',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanCommentOnProject,
      ReviewPanelController.deleteMessage
    )

    // 解决 / 重开（前端不带 doc_id）
    webRouter.post(
      '/project/:project_id/thread/:thread_id/resolve',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      ReviewPanelController.resolveThread
    )
    webRouter.post(
      '/project/:project_id/thread/:thread_id/reopen',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      ReviewPanelController.reopenThread
    )

    // 删除整条线程（前端带 doc_id）
    webRouter.delete(
      '/project/:project_id/doc/:doc_id/thread/:thread_id',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      ReviewPanelController.deleteThread
    )
  },
}
