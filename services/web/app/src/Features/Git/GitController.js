/**
 * GitController - Git 功能的 API 控制器
 * 处理 Git 仓库的克隆、拉取、推送等操作
 */

const GitService = require('./GitService')
const GitErrorUtil = require('./GitErrorUtil')
const GitUrlUtil = require('./GitUrlUtil')
const { GitConfig } = require('./GitConfig')
const ProjectGetter = require('../Project/ProjectGetter')
const ProjectCreationHandler = require('../Project/ProjectCreationHandler')
const ProjectDeleter = require('../Project/ProjectDeleter')
const ProjectRootDocManager = require('../Project/ProjectRootDocManager')
// 注意：GitController 已不再直接用 DocumentHelper（编译器推断统一走 CompilerDetector）
const CompilerDetector = require('../Compile/CompilerDetector')
const EditorController = require('../Editor/EditorController')
const FileSystemImportManager = require('../Uploads/FileSystemImportManager')
const ProjectEntityMongoUpdateHandler = require('../Project/ProjectEntityMongoUpdateHandler')
const FileStoreHandler = require('../FileStore/FileStoreHandler')
const DocstoreManager = require('../Docstore/DocstoreManager')
const DocumentUpdaterHandler = require('../DocumentUpdater/DocumentUpdaterHandler')
const Doc = require('../../models/Doc').Doc
const SessionManager = require('../Authentication/SessionManager')
const AuthorizationManager = require('../Authorization/AuthorizationManager')
const logger = require('@overleaf/logger')
const fs = require('fs-extra')
const { callbackify } = require('util')
const Path = require('path')
const request = require('request').defaults({ jar: false })
const settings = require('@overleaf/settings')

/**
 * 直接从 document-updater 获取文档内容（最新、未 flush 的版本）
 * 这样可以获取 Redis 中的最新内容，不需要等待 flush 到 MongoDB
 */
async function _getDocFromDocumentUpdater(projectId, docId) {
  return new Promise((resolve, reject) => {
    const url = `${settings.apis.documentupdater.url}/project/${projectId}/doc/${docId}`
    const requestParams = {
      url: url,
      timeout: 30000,
      json: true,
    }

    request.get(requestParams, (error, res, body) => {
      if (error) {
        return reject(error)
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // document-updater 返回的格式: { lines, version, ops, ranges }
        resolve(body)
      } else {
        reject(new Error(`document-updater returned status ${res.statusCode}`))
      }
    })
  })
}

/**
 * 直接从 Docstore 获取最新的文档内容（防缓存）
 * 绕过可能的缓存，直接调用 Docstore API
 */
async function _getDocWithoutCache(projectId, docId) {
  return new Promise((resolve, reject) => {
    const url = `${settings.apis.docstore.url}/project/${projectId}/doc/${docId}`
    // 添加 cache-busting 参数和请求头
    const requestParams = {
      url: url + '?t=' + Date.now(), // cache-busting
      timeout: 30000,
      json: true,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    }

    request.get(requestParams, (error, res, doc) => {
      if (error) {
        return reject(error)
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        logger.debug(
          { docId, projectId, version: doc.version, rev: doc.rev },
          '[DEBUG] got doc from docstore api with no-cache'
        )
        resolve({
          lines: doc.lines,
          rev: doc.rev,
          version: doc.version,
          ranges: doc.ranges,
        })
      } else {
        const err = new Error(`docstore api responded with ${res.statusCode}`)
        reject(err)
      }
    })
  })
}

/**
 * 根据仓库地址识别托管平台，仅用于记录/展示；Git 本身不依赖平台。
 */
function detectGitPlatform(gitUrl) {
  try {
    const hostname = new URL(gitUrl).hostname.toLowerCase()
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
      return 'github'
    }
    if (hostname === 'gitee.com' || hostname.endsWith('.gitee.com')) {
      return 'gitee'
    }
    if (hostname === 'gitlab.com' || hostname.endsWith('.gitlab.com')) {
      return 'gitlab'
    }
  } catch (error) {
    // 非标准 URL 交给 Git 自己处理
  }
  return 'other'
}

/**
 * 将 Git 错误转换为用户友好的错误消息
 */
function _formatGitError(error) {
  const message = error.message || error.toString()

  // 认证失败
  if (
    message.includes('Authentication failed') ||
    message.includes('Incorrect username or password') ||
    message.includes('could not read Username') ||
    message.includes('access denied')
  ) {
    return '认证失败：访问令牌不正确或已过期，请检查您的令牌'
  }

  // 仓库不存在
  if (
    message.includes('could not find') ||
    message.includes('repository not found') ||
    message.includes('404') ||
    message.includes('not found')
  ) {
    return '仓库不存在：请检查仓库地址是否正确'
  }

  // 权限不足
  if (
    message.includes('permission denied') ||
    message.includes('Permission denied') ||
    message.includes('403') ||
    message.includes('Forbidden')
  ) {
    return '权限不足：您没有访问此仓库的权限'
  }

  // 网络问题
  if (
    message.includes('Could not resolve') ||
    message.includes('Connection timed out') ||
    message.includes('network') ||
    message.includes('unable to access')
  ) {
    return '网络错误：无法连接到 Git 服务器，请检查网络连接'
  }

  // 超时
  if (message.includes('timeout') || message.includes('timed out')) {
    return '操作超时：克隆时间过长，请稍后重试'
  }

  // 默认返回通用错误（隐藏技术细节）
  return '导入失败：请检查仓库地址和访问令牌是否正确'
}

/**
 * 克隆 Git 仓库并创建新项目
 * POST /project/from-git
 */
async function cloneFromGit(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { projectName, gitUrl, branch, token } = req.body

  try {
    // 参数验证：不再要求 platform，任何可访问的 Git 仓库都可以导入。
    if (!projectName || !gitUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: projectName, gitUrl',
      })
    }

    const platform = detectGitPlatform(gitUrl)

    // 验证 URL 格式
    try {
      new URL(gitUrl)
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Git URL format',
      })
    }

    logger.info(
      { userId, projectName, gitUrl, platform },
      'cloning project from git'
    )

    // 1. 克隆 Git 仓库到临时目录
    // 使用临时 ID（使用时间戳 + 用户ID生成唯一标识）
    const tempProjectId = `temp_${userId}_${Date.now()}`
    const gitConfig = {
      url: gitUrl,
      branch: branch || 'main',
      platform: platform,
    }

    const tempDir = await GitService.cloneRepository(
      tempProjectId,
      gitConfig,
      token
    )

    // 2. 创建空白项目；按仓库里的 .tex 推断编译器
    //    （魔数注释优先，其次看 \directlua / luacode / xeCJK / fontspec 等特征）
    let compiler = null
    try {
      compiler = await CompilerDetector.detectCompilerFromDirectory(tempDir)
    } catch (error) {
      logger.warn(
        { error, tempDir },
        'failed to detect compiler from git repository'
      )
    }
    const project = await ProjectCreationHandler.promises.createBlankProject(
      userId,
      projectName,
      compiler ? { compiler } : {}
    )

    try {
      // 3. 导入文件到项目
      // 首先扫描目录获取所有文件
      logger.debug({ tempDir }, 'scanning git directory for files')
      const importEntries = await FileSystemImportManager.promises.importDir(
        tempDir,
        userId
      )

      logger.debug(
        { entryCount: importEntries.length },
        'found files in git directory'
      )

      // 创建文件和文档条目
      const fileEntries = []
      const docEntries = []

      for (const importEntry of importEntries) {
        if (!importEntry.projectPath) {
          logger.warn({ importEntry }, 'skipping entry without projectPath')
          continue
        }

        switch (importEntry.type) {
          case 'doc': {
            // 创建文档条目
            const docName = Path.basename(importEntry.projectPath)
            const doc = new Doc({ name: docName })
            await DocstoreManager.promises.updateDoc(
              project._id.toString(),
              doc._id.toString(),
              importEntry.lines,
              0,
              {}
            )
            docEntries.push({
              doc,
              path: importEntry.projectPath,
              docLines: importEntry.lines.join('\n'),
            })
            break
          }
          case 'file': {
            // 创建文件条目
            const fileName = Path.basename(importEntry.projectPath)
            const { fileRef, url } =
              await FileStoreHandler.promises.uploadFileFromDisk(
                project._id,
                { name: fileName },
                importEntry.fsPath
              )
            fileEntries.push({
              file: fileRef,
              path: importEntry.projectPath,
              url,
            })
            break
          }
        }
      }

      logger.debug(
        { docCount: docEntries.length, fileCount: fileEntries.length },
        'prepared entries for import'
      )

      // 批量创建文件夹结构
      await ProjectEntityMongoUpdateHandler.promises.createNewFolderStructure(
        project._id,
        docEntries,
        fileEntries
      )

      // 4. 将临时 Git 目录移动到项目的永久工作目录（用于后续 push/pull）
      await GitService.moveRepository(tempProjectId, project._id)

      // 5. 保存 Git 配置到独立集合
      const gitConfigDoc = new GitConfig({
        projectId: project._id,
        userId: userId,
        url: gitUrl,
        branch: branch || 'main',
        platform: platform,
        lastSync: new Date(),
      })
      await gitConfigDoc.save()

      logger.info(
        { projectId: project._id, userId },
        'git project created successfully'
      )

      res.json({
        success: true,
        projectId: project._id,
        message: 'Project cloned from Git successfully',
      })
    } catch (error) {
      // 如果导入失败，删除已创建的项目
      logger.err(
        { error, projectId: project._id },
        'failed to import git files, cleaning up'
      )
      await ProjectDeleter.promises
        .deleteProject(project._id, userId)
        .catch(err =>
          logger.err(
            { err, projectId: project._id },
            'failed to cleanup project'
          )
        )
      // 清理临时目录
      await GitService.cleanupRepository(tempProjectId).catch(err =>
        logger.err({ err, tempProjectId }, 'failed to cleanup temp directory')
      )
      throw error
    }
  } catch (error) {
    logger.err(
      { error, userId, gitUrl: req.body.gitUrl },
      'failed to clone from git'
    )

    // 将技术错误转换为用户友好的消息
    const errorMessage = _formatGitError(error)

    res.status(500).json({
      success: false,
      error: errorMessage,
    })
  }
}

/**
 * 从 Git 仓库拉取更新
 * POST /project/:Project_id/git/pull
 */
async function pullFromGit(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { Project_id: projectId } = req.params
  // strategy: default / merge / rebase（分叉时用）
  const { token, strategy } = req.body

  try {
    // 获取项目信息（用于权限检查）
    const project = await ProjectGetter.promises.getProject(projectId, {
      owner_ref: 1,
      collaberator_refs: 1,
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    // 权限检查
    const isOwner = project.owner_ref.toString() === userId
    const isCollab = project.collaberator_refs?.some(
      id => id.toString() === userId
    )

    if (!isOwner && !isCollab) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to access this project',
      })
    }

    // 获取 Git 配置
    // token 字段在 schema 里是 select:false，必须显式取出来
    const gitConfig = await GitConfig.findOne({ projectId }).select('+token')

    if (!gitConfig) {
      return res.status(400).json({
        success: false,
        error: 'Project is not linked to a Git repository',
      })
    }

    logger.info({ projectId, userId }, 'pulling from git repository')

    // Pull 更新（令牌可在配置里兜底，私有仓库也能拉）
    const result = await GitService.pullChanges(projectId, gitConfig, token, {
      strategy,
    })

    logger.info({ projectId }, 'importing pulled files to project')

    // 步骤2: 将 git 工作目录中的文件导入到项目
    try {
      const workDir = await GitService.getActualProjectDir(projectId)

      // Pull 后主文档/子文件可能变了，同步更新项目编译器。
      try {
        const compiler = await CompilerDetector.detectCompilerFromDirectory(
          workDir
        )
        if (compiler) {
          await EditorController.promises.setCompiler(projectId, compiler)
        }
      } catch (error) {
        logger.warn(
          { error, projectId },
          'failed to update compiler after git pull'
        )
      }

      // 扫描 git 工作目录中的所有文件
      const importEntries = await FileSystemImportManager.promises.importDir(
        workDir,
        userId
      )

      logger.info(
        { projectId, fileCount: importEntries.length },
        'scanned git directory for pull import'
      )

      // 获取项目的所有文档以更新它们
      const projectFull = await ProjectGetter.promises.getProject(projectId, {
        rootFolder: 1,
      })

      if (!projectFull || !projectFull.rootFolder) {
        logger.warn(
          { projectId },
          'project structure not found for pull import'
        )
        throw new Error('Project structure not found')
      }

      // 建立文件路径到 docId 的映射
      const pathToDocId = new Map()
      const collectDocPaths = (folder, folderPath = '') => {
        if (folder && folder.docs) {
          folder.docs.forEach(docRef => {
            if (docRef && docRef._id && docRef.name) {
              // 构建标准化的路径格式（以 / 开头）
              const docPath = folderPath
                ? `${folderPath}/${docRef.name}`
                : `/${docRef.name}`
              pathToDocId.set(docPath, docRef._id.toString())
            }
          })
        }
        if (folder && folder.folders) {
          folder.folders.forEach(subFolder => {
            if (subFolder && subFolder.name) {
              const subPath = folderPath
                ? `${folderPath}/${subFolder.name}`
                : `/${subFolder.name}`
              collectDocPaths(subFolder, subPath)
            }
          })
        }
      }
      collectDocPaths(projectFull.rootFolder[0])

      // 更新现有文档或创建新文档
      let updatedCount = 0
      let createdCount = 0
      for (const importEntry of importEntries) {
        if (!importEntry.projectPath || importEntry.type !== 'doc') {
          continue
        }

        const docId = pathToDocId.get(importEntry.projectPath)

        if (docId) {
          // 更新现有文档：先获取当前版本号
          try {
            let version = 0
            try {
              const currentDocData = await DocstoreManager.promises.getDoc(
                projectId.toString(),
                docId
              )
              if (
                currentDocData &&
                typeof currentDocData.version === 'number'
              ) {
                version = currentDocData.version
              }
            } catch (err) {
              logger.warn(
                { projectId, docId, error: err.message },
                'failed to get current version for update, using 0'
              )
            }

            await DocstoreManager.promises.updateDoc(
              projectId.toString(),
              docId,
              importEntry.lines,
              version,
              {}
            )
            updatedCount++
            logger.debug(
              { projectId, docId, projectPath: importEntry.projectPath },
              'updated existing document from git'
            )
          } catch (err) {
            logger.warn(
              { projectId, docId, error: err.message },
              'failed to update document from git'
            )
          }
        }
      }

      logger.info(
        { projectId, updatedCount },
        'documents updated from git pull'
      )
    } catch (error) {
      logger.warn(
        { projectId, error: error.message },
        'warning: failed to import pulled files, pull itself was successful'
      )
      // 不中断 pull 操作，即使导入失败
    }

    // 更新配置
    gitConfig.lastSync = new Date()
    if (result.lastCommit) {
      gitConfig.lastCommit = result.lastCommit
    }
    await gitConfig.save()

    res.json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.err({ error, projectId }, 'failed to pull from git')

    // FIXED: 2026-11 拉取失败也要说清楚原因：本地有未提交改动 / 冲突 /
    // 分叉 / 认证失败 / 网络，这些都算「预期内的失败」，
    // 用 200 + reason 返回，让前端给可操作的提示，而不是一句 500。
    const raw = error.fullMessage || error.stderr || error.message || ''
    const classified = GitErrorUtil.classifyPullError(raw)
    res.json({
      success: false,
      pulled: false,
      reason: classified.reason,
      httpStatus: classified.httpStatus,
      error: error.message || 'Failed to pull from repository',
      detail: classified.detail,
    })
  }
}

/**
 * 推送更改到 Git 仓库
 * POST /project/:Project_id/git/push
 */
async function pushToGit(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { Project_id: projectId } = req.params
  const { token, commitMessage } = req.body

  try {
    // 获取项目信息
    const project = await ProjectGetter.promises.getProject(projectId, {
      owner_ref: 1,
      collaberator_refs: 1,
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    // 只有 owner 可以 push
    if (project.owner_ref.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only project owner can push changes',
      })
    }

    // 获取 Git 配置
    const gitConfig = await GitConfig.findOne({ projectId }).select('+token')

    if (!gitConfig) {
      return res.status(400).json({
        success: false,
        error: 'Project is not linked to a Git repository',
      })
    }

    logger.info({ projectId, userId }, 'exporting project files before push')

    logger.info({ projectId }, '=== ENTERING TRY BLOCK ===')

    // 步骤1: 导出项目的当前文本文件到 Git 工作目录
    try {
      logger.info({ projectId }, '=== INSIDE TRY BLOCK - LINE 1 ===')

      // **核心修复：主动触发 flush，模拟浏览器断开连接时的行为**
      // 发现：当浏览器刷新时（断开连接），real-time 服务会调用
      // DocumentUpdaterManager.flushProjectToMongoAndDelete，强制将 Redis 缓冲的
      // 文档同步到 Docstore。这就是为什么刷新后 push 能成功！
      //
      // 解决方案：在 push 前主动调用相同的 flush API
      //
      // 安全说明：
      // - 这个 API 只是将 Redis 中缓冲的文档 flush 到 MongoDB（Docstore）
      // - 不会删除项目、文件或任何用户数据
      // - 完全等价于用户断开编辑器连接时的自动操作
      // - 使用 ?background=true 确保异步执行，不阻塞

      logger.info({ projectId }, '=== BEFORE CRITICAL-FIX ===')
      logger.info(
        { projectId },
        '[CRITICAL-FIX] forcing document flush via document-updater API'
      )

      // 第一步：获取项目的所有文档 ID
      let docIds = []
      try {
        const project = await ProjectGetter.promises.getProject(projectId, {
          rootFolder: 1,
        })
        if (project && project.rootFolder) {
          const collectDocIds = folder => {
            if (!folder) return
            if (folder.docs) {
              folder.docs.forEach(docRef => {
                if (docRef && docRef._id) {
                  docIds.push(docRef._id.toString())
                }
              })
            }
            if (folder.folders) {
              folder.folders.forEach(subFolder => collectDocIds(subFolder))
            }
          }
          collectDocIds(project.rootFolder[0])
        }
        logger.info(
          { projectId, docCount: docIds.length },
          '[CRITICAL-FIX] found documents to flush'
        )
      } catch (err) {
        logger.warn(
          { projectId, error: err.message },
          '[CRITICAL-FIX] failed to get document list'
        )
      }

      // 第二步：逐个刷新文档到 MongoDB
      let flushedCount = 0
      for (const docId of docIds) {
        try {
          await DocumentUpdaterHandler.promises.flushDocToMongo(
            projectId,
            docId
          )
          flushedCount++
          logger.debug(
            { projectId, docId, flushedCount },
            '[CRITICAL-FIX] flushed document to MongoDB'
          )
        } catch (err) {
          logger.warn(
            { projectId, docId, error: err.message },
            '[CRITICAL-FIX] failed to flush document'
          )
        }
      }
      logger.info(
        { projectId, flushedCount, totalDocs: docIds.length },
        '[CRITICAL-FIX] completed flushing all documents'
      )

      // 第三步：调用项目级别的 flush（清理 Redis 缓存）
      try {
        await new Promise((resolve, reject) => {
          const documentUpdaterUrl = settings.apis.documentupdater.url
          const flushUrl = `${documentUpdaterUrl}/project/${projectId}`

          logger.debug(
            { projectId, flushUrl },
            '[CRITICAL-FIX] calling project-level flush to clear Redis cache'
          )

          request.del(flushUrl, { timeout: 30000 }, (error, res, body) => {
            if (error) {
              logger.warn(
                { projectId, error: error.message },
                '[CRITICAL-FIX] project flush request failed'
              )
              reject(error)
            } else if (res.statusCode >= 200 && res.statusCode < 300) {
              logger.info(
                { projectId, statusCode: res.statusCode },
                '[CRITICAL-FIX] project flush succeeded'
              )
              resolve(true)
            } else {
              logger.warn(
                {
                  projectId,
                  statusCode: res.statusCode,
                  body: body ? body.substring(0, 200) : 'empty',
                },
                '[CRITICAL-FIX] project flush returned error status'
              )
              resolve(false)
            }
          })
        })
      } catch (flushErr) {
        logger.warn(
          { projectId, error: flushErr.message },
          '[CRITICAL-FIX] exception during project flush'
        )
      }

      // flush 完成后，等待 2 秒让 MongoDB 完成写入
      logger.debug(
        { projectId },
        '[CRITICAL-FIX] waiting for MongoDB write to complete'
      )
      await new Promise(resolve => setTimeout(resolve, 2000))

      logger.info(
        { projectId },
        '[CRITICAL-FIX] flush complete, now exporting files'
      )

      const workDir = await GitService.getActualProjectDir(projectId)
      logger.info({ projectId, workDir }, 'git working directory for push')

      // 获取所有文档的列表和文件名
      // 策略：从 getAllDocs 获取文档列表，然后从 project 结构获取文件名（因为 getAllDocs 不返回 name）
      logger.info({ projectId }, 'fetching documents for export')

      let docIdToName = {} // 映射：docId -> 文件名
      let docsToExport = []

      try {
        // 首先，从 project 结构获取 docId 到文件名的映射
        const project = await ProjectGetter.promises.getProject(projectId, {
          rootFolder: 1,
        })

        if (!project || !project.rootFolder) {
          logger.warn({ projectId }, 'project has no root folder')
          throw new Error('Project structure not found')
        }

        // 递归遍历项目文件夹结构，建立 docId -> {name, path} 的映射
        const buildDocNameMap = (folder, folderPath = '') => {
          if (!folder || !folder.docs) return
          // 收集当前文件夹中的文档
          folder.docs.forEach(docRef => {
            if (docRef && docRef._id) {
              const docName = docRef.name || docRef._id.toString() + '.tex'
              const relativePath = folderPath
                ? `${folderPath}/${docName}`
                : docName
              docIdToName[docRef._id.toString()] = {
                name: docName,
                path: relativePath,
              }
            }
          })
          // 递归遍历子文件夹
          if (folder.folders) {
            folder.folders.forEach(subFolder => {
              if (subFolder && subFolder.name) {
                const subFolderPath = folderPath
                  ? `${folderPath}/${subFolder.name}`
                  : subFolder.name
                buildDocNameMap(subFolder, subFolderPath)
              }
            })
          }
        }
        buildDocNameMap(project.rootFolder[0])

        logger.info(
          { projectId, mapSize: Object.keys(docIdToName).length },
          'built docId to name mapping from project structure'
        )
      } catch (err) {
        logger.warn(
          { projectId, error: err.message },
          'failed to build docId name mapping, will use docId as fallback'
        )
      }

      try {
        // 现在从 getAllDocs 获取最新的文档列表（这确保我们获取 Docstore 中的最新数据）
        const allDocs = await DocstoreManager.promises.getAllDocs(projectId)
        logger.info(
          { projectId, docCount: allDocs ? allDocs.length : 0 },
          'fetched all documents from docstore'
        )

        if (allDocs && Array.isArray(allDocs)) {
          docsToExport = allDocs.map(doc => {
            const docId = doc._id.toString()
            const docNameInfo = docIdToName[docId]
            const docName = docNameInfo
              ? docNameInfo.name
              : doc._id.toString() + '.tex'
            const relativePath = docNameInfo ? docNameInfo.path : docName

            return {
              docId: docId,
              docName: docName,
              relativePath: relativePath,
            }
          })
        }
      } catch (err) {
        logger.warn(
          { projectId, error: err.message },
          'failed to get all docs from docstore'
        )

        // 如果 getAllDocs 失败，直接用之前建立的映射
        docsToExport = Object.entries(docIdToName).map(([docId, nameInfo]) => ({
          docId: docId,
          docName: nameInfo.name,
          relativePath: nameInfo.path,
        }))
      }

      logger.info(
        { projectId, docCount: docsToExport.length },
        'found documents for export'
      )

      // 关键修复：直接从 document-updater 读取文档，而不是从 Docstore
      // 这样可以获取 Redis 中的最新内容（包括未 flush 到 MongoDB 的修改）
      // 编译 PDF 也是这样做的，所以如果编译能看到最新内容，这个方法也能
      let exportedCount = 0
      for (const { docId, docName, relativePath } of docsToExport) {
        try {
          // 优先从 document-updater 获取文档内容（最新、实时的）
          let docData
          try {
            docData = await _getDocFromDocumentUpdater(
              projectId.toString(),
              docId
            )
            logger.debug(
              { projectId, docId, docName, source: 'document-updater' },
              'fetched document from document-updater (Redis)'
            )
          } catch (err) {
            logger.warn(
              { projectId, docId, error: err.message },
              'failed to fetch from document-updater, falling back to docstore'
            )
            // 回退到 Docstore
            try {
              docData = await _getDocWithoutCache(projectId.toString(), docId)
              logger.debug(
                { projectId, docId, docName, source: 'docstore' },
                'fetched document from docstore (MongoDB)'
              )
            } catch (err2) {
              logger.warn(
                { projectId, docId, error: err2.message },
                'failed to fetch from docstore with no-cache, using regular getDoc'
              )
              docData = await DocstoreManager.promises.getDoc(
                projectId.toString(),
                docId
              )
            }
          }

          logger.debug(
            {
              projectId,
              docId,
              docName,
              relativePath,
              docDataKeys: docData ? Object.keys(docData) : 'null',
              hasLines: docData && Array.isArray(docData.lines),
              linesCount: docData && docData.lines ? docData.lines.length : 0,
              firstFewLines:
                docData && docData.lines ? docData.lines.slice(0, 3) : 'N/A',
            },
            '[DEBUG] docData retrieved'
          )

          if (docData && docData.lines) {
            const lines = docData.lines
            const content = Array.isArray(lines) ? lines.join('\n') : ''
            // 使用 relativePath 保持文件夹结构
            const docPath = Path.join(workDir, relativePath)

            logger.debug(
              {
                projectId,
                docId,
                docName,
                relativePath,
                docPath,
                contentLength: content.length,
                contentPreview: content.substring(0, 200),
                linesArray: lines,
                linesCount: lines.length,
              },
              '[DEBUG] writing document to disk'
            )

            // 确保目录存在
            await fs.ensureDir(Path.dirname(docPath))

            // 写入文档内容
            await fs.writeFile(docPath, content, 'utf8')

            // 验证文件是否真的被写入了，并读回验证内容
            const fileExists = await fs.pathExists(docPath)
            let fileContent = ''
            if (fileExists) {
              fileContent = await fs.readFile(docPath, 'utf8')
            }
            const fileStat = fileExists ? await fs.stat(docPath) : null

            logger.debug(
              {
                projectId,
                docId,
                docPath,
                fileExists,
                fileSize: fileStat ? fileStat.size : 0,
                contentMatch: fileContent === content,
                verifyContentPreview: fileContent.substring(0, 200),
              },
              '[DEBUG] file write verification'
            )

            exportedCount++
            logger.info(
              {
                projectId,
                docId,
                fileName: docName,
                relativePath,
                contentLength: content.length,
              },
              'exported document from docstore'
            )
          } else {
            logger.warn(
              {
                projectId,
                docId,
                docName,
                relativePath,
                docDataIsNull: !docData,
                hasLinesProperty: docData && 'lines' in docData,
              },
              '[DEBUG] docData is invalid or has no lines property'
            )
          }
        } catch (docError) {
          logger.warn(
            {
              projectId,
              docId,
              docName,
              relativePath,
              error: docError.message,
              stack: docError.stack,
            },
            'failed to export document from docstore'
          )
        }
      }

      logger.info(
        { projectId, exportedCount, totalDocs: docsToExport.length },
        'documents exported to git directory for push'
      )
    } catch (error) {
      logger.warn(
        { projectId, error: error.message, stack: error.stack },
        'warning: failed to export project files for push, proceeding anyway'
      )
      // 继续执行 push，即使文件导出失败
    }

    logger.info({ projectId, userId }, 'pushing to git repository')

    // 步骤2: Push 更改
    const result = await GitService.pushChanges(
      projectId,
      gitConfig,
      token,
      commitMessage || 'Update from FlyLaTeX'
    )

    // 更新配置：只有真的推送了才更新 lastSync / lastCommit，
    // 否则「什么都没做」也会把「最后同步」刷成现在，界面上看着像刚同步过。
    if (result.pushed) {
      gitConfig.lastSync = new Date()
      if (result.lastCommit) {
        gitConfig.lastCommit = result.lastCommit
      }
      await gitConfig.save()
    }

    // FIXED: 2026-11 按真实结果返回，不再统一包一层 success:true。
    // 远端拒绝（开源仓库没有写权限、令牌无 push 权限、分支保护…）属于
    // 「预期内的失败」，用 200 + 结构化 reason 返回，前端据此给具体提示。
    res.json({
      success: result.success !== false,
      pushed: !!result.pushed,
      hasChanges: !!result.hasChanges,
      ahead: result.ahead || 0,
      reason: result.reason || null,
      httpStatus: result.httpStatus || null,
      error: result.error || null,
      lastCommit: result.lastCommit || null,
      message: result.message || null,
    })
  } catch (error) {
    logger.err({ error, projectId }, 'failed to push to git')
    // 真正的服务端异常（目录不存在、写盘失败等）
    const reason = /directory not found|not found/i.test(error.message || '')
      ? 'no_local_repository'
      : 'internal_error'
    res.status(500).json({
      success: false,
      reason,
      error: error.message || 'Failed to push to repository',
    })
  }
}

/**
 * 获取项目的 Git 状态
 * GET /project/:Project_id/git/status
 */
async function getGitStatus(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { Project_id: projectId } = req.params

  try {
    // 获取项目信息
    const project = await ProjectGetter.promises.getProject(projectId, {
      owner_ref: 1,
      collaberator_refs: 1,
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    // 权限检查
    const isOwner = project.owner_ref.toString() === userId
    const isCollab = project.collaberator_refs?.some(
      id => id.toString() === userId
    )

    if (!isOwner && !isCollab) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to access this project',
      })
    }

    // 获取 Git 配置
    const gitConfig = await GitConfig.findOne({ projectId })

    if (!gitConfig) {
      return res.json({
        linked: false,
      })
    }

    try {
      // 获取状态
      const status = await GitService.getProjectStatus(projectId, gitConfig)

      res.json({
        linked: true,
        config: {
          url: gitConfig.url,
          branch: gitConfig.branch,
          platform: gitConfig.platform,
          lastSync: gitConfig.lastSync,
        },
        ...status,
      })
    } catch (error) {
      // 如果项目目录不存在或其他错误，返回 linked: false
      logger.warn(
        { projectId, error: error.message },
        'Failed to get git status, project may have been moved or deleted'
      )
      res.json({
        linked: false,
        error:
          'Unable to access repository. The project directory may have been deleted.',
      })
    }
  } catch (error) {
    logger.err({ error, projectId }, 'failed to get git status')
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get Git status',
    })
  }
}

/**
 * 仓库信息（「信息」弹窗用）
 * GET /project/:Project_id/git/info?fetch=1
 *
 * 只读接口：
 *  - 需要项目可读（owner / 协作者，只读协作者也可以看）
 *  - 访问令牌等凭据一律脱敏，明文不出服务端
 *  - fetch=1 时会真的去远端 fetch 一次，用来刷新「是否有最新更新」
 *  - 任何单项取不到都只让字段为空，不整体报错
 */
async function getGitInfo(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { Project_id: projectId } = req.params
  const shouldFetch = req.query.fetch === '1' || req.query.fetch === 'true'

  try {
    const project = await ProjectGetter.promises.getProject(projectId, {
      owner_ref: 1,
      collaberator_refs: 1,
      readOnly_refs: 1,
    })

    if (!project) {
      return res
        .status(404)
        .json({ success: false, error: 'Project not found' })
    }

    const isOwner = project.owner_ref?.toString() === userId
    const isCollab = project.collaberator_refs?.some(
      id => id.toString() === userId
    )
    const isReadOnly = project.readOnly_refs?.some(
      id => id.toString() === userId
    )

    if (!isOwner && !isCollab && !isReadOnly) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to access this project',
      })
    }

    const gitConfig = await GitConfig.findOne({ projectId }).select('+token')

    if (!gitConfig) {
      return res.json({ linked: false })
    }

    const info = await GitService.getRepositoryInfo(projectId, gitConfig, {
      fetch: shouldFetch,
    })

    res.json({
      linked: true,
      canWrite: (isOwner || isCollab) && !isReadOnly,
      canQuery: true,
      config: {
        branch: gitConfig.branch,
        platform: gitConfig.platform,
        lastSync: gitConfig.lastSync,
        lastCommit: gitConfig.lastCommit,
        autoSync: gitConfig.autoSync,
        createdAt: gitConfig.createdAt,
      },
      ...info,
    })
  } catch (error) {
    logger.err({ error, projectId }, 'failed to get git repository info')
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get Git repository info',
    })
  }
}

/**
 * 保存 / 清除访问令牌
 * PUT /project/:Project_id/git/token
 *
 * 为什么需要这个接口：公开仓库用匿名 HTTPS 就能 clone / pull，用户往往是
 * 「改完要 push 时」才发现需要令牌，此时既不能重新 clone，也不该强迫用户
 * 去别的地方找输入框。
 *
 * 安全：
 *  - 令牌只写不读，响应里只给「有没有」和末 4 位（••••abcd）
 *  - 只有项目 owner 能改（推送本身也只允许 owner）
 */
async function saveGitToken(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { Project_id: projectId } = req.params
  const rawToken = req.body && req.body.token

  try {
    const project = await ProjectGetter.promises.getProject(projectId, {
      owner_ref: 1,
    })

    if (!project) {
      return res
        .status(404)
        .json({ success: false, error: 'Project not found' })
    }

    if (project.owner_ref.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only project owner can change the repository token',
      })
    }

    const gitConfig = await GitConfig.findOne({ projectId }).select('+token')
    if (!gitConfig) {
      return res.status(400).json({
        success: false,
        error: 'Project is not linked to a Git repository',
      })
    }

    if (rawToken !== undefined && rawToken !== null) {
      const token = String(rawToken).trim()
      if (token.length > 500) {
        return res.status(400).json({
          success: false,
          error: 'Token is too long',
        })
      }
      // 空字符串 = 清除
      gitConfig.token = token || null
      await gitConfig.save()
      logger.info(
        { projectId, userId, cleared: !token },
        'git access token updated'
      )
    }

    res.json({
      success: true,
      hasToken: !!gitConfig.token,
      credentialMask: gitConfig.token
        ? GitUrlUtil.maskSecret(gitConfig.token)
        : null,
    })
  } catch (error) {
    logger.err({ error, projectId }, 'failed to save git token')
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save token',
    })
  }
}

/**
 * 断开项目与 Git 仓库的连接
 * DELETE /project/:Project_id/git/link
 */
async function disconnectGit(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { Project_id: projectId } = req.params

  try {
    // 获取项目信息
    const project = await ProjectGetter.promises.getProject(projectId, {
      owner_ref: 1,
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    // 只有 owner 可以断开连接
    if (project.owner_ref.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only project owner can disconnect Git repository',
      })
    }

    logger.info({ projectId, userId }, 'disconnecting git repository')

    // 删除 Git 配置
    await GitConfig.deleteOne({ projectId })

    // 清理本地 Git 目录
    await GitService.disconnectProject(projectId)

    res.json({
      success: true,
      message: 'Disconnected from Git repository',
    })
  } catch (error) {
    logger.err({ error, projectId }, 'failed to disconnect git')
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to disconnect Git repository',
    })
  }
}

module.exports = {
  cloneFromGit,
  pullFromGit,
  pushToGit,
  getGitStatus,
  getGitInfo,
  saveGitToken,
  disconnectGit,
}
