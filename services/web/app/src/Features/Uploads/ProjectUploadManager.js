const Path = require('path')
const fs = require('fs-extra')
const { callbackify } = require('util')
const ArchiveManager = require('./ArchiveManager')
const { Doc } = require('../../models/Doc')
const DocstoreManager = require('../Docstore/DocstoreManager')
const DocumentHelper = require('../Documents/DocumentHelper')
const CompilerDetector = require('../Compile/CompilerDetector')
const DocumentUpdaterHandler = require('../DocumentUpdater/DocumentUpdaterHandler')
const FileStoreHandler = require('../FileStore/FileStoreHandler')
const FileSystemImportManager = require('./FileSystemImportManager')
const ProjectCreationHandler = require('../Project/ProjectCreationHandler')
const ProjectEntityMongoUpdateHandler = require('../Project/ProjectEntityMongoUpdateHandler')
const ProjectRootDocManager = require('../Project/ProjectRootDocManager')
const ProjectDetailsHandler = require('../Project/ProjectDetailsHandler')
const ProjectDeleter = require('../Project/ProjectDeleter')
const TpdsProjectFlusher = require('../ThirdPartyDataStore/TpdsProjectFlusher')
const UserLimits = require('../User/UserLimits')
const logger = require('@overleaf/logger')

module.exports = {
  createProjectFromZipArchive: callbackify(createProjectFromZipArchive),
  createProjectFromZipArchiveWithName: callbackify(
    createProjectFromZipArchiveWithName
  ),
  promises: {
    createProjectFromZipArchive,
    createProjectFromZipArchiveWithName,
  },
}

async function createProjectFromZipArchive(ownerId, defaultName, zipPath) {
  const contentsPath = await _extractZip(zipPath)
  const { path, content } =
    await ProjectRootDocManager.promises.findRootDocFileFromDirectory(
      contentsPath
    )

  const projectName =
    DocumentHelper.getTitleFromTexContent(content || '') || defaultName
  const uniqueName = await _generateUniqueName(ownerId, projectName)
  // FIXED: 2026-10-23 导入 zip 时读取主文档的 `% !TeX program = ...`，
  // 直接以对应编译器初始化项目，避免用户再手动切换。
  // FIXED: 2026-11 没有魔数注释时，按所有 .tex 里的引擎特征推断
  // （LuaLaTeX 的 \directlua / luacode 经常写在章节子文件里，只看主文档会漏）。
  const compiler = await CompilerDetector.detectCompilerFromDirectory(
    contentsPath,
    content
  )
  let project
  try {
    project = await ProjectCreationHandler.promises.createBlankProject(
      ownerId,
      uniqueName,
      compiler ? { compiler } : {}
    )
  } catch (err) {
    // 项目数超限等创建失败时，别把解压目录留在临时目录里。
    await fs.remove(contentsPath)
    throw err
  }
  try {
    await _initializeProjectWithZipContents(ownerId, project, contentsPath)

    // FIXED: 2026-11-15 zip 里可能有大量小文件，单个文件不超限但总量超限。
    // 导入完成后按真实用量再检查一次，超限则走下面的 ProjectDeleter 回滚。
    UserLimits.invalidateUsage(ownerId)
    await UserLimits.assertStorageAvailable(ownerId, 0)

    if (path) {
      await ProjectRootDocManager.promises.setRootDocFromName(project._id, path)
    }
  } catch (err) {
    await fs.remove(contentsPath).catch(() => {})
    // no need to wait for the cleanup here
    ProjectDeleter.promises
      .deleteProject(project._id)
      .then(() => UserLimits.invalidateUsage(ownerId))
      .catch(err =>
        logger.error(
          { err, projectId: project._id },
          'there was an error cleaning up project after importing a zip failed'
        )
      )
    throw err
  }
  await fs.remove(contentsPath)
  return project
}

async function createProjectFromZipArchiveWithName(
  ownerId,
  proposedName,
  zipPath,
  attributes = {}
) {
  const contentsPath = await _extractZip(zipPath)
  const uniqueName = await _generateUniqueName(ownerId, proposedName)
  let project
  try {
    project = await ProjectCreationHandler.promises.createBlankProject(
      ownerId,
      uniqueName,
      attributes
    )
  } catch (err) {
    await fs.remove(contentsPath)
    throw err
  }

  try {
    await _initializeProjectWithZipContents(ownerId, project, contentsPath)
    UserLimits.invalidateUsage(ownerId)
    await UserLimits.assertStorageAvailable(ownerId, 0)
    await ProjectRootDocManager.promises.setRootDocAutomatically(project._id)
  } catch (err) {
    await fs.remove(contentsPath).catch(() => {})
    // no need to wait for the cleanup here
    ProjectDeleter.promises
      .deleteProject(project._id)
      .then(() => UserLimits.invalidateUsage(ownerId))
      .catch(err =>
        logger.error(
          { err, projectId: project._id },
          'there was an error cleaning up project after importing a zip failed'
        )
      )
    throw err
  }
  await fs.remove(contentsPath)
  return project
}

async function _extractZip(zipPath) {
  const destination = Path.join(
    Path.dirname(zipPath),
    `${Path.basename(zipPath, '.zip')}-${Date.now()}`
  )
  await ArchiveManager.promises.extractZipArchive(zipPath, destination)
  return destination
}

async function _generateUniqueName(ownerId, originalName) {
  const fixedName = ProjectDetailsHandler.fixProjectName(originalName)
  const uniqueName = await ProjectDetailsHandler.promises.generateUniqueName(
    ownerId,
    fixedName
  )
  return uniqueName
}

async function _initializeProjectWithZipContents(
  ownerId,
  project,
  contentsPath
) {
  const topLevelDir = await ArchiveManager.promises.findTopLevelDirectory(
    contentsPath
  )
  // 注意：这里是「整个 project zip」导入，zip 本身已受 50MB 上传上限约束，
  // 不再按单文件 10MB 卡 zip 内部文件（普通用户 10MB 限制针对编辑器单文件上传）。
  const importEntries = await FileSystemImportManager.promises.importDir(
    topLevelDir
  )
  const { fileEntries, docEntries } = await _createEntriesFromImports(
    project._id,
    importEntries
  )
  const projectVersion =
    await ProjectEntityMongoUpdateHandler.promises.createNewFolderStructure(
      project._id,
      docEntries,
      fileEntries
    )
  await _notifyDocumentUpdater(project, ownerId, {
    newFiles: fileEntries,
    newDocs: docEntries,
    newProject: { version: projectVersion },
  })
  await TpdsProjectFlusher.promises.flushProjectToTpds(project._id)
}

async function _createEntriesFromImports(projectId, importEntries) {
  const fileEntries = []
  const docEntries = []
  for (const importEntry of importEntries) {
    switch (importEntry.type) {
      case 'doc': {
        const docEntry = await _createDoc(
          projectId,
          importEntry.projectPath,
          importEntry.lines
        )
        docEntries.push(docEntry)
        break
      }
      case 'file': {
        const fileEntry = await _createFile(
          projectId,
          importEntry.projectPath,
          importEntry.fsPath
        )
        fileEntries.push(fileEntry)
        break
      }
      default: {
        throw new Error(`Invalid import type: ${importEntry.type}`)
      }
    }
  }
  return { fileEntries, docEntries }
}

async function _createDoc(projectId, projectPath, docLines) {
  const docName = Path.basename(projectPath)
  const doc = new Doc({ name: docName })
  await DocstoreManager.promises.updateDoc(
    projectId.toString(),
    doc._id.toString(),
    docLines,
    0,
    {}
  )
  return { doc, path: projectPath, docLines: docLines.join('\n') }
}

async function _createFile(projectId, projectPath, fsPath) {
  const fileName = Path.basename(projectPath)
  const { fileRef, url } = await FileStoreHandler.promises.uploadFileFromDisk(
    projectId,
    { name: fileName },
    fsPath
  )
  return { file: fileRef, path: projectPath, url }
}

async function _notifyDocumentUpdater(project, userId, changes) {
  const projectHistoryId =
    project.overleaf && project.overleaf.history && project.overleaf.history.id
  await DocumentUpdaterHandler.promises.updateProjectStructure(
    project._id,
    projectHistoryId,
    userId,
    changes,
    null
  )
}
