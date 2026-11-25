/**
 * 个人知识库 HTTP 接口（Features/KnowledgeBase/KnowledgeBaseRouter.js）
 *
 * FIXED: 2026-11-10 新增文件。
 *
 * 定位：只是「门面层的 HTTP 适配器」，本身不含任何业务逻辑。
 *   Agent 内置工具  -> commercial/personal-kb/index.js
 *   HTTP API       -> 本文件（这一层）
 *   MCP 服务       -> 直接复用 index.js（不经过 HTTP）
 *   SKILLS 接口    -> 直接复用 index.js（不经过 HTTP）
 *
 * 所以本文件里不能出现任何检索/索引代码，改功能一律改 index.js，
 * 四套消费者自动同步 —— 这是「低耦合高内聚」的落点。
 *
 * 身份：两种方式，都最终归结为 index.js 需要的 { userId }。
 *   1. Bearer Key（/api/kb/*）：复用 DesktopSync 的 desktop_sync_keys，
 *      与桌面端 /sync 用同一套 KEY，不新造密钥体系（用户明确要求复用）。
 *   2. Web 登录态（/kb/api/*）：session cookie + requireLogin。
 */

const express = require('express')
const AuthenticationController = require('../Authentication/AuthenticationController')
const SessionManager = require('../Authentication/SessionManager')
const DesktopSyncAuth = require('../DesktopSync/DesktopSyncAuth')
const logger = require('@overleaf/logger')

function loadKb() {
  // 门面层在 commercial 下（它依赖 ai-agent 的一些约定），懒加载避免循环依赖
  // eslint-disable-next-line node/no-missing-require
  return require('../../../../commercial/personal-kb')
}

/** 从 req 里取 userId：两种认证方式都已把用户放进 req.session */
function userIdOf(req) {
  try {
    const id = SessionManager.getLoggedInUserId(req.session)
    return id == null ? null : String(id)
  } catch (err) {
    return null
  }
}

/** 统一响应：门面返回 { ok, data, error }，这里映射成 HTTP 状态码并保持结构 */
function send(res, outcome) {
  if (outcome && outcome.ok) {
    return res.status(200).json({ ok: true, data: outcome.data, error: null })
  }
  const error = (outcome && outcome.error) || { code: 'unknown', message: '未知错误' }
  const status =
    error.code === 'no_user'
      ? 401
      : error.code === 'node_not_found' || error.code === 'no_project'
        ? 404
        : error.code === 'empty_query' || error.code === 'no_node'
          ? 400
          : 500
  return res.status(status).json({ ok: false, data: null, error })
}

/** 兜住所有未预期异常：知识库挂了不能把 500 直接喷给调用方 */
function safe(handler) {
  return async function (req, res) {
    try {
      const outcome = await handler(req)
      return send(res, outcome)
    } catch (err) {
      logger.err({ err, url: req.originalUrl }, 'knowledge base api failed')
      return send(res, {
        ok: false,
        data: null,
        error: { code: 'internal_error', message: err.message || String(err) },
      })
    }
  }
}

function ctxOf(req) {
  return { userId: userIdOf(req) }
}

// --- 各端点（全部只做参数搬运） ---

const getStats = safe(async req => loadKb().getKnowledgeStats(ctxOf(req)))

const getTree = safe(async req =>
  loadKb().listKnowledge(ctxOf(req), {
    layer: req.query.layer || 'tree',
    projectId: req.query.project_id,
    maxDepth:
      req.query.max_depth != null ? Number(req.query.max_depth) : undefined,
  })
)

const getProjects = safe(async req =>
  loadKb().listKnowledge(ctxOf(req), { layer: 'projects' })
)

const getDocs = safe(async req =>
  loadKb().listKnowledge(ctxOf(req), {
    layer: 'docs',
    projectId: req.query.project_id || req.params.projectId,
  })
)

const search = safe(async req => {
  // 同时支持 GET ?q= 与 POST body，方便 curl 与 MCP 桥接各取所需
  const body = req.body || {}
  const query = body.query != null ? body.query : req.query.q
  return loadKb().searchKnowledge(ctxOf(req), query, {
    limit: body.limit != null ? body.limit : req.query.limit,
    projectId: body.project_id || req.query.project_id,
    tag: body.tag || req.query.tag,
    kind: body.kind || req.query.kind,
    field: body.field || req.query.field,
  })
})

const readNode = safe(async req => {
  const body = req.body || {}
  const nodeId = req.params.nodeId || body.node_id || req.query.node_id
  return loadKb().readKnowledge(ctxOf(req), nodeId, {
    maxChars: body.max_chars != null ? body.max_chars : req.query.max_chars,
  })
})

const cite = safe(async req => {
  const body = req.body || {}
  if (body.node_id) {
    return loadKb().citeKnowledge(ctxOf(req), body.node_id)
  }
  return loadKb().citeKnowledge(ctxOf(req), {
    projectId: body.project_id,
    projectName: body.project_name,
    path: body.path,
    title: body.title,
    startLine: body.start_line,
    endLine: body.end_line,
  })
})

const refresh = safe(async req =>
  loadKb().refreshKnowledgeBase(ctxOf(req), {
    force: req.body && req.body.force === true,
  })
)

module.exports = {
  apply(webRouter, publicApiRouter) {
    // --- Bearer Key 侧：与桌面端 /sync 共用 desktop_sync_keys，不新造密钥体系 ---
    const bearerRouter = express.Router()
    bearerRouter.get('/stats', getStats)
    bearerRouter.get('/tree', getTree)
    bearerRouter.get('/projects', getProjects)
    bearerRouter.get(
      '/projects/:projectId/docs',
      (req, res, next) => {
        req.query.project_id = req.params.projectId
        next()
      },
      getDocs
    )
    bearerRouter.get('/search', search)
    bearerRouter.post('/search', search)
    bearerRouter.get('/doc/:nodeId', readNode)
    bearerRouter.get('/cite', cite)
    bearerRouter.post('/cite', cite)
    bearerRouter.post('/refresh', refresh)

    publicApiRouter.use('/api/kb', DesktopSyncAuth.requireApiKey, bearerRouter)

    // --- Web 登录态侧：给前端知识库面板用（session cookie）---
    webRouter.get('/kb/api/stats', AuthenticationController.requireLogin(), getStats)
    webRouter.get('/kb/api/tree', AuthenticationController.requireLogin(), getTree)
    webRouter.get(
      '/kb/api/projects',
      AuthenticationController.requireLogin(),
      getProjects
    )
    webRouter.get(
      '/kb/api/projects/:projectId/docs',
      AuthenticationController.requireLogin(),
      (req, res, next) => {
        req.query.project_id = req.params.projectId
        next()
      },
      getDocs
    )
    webRouter.get('/kb/api/search', AuthenticationController.requireLogin(), search)
    webRouter.get(
      '/kb/api/doc/:nodeId',
      AuthenticationController.requireLogin(),
      readNode
    )
    webRouter.post(
      '/kb/api/refresh',
      AuthenticationController.requireLogin(),
      refresh
    )
  },
  // 供 MCP / SKILLS 复用（它们不走 HTTP，但共用同一套参数搬运约定）
  _handlers: { getStats, getTree, search, readNode, cite, refresh },
}

