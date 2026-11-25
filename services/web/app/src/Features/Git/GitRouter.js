/**
 * GitRouter - Git 功能的路由配置
 */

const AuthenticationController = require('../Authentication/AuthenticationController')
const AuthorizationMiddleware = require('../Authorization/AuthorizationMiddleware')
const DesktopSyncAuth = require('../DesktopSync/DesktopSyncAuth')
const GitController = require('./GitController')
const { RateLimiter } = require('../../infrastructure/RateLimiter')
const RateLimiterMiddleware = require('../Security/RateLimiterMiddleware')

// Bearer 侧用 :project_id，Web 侧用 :Project_id（历史命名不一致），
// 这里统一改名后直接复用 GitController —— 不复制一份权限判定和业务逻辑。
function aliasProjectIdParam(req, res, next) {
  req.params.Project_id = req.params.project_id
  next()
}

// Git 操作的速率限制器
const rateLimiters = {
  cloneProject: new RateLimiter('git-clone-project', {
    points: 10,
    duration: 60,
  }),
  pullChanges: new RateLimiter('git-pull-changes', {
    points: 30,
    duration: 60,
  }),
  pushChanges: new RateLimiter('git-push-changes', {
    points: 20,
    duration: 60,
  }),
  // 信息接口：默认只是读本地状态；带 ?fetch=1 时会去远端取一次引用，
  // 所以比状态轮询限得严一些，避免被当成免费探测器刷远端。
  repositoryInfo: new RateLimiter('git-repository-info', {
    points: 60,
    duration: 60,
  }),
  // 保存令牌：误点也不会有什么代价，但没必要让人刷
  saveToken: new RateLimiter('git-save-token', {
    points: 20,
    duration: 60,
  }),
}

module.exports = {
  apply(webRouter, publicApiRouter) {
    // 从 Git 仓库克隆创建项目
    webRouter.post(
      '/project/from-git',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.cloneProject),
      GitController.cloneFromGit
    )

    // Pull 更新（需要项目写权限）
    webRouter.post(
      '/project/:Project_id/git/pull',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.pullChanges, {
        params: ['Project_id'],
      }),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GitController.pullFromGit
    )

    // Push 更改（需要项目写权限）
    webRouter.post(
      '/project/:Project_id/git/push',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.pushChanges, {
        params: ['Project_id'],
      }),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GitController.pushToGit
    )

    // 获取 Git 状态
    webRouter.get(
      '/project/:Project_id/git/status',
      AuthenticationController.requireLogin(),
      GitController.getGitStatus
    )

    // 仓库信息（「信息」弹窗）
    webRouter.get(
      '/project/:Project_id/git/info',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.repositoryInfo, {
        params: ['Project_id'],
      }),
      GitController.getGitInfo
    )

    // 保存 / 清除访问令牌（公开仓库「能拉不能推」时补令牌用）
    webRouter.put(
      '/project/:Project_id/git/token',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.saveToken, {
        params: ['Project_id'],
      }),
      GitController.saveGitToken
    )

    // 断开 Git 连接
    webRouter.delete(
      '/project/:Project_id/git/link',
      AuthenticationController.requireLogin(),
      GitController.disconnectGit
    )

    // --- Bearer Key 侧：让 Agent / CLI 也能对「已关联 Git 的项目」做拉取/推送 ---
    // FIXED: 2026-11-11 新增。此前 Git 只有 Web 登录态（session cookie + CSRF）一条路，
    // 用 flysync_ Bearer Key 的 Agent 完全碰不到，于是「提示 Agent 拉一下上游代码」
    // 只能退化成让用户自己点菜单。
    // 复用 DesktopSync 的 desktop_sync_keys（不新造密钥体系）；
    // 控制器直接复用 GitController，不复制权限判定和业务逻辑 ——
    // requireApiKey 已 shim 出 req.session，两者的 SessionManager 调用完全一致。
    //
    // 逐条注册而不是 publicApiRouter.use('/api/sync', ...) 整段挂载：
    // 后者会让**所有** /api/sync/* 请求多做一次 Key 解密+查库，
    // 桌面端同步是热路径，不能平白多一次认证。
    if (publicApiRouter) {
      const bearerGitBase = '/api/sync/projects/:project_id/git'

      publicApiRouter.get(
        `${bearerGitBase}/status`,
        DesktopSyncAuth.requireApiKey,
        aliasProjectIdParam,
        GitController.getGitStatus
      )

      publicApiRouter.get(
        `${bearerGitBase}/info`,
        DesktopSyncAuth.requireApiKey,
        aliasProjectIdParam,
        RateLimiterMiddleware.rateLimit(rateLimiters.repositoryInfo, {
          params: ['project_id'],
        }),
        GitController.getGitInfo
      )

      publicApiRouter.post(
        `${bearerGitBase}/pull`,
        DesktopSyncAuth.requireApiKey,
        aliasProjectIdParam,
        RateLimiterMiddleware.rateLimit(rateLimiters.pullChanges, {
          params: ['project_id'],
        }),
        AuthorizationMiddleware.ensureUserCanWriteProjectContent,
        GitController.pullFromGit
      )

      publicApiRouter.post(
        `${bearerGitBase}/push`,
        DesktopSyncAuth.requireApiKey,
        aliasProjectIdParam,
        RateLimiterMiddleware.rateLimit(rateLimiters.pushChanges, {
          params: ['project_id'],
        }),
        AuthorizationMiddleware.ensureUserCanWriteProjectContent,
        GitController.pushToGit
      )
    }
  },
}
