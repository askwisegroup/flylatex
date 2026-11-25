const ReviewPanelRouter = require('./app/src/ReviewPanelRouter')
const ProjectEditorHandler = require('../../app/src/Features/Project/ProjectEditorHandler')

// =============================================================================
// FIXED: 2026-11-13 审阅面板（行内批注）模块 —— 参考 Overleaf Pro 的
// `modules/track-changes`，这里只取「评论」部分，跟踪修改（track changes）
// 暂不实现（后端还缺 accept/reject 的路由与 doc-updater 支持）。
//
// 为什么要单独做一个模块：
//   1) CE 的前端其实已经带全套审阅面板（`source-editor/components/review-panel/**`
//      34 个组件 + Angular 的 `ide/review-panel/**`），唯独缺服务端路由，
//      而且被两个开关挡住：
//        - `isReviewPanelReact`（原本是 split test，CE 里恒为 false）
//        - `ProjectEditorHandler.trackChangesAvailable`（CE 里硬编码 false）
//   2) 这两件事都由「模块被加载」来统一置位，和上游 Pro 的做法一致：
//      `Modules.js` 只要看到 module 里有 `router.apply` 就会把路由挂到 webRouter。
//   3) 用独立模块名 `review-panel` 而不是 `track-changes`，是为了让
//      `Features.hasFeature('track-changes')` 保持 false —— 那个 flag 控制的是
//      「跟踪修改」的 UI（接受/拒绝按钮、编辑器 change widget），我们没做后端，
//      一旦点亮就会点出 404。评论不需要它。
// =============================================================================

// 面板入口按钮（工具栏上的 review panel 切换）靠这个布尔值决定是否渲染
ProjectEditorHandler.trackChangesAvailable = true

const ReviewPanelModule = {
  router: ReviewPanelRouter,
}

module.exports = ReviewPanelModule
