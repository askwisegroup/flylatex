const { promisify } = require('util')
const { expressify } = require('@overleaf/promise-utils')
const ProjectGetter = require('../Project/ProjectGetter')
const ProjectZipStreamManager = require('../Downloads/ProjectZipStreamManager')
const DocumentUpdaterHandler = require('../DocumentUpdater/DocumentUpdaterHandler')
const SessionManager = require('../Authentication/SessionManager')
const { prepareZipAttachment } = require('../../infrastructure/Response')
const DesktopSyncLastModified = require('./DesktopSyncLastModified')

const createZipStreamForProject = promisify(
  ProjectZipStreamManager.createZipStreamForProject.bind(ProjectZipStreamManager)
)

// findAllUsersProjects 返回按关系分组的对象
// { owned, readAndWrite, readOnly, tokenReadAndWrite, tokenReadOnly }，需展平 + 去重。
function flattenProjects(grouped) {
  const seen = new Set()
  const result = []
  for (const list of Object.values(grouped || {})) {
    for (const project of list || []) {
      const id = project._id.toString()
      if (seen.has(id)) {
        continue
      }
      seen.add(id)
      result.push({
        id,
        name: project.name,
        lastModified: DesktopSyncLastModified.toMillis(project.lastUpdated),
      })
    }
  }
  return result
}

// 分页参数解析：limit 默认 20（1..50），page 默认 1（从 1 开始）。
// 非法/缺省值一律回落到默认值，避免 Agent 传错参数直接 400。
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }
  return parsed
}

function parsePagination(query) {
  const limit = Math.min(
    parsePositiveInt(query && query.limit, DEFAULT_LIMIT),
    MAX_LIMIT
  )
  const page = parsePositiveInt(query && query.page, 1)
  return { limit, page }
}

module.exports = {
  flattenProjects,
  parsePagination,

  // 保持原契约不变：返回裸数组（老客户端依赖此形状，勿改）
  // 但限制最多返回 MAX_LIMIT 条，避免项目多时一次拉全量。
  listProjects: expressify(async function listProjects(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const grouped = await ProjectGetter.promises.findAllUsersProjects(userId, {
      name: true,
      lastUpdated: true,
    })
    res.json(flattenProjects(grouped).slice(0, MAX_LIMIT))
  }),

  // 新增分页接口：GET /api/sync/projects/paged?limit=20&page=1
  // 返回 { projects, total, limit, page }，便于 Agent 判断总量与翻页。
  listProjectsPaged: expressify(async function listProjectsPaged(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const grouped = await ProjectGetter.promises.findAllUsersProjects(userId, {
      name: true,
      lastUpdated: true,
    })
    const all = flattenProjects(grouped)
    const { limit, page } = parsePagination(req.query)
    const start = (page - 1) * limit
    res.json({
      projects: all.slice(start, start + limit),
      total: all.length,
      limit,
      page,
    })
  }),

  downloadProject: expressify(async function downloadProject(req, res) {
    const projectId = req.params.project_id
    // 与既有 zip 下载一致：先 flush docstore，避免下载到未落盘内容
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
    const meta = await DesktopSyncLastModified.getProjectLastModified(projectId)
    const stream = await createZipStreamForProject(projectId)
    res.set('X-Project-LastModified', String(meta.lastModified))
    // HTTP 头只允许 latin1，项目名可能含中文 -> 用 encodeURIComponent 编码
    res.set('X-Project-Name', encodeURIComponent(meta.name))
    prepareZipAttachment(res, `${meta.name}.zip`)
    stream.pipe(res)
  }),
}
