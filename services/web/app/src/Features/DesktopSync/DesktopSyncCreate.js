const fsPromises = require('fs/promises')
const { expressify } = require('@overleaf/promise-utils')
const SessionManager = require('../Authentication/SessionManager')
const ProjectCreationHandler = require('../Project/ProjectCreationHandler')
const ProjectDetailsHandler = require('../Project/ProjectDetailsHandler')
const {
  InvalidZipFileError,
  EmptyZipFileError,
  ZipContentsTooLargeError,
} = require('../Uploads/ArchiveErrors')
const Errors = require('../Errors/Errors')
const DesktopSyncUpload = require('./DesktopSyncUpload')
const DesktopSyncLastModified = require('./DesktopSyncLastModified')

// 项目名来源优先级：multipart 字段 name > 请求头 X-Project-Name（URL 编码）。
// 请求头只允许 latin1，中文项目名必须由客户端 encodeURIComponent 后放入。
function resolveProjectName(req) {
  const fromBody = req.body && req.body.name
  if (typeof fromBody === 'string' && fromBody.trim() !== '') {
    return fromBody.trim()
  }
  const fromHeader = req.get('X-Project-Name')
  if (fromHeader) {
    try {
      return decodeURIComponent(fromHeader).trim()
    } catch (err) {
      // 非法百分号编码：原样使用，交给 validateProjectName 判定
      return fromHeader.trim()
    }
  }
  return ''
}

module.exports = {
  _resolveProjectName: resolveProjectName,

  // POST /api/sync/projects
  // 语义：用 zip 整包创建一个新项目（覆盖逻辑与 upload 完全一致 —— 先建空项目，
  // 再把 zip 对账进去：新增/更新/删缺失/清空文件夹/修正 root doc）。
  createProject: expressify(async function createProject(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const zipPath = req.file && req.file.path
    if (!zipPath) {
      return res.status(400).json({ message: "missing 'zip' file field" })
    }
    try {
      const projectName = resolveProjectName(req)
      if (!projectName) {
        return res
          .status(400)
          .json({ message: "missing project name (field 'name')" })
      }
      // 与 Web 端创建项目同一套校验（空名/超长/含 '/' 或 '\'）
      await ProjectDetailsHandler.promises.validateProjectName(projectName)

      const project = await ProjectCreationHandler.promises.createBlankProject(
        userId,
        projectName
      )
      const projectId = project._id.toString()

      // 复用 upload 的整包对账逻辑，保证「创建」与「覆盖上传」行为一致
      await DesktopSyncUpload._reconcileFromZip(userId, projectId, zipPath)

      const { lastModified } =
        await DesktopSyncLastModified.getProjectLastModified(projectId)
      res.status(201).json({ id: projectId, name: projectName, lastModified })
    } catch (err) {
      // 与 uploadProject 保持一致的 4xx 映射
      if (
        err instanceof InvalidZipFileError ||
        err instanceof EmptyZipFileError ||
        err instanceof ZipContentsTooLargeError
      ) {
        return res.status(400).json({ message: 'invalid zip file' })
      }
      if (err instanceof Errors.InvalidNameError) {
        return res.status(400).json({ message: 'invalid file name in zip' })
      }
      // FIXED: 2026-11-15 桌面端新建项目同样受项目数 / 单文件大小限制
      if (err instanceof Errors.ProjectLimitExceededError) {
        return res.status(422).json({ message: 'project limit exceeded' })
      }
      if (err instanceof Errors.FileTooLargeError) {
        return res.status(413).json({
          message: 'file too large',
          error: 'file_too_large',
        })
      }
      throw err
    } finally {
      if (zipPath) {
        await fsPromises.unlink(zipPath).catch(() => {})
      }
    }
  }),
}
