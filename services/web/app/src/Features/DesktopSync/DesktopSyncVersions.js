/**
 * DesktopSyncVersions - 历史版本读取与「回滚到指定版本」
 *
 * FIXED: 2026-11-11 新增文件。
 *
 * 背景：Agent（Bearer Key 路径）此前完全拿不到项目历史 ——
 *   - 版本列表：ai-agent.js 里有 list_history_versions，但只服务 Web 登录态
 *   - 回滚：只有 restore_file，而且是**单个文件 + 存成新文件**（加
 *     "Restored on ..." 后缀，不覆盖原文件），不是 git reset 语义
 * 而 Agent 最常踩的坑恰恰是「上一轮改坏了，想退回上一个版本继续改」，
 * 用「存成新文件」根本解决不了。
 *
 * 本文件提供两个能力，都走 Bearer Key：
 *   GET  /api/sync/project/:id/versions          -> 版本列表（谁、何时、改了哪些文件）
 *   POST /api/sync/project/:id/reset             -> 整项目回滚到指定版本（强制覆盖）
 *
 * 数据来源全部复用现有服务，不新造存储：
 *   - 版本列表：project-history 的 /project/:id/updates（与前端历史面板同源）
 *   - 版本快照：project-history 的 /project/:id/version/:version
 *   - 落盘覆盖：复用 DesktopSyncUpload._reconcileFromDirectory（与桌面同步同一套语义）
 *
 * 安全约定：
 *   - reset 是破坏性操作，**必须**显式传 confirm: "<目标版本号>" 才执行，
 *     防止 Agent 只读了半句话就调过来把项目洗白。
 *   - 回滚前把「当前版本号」写进响应，用户要再退回来还有据可查。
 */

const fsPromises = require('fs/promises')
const { createWriteStream } = require('fs')
const { pipeline } = require('stream/promises')
const path = require('path')
const crypto = require('crypto')
const { expressify } = require('@overleaf/promise-utils')
const { fetchJson, fetchStream } = require('@overleaf/fetch-utils')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')

const SessionManager = require('../Authentication/SessionManager')
const ProjectGetter = require('../Project/ProjectGetter')
const HistoryManager = require('../History/HistoryManager')
const Errors = require('../Errors/Errors')
const DesktopSyncUpload = require('./DesktopSyncUpload')
const DesktopSyncLastModified = require('./DesktopSyncLastModified')

const DEFAULT_VERSION_LIMIT = 20
const MAX_VERSION_LIMIT = 100
// 回滚落盘的临时目录前缀，和桌面同步的临时目录区分开，便于排查残留
const RESET_TMP_PREFIX = 'desktopsync-reset-'

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_VERSION_LIMIT
  }
  return Math.min(parsed, MAX_VERSION_LIMIT)
}

/**
 * 把 project-history 的 update 条目整理成 Agent 能直接读的形状。
 *
 * 原始条目里 toV 是版本号，meta.users 是用户 id 数组（未注入详情），
 * pathnames 是被改动的文件。Agent 只需要「哪一版、什么时候、动了哪些文件」。
 */
function summarizeUpdate(update) {
  const meta = update.meta || {}
  const users = Array.isArray(meta.users) ? meta.users : []
  return {
    version: update.toV,
    fromVersion: update.fromV,
    timestamp: meta.end_ts || meta.start_ts || null,
    pathnames: Array.isArray(update.pathnames)
      ? update.pathnames
      : Array.from(update.pathnames || []),
    userIds: users
      .filter(user => typeof user === 'string')
      .map(user => String(user)),
  }
}

/**
 * GET /api/sync/project/:project_id/versions?limit=20
 *
 * 返回最近的版本列表，**新的在前**（Agent 通常只关心最近几版）。
 * 同时带上当前最新版本号，方便 Agent 判断「要不要回滚」。
 */
const listVersions = expressify(async function listVersions(req, res) {
  const projectId = req.params.project_id
  const userId = SessionManager.getLoggedInUserId(req.session)
  const limit = clampLimit(req.query.limit)

  const project = await ProjectGetter.promises.getProject(projectId, {
    name: true,
  })
  if (!project) {
    throw new Errors.NotFoundError('project not found')
  }

  let updates = []
  let historyError = null
  try {
    updates = await HistoryManager.promises.getUpdates(projectId, userId)
  } catch (err) {
    // 历史服务不可用不应该让整个端点 500：Agent 至少要知道「查不到历史」
    // 和「项目没历史」是两回事，否则会误判成可以随便覆盖。
    historyError = err.message || String(err)
    logger.warn({ err, projectId }, 'failed to load updates for agent')
  }

  const summarized = updates.map(summarizeUpdate).reverse().slice(0, limit)

  res.json({
    projectId,
    name: project.name,
    // 最新版本：拿不到历史时为 null，Agent 应据此停止调用 reset
    latestVersion: summarized.length > 0 ? summarized[0].version : null,
    count: summarized.length,
    total: updates.length,
    versions: summarized,
    ...(historyError ? { historyError } : {}),
  })
})

/**
 * 从 project-history 拉取某版本的完整快照，落地成目录。
 *
 * 快照里每个文件是以下两种形态之一（见 overleaf-editor-core 的 FileData）：
 *   - { content: "..." }  文本文件，内容已 eager 加载
 *   - { hash: "..." }     二进制/未改动文件，只有 blob 哈希
 * 后者要再请求 /project/:id/blob/:hash 才能拿到字节。
 */
async function materializeSnapshot(projectId, version, destDir) {
  const base = Settings.apis.project_history.url
  const snapshot = await fetchJson(
    `${base}/project/${projectId}/version/${version}`
  )
  const files = (snapshot && snapshot.files) || {}
  const entries = Object.entries(files)

  if (entries.length === 0) {
    throw new Errors.NotFoundError(
      `version ${version} of project ${projectId} has no files`
    )
  }

  let written = 0
  for (const [rawPath, fileData] of entries) {
    // 快照里的路径带前导 '/'（'/main.tex'），落盘要去掉，否则会写到根目录外
    const relPath = rawPath.replace(/^\/+/, '')
    if (!relPath) {
      continue
    }
    // 防路径穿越：快照由本系统写入，理论上安全，但这里不能只靠上游保证
    const absPath = path.resolve(destDir, relPath)
    if (!absPath.startsWith(path.resolve(destDir) + path.sep)) {
      throw new Errors.InvalidNameError(
        `unsafe pathname in snapshot: ${rawPath}`
      )
    }
    await fsPromises.mkdir(path.dirname(absPath), { recursive: true })

    if (fileData && typeof fileData.content === 'string') {
      await fsPromises.writeFile(absPath, fileData.content, 'utf8')
      written++
      continue
    }

    if (fileData && fileData.hash) {
      const stream = await fetchStream(
        `${base}/project/${projectId}/blob/${fileData.hash}`
      )
      // fetchStream 给的是 Web ReadableStream，不能直接丢给 writeFile
      // （不同 Node 版本对 Web Stream 的支持不一致），统一走 pipeline。
      await pipeline(stream, createWriteStream(absPath))
      written++
      continue
    }

    // 既没有 content 也没有 hash：快照格式变了，宁可报错也不静默跳过，
    // 否则回滚会「少写一个文件 + 顺手把项目里的原文件删掉」。
    throw new Errors.NotFoundError(
      `snapshot entry ${rawPath} has neither content nor hash`
    )
  }

  return { fileCount: written }
}

/**
 * POST /api/sync/project/:project_id/reset
 * body: { version: 123, confirm: "123" }
 *
 * 语义 = git reset --hard <version>：
 *   - 该版本有的文件：内容恢复成那一版
 *   - 该版本没有、但现在有的文件：**删除**
 * 这是破坏性操作，所以要求 confirm 与 version 完全一致才执行。
 */
const resetToVersion = expressify(async function resetToVersion(req, res) {
  const projectId = req.params.project_id
  const userId = SessionManager.getLoggedInUserId(req.session)
  const body = req.body || {}

  const version = Number.parseInt(body.version, 10)
  if (!Number.isFinite(version) || version < 1) {
    return res.status(400).json({
      error: 'version is required and must be a positive integer',
    })
  }
  // 二次确认：字符串比较，避免前端传 "123" / 123 的差异把保护绕过去
  if (String(body.confirm || '') !== String(version)) {
    return res.status(400).json({
      error:
        'confirm must equal version (destructive: files added after that version will be deleted)',
      expected: { version, confirm: String(version) },
    })
  }

  const project = await ProjectGetter.promises.getProject(projectId, {
    name: true,
  })
  if (!project) {
    throw new Errors.NotFoundError('project not found')
  }

  // 先记录当前版本，回滚失败/回滚错了还能凭这个版本号退回来
  let previousVersion = null
  try {
    const latest = await fetchJson(
      `${Settings.apis.project_history.url}/project/${projectId}/version`
    )
    previousVersion = latest && latest.version != null ? latest.version : null
  } catch (err) {
    logger.warn(
      { err, projectId },
      'failed to read current version before reset'
    )
  }

  const tmpDir = path.join(
    Settings.path.uploadFolder,
    `${RESET_TMP_PREFIX}${crypto.randomUUID()}`
  )
  await fsPromises.mkdir(tmpDir, { recursive: true })
  try {
    const materialized = await materializeSnapshot(projectId, version, tmpDir)
    await DesktopSyncUpload._reconcileFromDirectory(userId, projectId, tmpDir)

    const { lastModified } =
      await DesktopSyncLastModified.getProjectLastModified(projectId)

    logger.info(
      { projectId, userId, version, previousVersion },
      'project reset to history version'
    )

    res.json({
      success: true,
      projectId,
      name: project.name,
      resetTo: version,
      previousVersion,
      fileCount: materialized.fileCount,
      lastModified,
    })
  } catch (err) {
    if (err instanceof Errors.NotFoundError) {
      return res.status(404).json({
        error: err.message,
        hint: 'version 不存在或该版本没有文件，先调 GET /versions 确认',
      })
    }
    throw err
  } finally {
    await fsPromises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {})
  }
})

module.exports = {
  listVersions,
  resetToVersion,
  // 导出给单测
  _summarizeUpdate: summarizeUpdate,
  _materializeSnapshot: materializeSnapshot,
}
