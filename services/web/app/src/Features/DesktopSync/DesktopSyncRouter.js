const express = require('express')
const AuthenticationController = require('../Authentication/AuthenticationController')
const AuthorizationMiddleware = require('../Authorization/AuthorizationMiddleware')
const DesktopSyncAuth = require('./DesktopSyncAuth')
const DesktopSyncKeys = require('./DesktopSyncKeys')
const DesktopSyncProjects = require('./DesktopSyncProjects')
const DesktopSyncCreate = require('./DesktopSyncCreate')
const DesktopSyncUpload = require('./DesktopSyncUpload')
const DesktopSyncApi = require('./DesktopSyncApi')
const DesktopSyncVersions = require('./DesktopSyncVersions')
const DesktopSyncCitations = require('./DesktopSyncCitations')
const DesktopSyncLiterature = require('./DesktopSyncLiterature')

module.exports = {
  apply(webRouter, publicApiRouter) {
    // --- Key 管理端点：Web 登录态（session cookie + requireLogin）---
    // 路径前缀 /api/sync/keys 不与下方公网侧前缀重叠，避免被 Bearer 中间件拦截。
    webRouter.get(
      '/api/sync/keys',
      AuthenticationController.requireLogin(),
      DesktopSyncKeys.listKeys
    )
    webRouter.post(
      '/api/sync/keys',
      AuthenticationController.requireLogin(),
      DesktopSyncKeys.createKey
    )
    webRouter.delete(
      '/api/sync/keys/:keyId',
      AuthenticationController.requireLogin(),
      DesktopSyncKeys.revokeKey
    )

    // --- 项目同步端点：Bearer Key 认证（publicApiRouter，早于 webRouter 挂载）---
    // 只匹配 /api/sync/projects 与 /api/sync/project/*，不波及 /api/sync/keys。
    const projectsListRouter = express.Router()
    projectsListRouter.get('/', DesktopSyncProjects.listProjects)
    // 分页列表：独立端点，避免改变 GET / 的裸数组契约（老客户端不受影响）
    projectsListRouter.get('/paged', DesktopSyncProjects.listProjectsPaged)
    // 新建项目：multipart 上传 zip（字段名 'zip'）+ 项目名（字段 name 或头 X-Project-Name）
    projectsListRouter.post(
      '/',
      DesktopSyncUpload.multerMiddleware,
      DesktopSyncCreate.createProject
    )
    publicApiRouter.use(
      '/api/sync/projects',
      DesktopSyncAuth.requireApiKey,
      projectsListRouter
    )

    const projectRouter = express.Router()
    projectRouter.get(
      '/:project_id/download',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncProjects.downloadProject
    )
    // 顺序：授权 -> 冲突预检（401/409 前置，不收文件）-> multer 解析 -> 对账回写
    projectRouter.post(
      '/:project_id/upload',
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      DesktopSyncUpload.precheckUpload,
      DesktopSyncUpload.multerMiddleware,
      DesktopSyncUpload.uploadProject
    )

    // --- 供桌面端 / CLI / Agent 读取与编译的补充接口 ---
    // 全部复用 requireApiKey 注入的 req.session，不再单独做认证。
    projectRouter.get(
      '/:project_id',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.getMeta
    )
    projectRouter.get(
      '/:project_id/manifest',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.getManifest
    )
    // 编译器是项目设置：需要设置写权限，而不是仅读权限
    projectRouter.post(
      '/:project_id/compiler',
      AuthorizationMiddleware.ensureUserCanWriteProjectSettings,
      DesktopSyncApi.setCompiler
    )
    projectRouter.get(
      '/:project_id/tags',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.listProjectTags
    )
    projectRouter.post(
      '/:project_id/tags',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.addProjectTag
    )
    projectRouter.delete(
      '/:project_id/tags/:tag_id',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.removeProjectTag
    )
    // 编译是重操作：控制器内部按 userId 限流
    projectRouter.post(
      '/:project_id/compile',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.compile
    )
    projectRouter.get(
      '/:project_id/pdf',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.downloadPdf
    )
    projectRouter.get(
      '/:project_id/build/:build_id/output/:file',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncApi.getBuildOutput
    )

    // --- 历史版本：只读列表 + 回滚到指定版本 ---
    // FIXED: 2026-11-11 新增。此前 Agent 既拿不到版本列表，也没有「退回去」的能力
    // （restore_file 是「存成新文件」，不是 reset），改坏了只能让用户手工处理。
    // 回滚是破坏性操作，控制器内部要求 confirm 与 version 一致才执行。
    projectRouter.get(
      '/:project_id/versions',
      AuthorizationMiddleware.ensureUserCanReadProject,
      DesktopSyncVersions.listVersions
    )
    projectRouter.post(
      '/:project_id/reset',
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      DesktopSyncVersions.resetToVersion
    )

    // --- 引用写入：搜到文献后直接落地成 .bib + \cite 或 thebibliography ---
    // FIXED: 2026-11-11 新增。此前 Agent 只能"查文献"，没法把结果写进项目：
    // 前端那套（CrosRefSearch）绑死 Web session + CSRF，Bearer Key 够不到。
    // 控制器内部按项目现状自动选 bib / bibitem 模式，支持 dryRun 预览。
    projectRouter.post(
      '/:project_id/cite',
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      DesktopSyncCitations.cite
    )

    publicApiRouter.use(
      '/api/sync/project',
      DesktopSyncAuth.requireApiKey,
      projectRouter
    )

    // --- 文献检索：Bearer Key 侧的 search_literature ---
    // FIXED: 2026-11-11 新增。此前检索只存在于 Web-Agent，
    // 用 Bearer Key 的 skill / CLI 拿不到 references，也就无从写引用。
    // 单独立一个 Router，避免 /api/sync/literature 被上面两个 use 前缀抢走。
    const literatureRouter = express.Router()
    literatureRouter.get('/search', DesktopSyncLiterature.search)
    literatureRouter.post('/search', DesktopSyncLiterature.search)
    publicApiRouter.use(
      '/api/sync/literature',
      DesktopSyncAuth.requireApiKey,
      literatureRouter
    )
  },
}
