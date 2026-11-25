const fs = require('fs')
const fsPromises = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const multer = require('multer')
const Settings = require('@overleaf/settings')
const { expressify } = require('@overleaf/promise-utils')
const SessionManager = require('../Authentication/SessionManager')
const ProjectEntityHandler = require('../Project/ProjectEntityHandler')
const ProjectUpdateHandler = require('../Project/ProjectUpdateHandler')
const ProjectRootDocManager = require('../Project/ProjectRootDocManager')
const DocumentUpdaterHandler = require('../DocumentUpdater/DocumentUpdaterHandler')
const EditorController = require('../Editor/EditorController')
const UpdateMerger = require('../ThirdPartyDataStore/UpdateMerger')
const ArchiveManager = require('../Uploads/ArchiveManager')
const FileTypeManager = require('../Uploads/FileTypeManager')
const {
  InvalidZipFileError,
  EmptyZipFileError,
  ZipContentsTooLargeError,
} = require('../Uploads/ArchiveErrors')
const Errors = require('../Errors/Errors')
const UserLimits = require('../User/UserLimits')
const DesktopSyncLastModified = require('./DesktopSyncLastModified')

const SOURCE = 'desktop-sync'
const LINE_SPLIT = /\r\n|\r|\n/

// 服务端兜底忽略规则（窄名单：宁可少删也不错删）。
// 忽略路径在「对比域」之外：既不会被 upsert，也不会因 zip 缺失而被删除。
const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db'])
const IGNORED_EXTENSIONS = [
  '.aux',
  '.bbl',
  '.blg',
  '.fdb_latexmk',
  '.fls',
  '.out',
  '.toc',
  '.lof',
  '.lot',
  '.lol',
  '.synctex.gz',
  '.nav',
  '.snm',
  '.vrb',
  '.bcf',
  '.run.xml',
]
const IGNORED_SEGMENTS = new Set(['.git', '__MACOSX'])

function isIgnoredRelPath(relPath) {
  const segments = relPath.split('/')
  if (segments.some(segment => IGNORED_SEGMENTS.has(segment))) {
    return true
  }
  const base = segments[segments.length - 1]
  if (IGNORED_BASENAMES.has(base)) {
    return true
  }
  return IGNORED_EXTENSIONS.some(ext => base.endsWith(ext))
}

// multer：字段名固定为 'zip'（与桌面端对齐，见设计文档 5.3）
const upload = multer({
  dest: Settings.path.uploadFolder,
  limits: { fileSize: Settings.maxUploadSize },
})

function md5File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = fs.createReadStream(absPath)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// 递归收集解压后的期望文件集（相对路径统一用 '/' 分隔）
async function walkFiles(rootDir) {
  const result = []
  async function walk(dir, rel) {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      // 安全：不跟随符号链接
      if (entry.isSymbolicLink()) {
        continue
      }
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      const absPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absPath, relPath)
      } else if (entry.isFile() && !isIgnoredRelPath(relPath)) {
        result.push({ relPath, absPath })
      }
    }
  }
  await walk(rootDir, '')
  return result
}

// 项目实体路径约定：根目录为 '/'，根下实体路径始终带前导斜杠（如 '/main.tex'）。
// ProjectEntityHandler.getAllEntities / ProjectLocator / UpdateMerger 都遵循该约定，
// 而解压后的 relPath（'main.tex'）不带斜杠 —— 两套域混用会造成「全部删除」的灾难性误判。
function toProjectPath(relPath) {
  return `/${relPath}`
}

// 读取项目实体。根目录缺失（例如被误删）时 getAllEntities 会抛
// 'Error getting folders'，此时任何写入都会失败；转成可诊断的错误，
// 避免只留下一个含糊的 500。
async function readProjectEntities(projectId) {
  try {
    return await ProjectEntityHandler.promises.getAllEntities(projectId)
  } catch (err) {
    throw new Errors.NotFoundError(
      `cannot sync project ${projectId}: failed to read entities (${err.message}); ` +
        'the project root folder may be missing, restore the project before syncing'
    )
  }
}

function linesEqual(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((line, i) => line === b[i])
  )
}

// 清理空文件夹（整包覆盖语义：zip 无法表达空目录，空文件夹不属于期望状态）。
// 最深优先单遍即可：emptiness 只取决于是否存在 doc/file 后代，删空文件夹不改变该判定。
async function pruneEmptyFolders(projectId, userId) {
  const { docs, files, folders } =
    await ProjectEntityHandler.promises.getAllEntities(projectId)
  const sorted = [...folders].sort(
    (a, b) => b.path.split('/').length - a.path.split('/').length
  )
  for (const folder of sorted) {
    // 根目录绝不可删：_getAllFoldersFromProject 给根目录的 path 是 '/'，
    // 且 ProjectLocator.findElementByPath('/') 会返回根文件夹本身，
    // 删除它会 $pull 掉 project.rootFolder，使整个项目不可再用。
    if (!folder.path || folder.path === '/') {
      continue
    }
    const prefix = `${folder.path}/`
    const hasEntities =
      docs.some(d => d.path.startsWith(prefix)) ||
      files.some(f => f.path.startsWith(prefix))
    if (hasEntities) {
      continue
    }
    try {
      // 注意 EditorController.deleteEntityWithPath 参数顺序是 (projectId, path, source, userId)
      await EditorController.promises.deleteEntityWithPath(
        projectId,
        folder.path,
        SOURCE,
        userId
      )
    } catch (err) {
      if (!(err instanceof Errors.NotFoundError)) {
        throw err
      }
    }
  }
}

module.exports = {
  multerMiddleware(req, res, next) {
    upload.single('zip')(req, res, err => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'zip file too large' })
      }
      if (err) {
        return next(err)
      }
      if (!req.file) {
        return res.status(400).json({ message: "missing 'zip' file field" })
      }
      return next()
    })
  },

  // 401/409 前置到 multer 之前：X-Base-LastModified 走请求头，避免白传大文件。
  // 先 flush（确保 docstore 已落盘，lastUpdated/latest 内容为准），再比对时间戳。
  precheckUpload: expressify(async function precheckUpload(req, res, next) {
    const projectId = req.params.project_id
    const base = Number(req.get('X-Base-LastModified'))
    if (!Number.isFinite(base) || base < 0) {
      return res
        .status(400)
        .json({ message: 'missing or invalid X-Base-LastModified header' })
    }
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
    const { lastModified } =
      await DesktopSyncLastModified.getProjectLastModified(projectId)
    if (base !== lastModified) {
      return res.status(409).json({
        currentLastModified: lastModified,
        message: 'project has changed on the server',
      })
    }
    return next()
  }),

  uploadProject: expressify(async function uploadProject(req, res) {
    const projectId = req.params.project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const zipPath = req.file.path
    try {
      await module.exports._reconcileFromZip(userId, projectId, zipPath)
      const { lastModified } =
        await DesktopSyncLastModified.getProjectLastModified(projectId)
      res.json({ lastModified })
    } catch (err) {
      // 预期内的客户端错误在这里映射为 4xx JSON；
      // publicApiRouter 后挂的 handleApiError 只区分 404/其余 500，不能依赖它。
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
      if (err instanceof Errors.FileTooLargeError) {
        return res.status(413).json({
          message: 'file too large',
          error: 'file_too_large',
        })
      }
      throw err
    } finally {
      await fsPromises.unlink(zipPath).catch(() => {})
    }
  }),

  _isIgnoredRelPath: isIgnoredRelPath,
  _pruneEmptyFolders: pruneEmptyFolders,
  _reconcileFromDirectory,

  // 暴露给单测/技术验证使用：整包覆盖（新增/更新/删缺失）
  async _reconcileFromZip(userId, projectId, zipPath) {
    const tmpDir = path.join(
      Settings.path.uploadFolder,
      `desktopsync-${crypto.randomUUID()}`
    )
    await fsPromises.mkdir(tmpDir, { recursive: true })
    try {
      await ArchiveManager.promises.extractZipArchive(zipPath, tmpDir)
      const rootDir =
        await ArchiveManager.promises.findTopLevelDirectory(tmpDir)
      return await _reconcileFromDirectory(userId, projectId, rootDir)
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(
        () => {}
      )
    }
  },
}

/**
 * 用目录内容整包覆盖项目（新增/更新/删缺失）。
 *
 * FIXED: 2026-11-11 从 _reconcileFromZip 抽出核心逻辑，供「回滚到某版本」复用。
 * OLD: 这段逻辑内联在 _reconcileFromZip 里（先解压再对账），
 *      回滚拿到的是 project-history 的快照目录，不需要先打 zip 再解开。
 * zip 路径与目录路径现在共用同一份对账实现，避免两套「覆盖语义」走偏。
 *
 * @param {string} userId
 * @param {string} projectId
 * @param {string} rootDir 已解压/已落盘的源目录（其内容即期望的项目状态）
 */
async function _reconcileFromDirectory(userId, projectId, rootDir) {
  const expected = await walkFiles(rootDir)
  // FIXED: 2026-11-15 桌面同步/版本回滚也按用户检查单文件大小（普通用户 10MB）。
  for (const item of expected) {
    const stat = await fsPromises.stat(item.absPath)
    await UserLimits.assertFileSizeAllowed(userId, stat.size)
  }
  // 空期望集等价于「清空整个项目」，这是最危险的一种整包覆盖。
  // 正常同步不会出现（桌面端总会带上项目文件），直接拒绝以免误删。
  if (expected.length === 0) {
    throw new EmptyZipFileError()
  }
  // 统一到项目实体路径域（'/main.tex'），与 docsByPath/filesByPath 的键一致
  const expectedPaths = new Set(
    expected.map(item => toProjectPath(item.relPath))
  )

  const { docs, files } = await readProjectEntities(projectId)
  const docsByPath = new Map(docs.map(d => [d.path, d.doc]))
  const filesByPath = new Map(files.map(f => [f.path, f.file]))

  // 1) 删除：源目录中缺失的实体（忽略规则内的路径在对比域之外，不删）
  for (const entity of [...docs, ...files]) {
    if (isIgnoredRelPath(entity.path)) {
      continue
    }
    if (expectedPaths.has(entity.path)) {
      continue
    }
    try {
      // 注意 EditorController.deleteEntityWithPath 参数顺序是 (projectId, path, source, userId)
      await EditorController.promises.deleteEntityWithPath(
        projectId,
        entity.path,
        SOURCE,
        userId
      )
    } catch (err) {
      if (!(err instanceof Errors.NotFoundError)) {
        throw err
      }
    }
  }

  // 2) 新增/更新：内容未变化的跳过，避免无谓地推高 rev / 写 history
  for (const item of expected) {
    const entityPath = toProjectPath(item.relPath)
    const existingDoc = docsByPath.get(entityPath)
    const existingFile = filesByPath.get(entityPath)
    if (existingDoc) {
      const type = await FileTypeManager.promises.getType(
        entityPath,
        item.absPath,
        'doc'
      )
      if (!type.binary) {
        const content = await fsPromises.readFile(item.absPath, 'utf8')
        const current = await ProjectEntityHandler.promises.getDoc(
          projectId,
          existingDoc._id
        )
        if (current && linesEqual(current.lines, content.split(LINE_SPLIT))) {
          continue
        }
      }
    } else if (existingFile && existingFile.hash) {
      const hash = await md5File(item.absPath)
      if (hash === existingFile.hash) {
        continue
      }
    }
    await UpdateMerger.promises._mergeUpdate(
      userId,
      projectId,
      // 带前导 '/'：无斜杠时顶层文件的 Path.dirname 会变成 '.'，
      // mkdirp/upsert 随即抛 InvalidNameError。
      entityPath,
      item.absPath,
      SOURCE
    )
  }

  // 3) 清理空文件夹
  await pruneEmptyFolders(projectId, userId)

  // 4) root doc 修正：root 缺失/失效时自动重选（现成 API）
  await ProjectRootDocManager.promises.ensureRootDocumentIsValid(projectId)

  // 5) 显式推进 lastUpdated：仅删除的同步也要更新时间戳，否则客户端永远 409
  await ProjectUpdateHandler.promises.markAsUpdated(
    projectId,
    new Date(),
    userId
  )
}
