/* eslint-disable
    max-len,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let ProjectUploadController
const logger = require('@overleaf/logger')
const metrics = require('@overleaf/metrics')
const fs = require('fs')
const Path = require('path')
const FileSystemImportManager = require('./FileSystemImportManager')
const ProjectUploadManager = require('./ProjectUploadManager')
const SessionManager = require('../Authentication/SessionManager')
const Settings = require('@overleaf/settings')
const { InvalidZipFileError } = require('./ArchiveErrors')
const multer = require('multer')
const _ = require('lodash')
const UserGetter = require('../User/UserGetter')
const UserVip = require('../User/UserVip')
const UserLimits = require('../User/UserLimits')
const {
  FileTooLargeError,
  ProjectLimitExceededError,
  StorageQuotaExceededError,
} = require('../Errors/Errors')

function buildUpload(fileSize) {
  return multer(
    _.defaultsDeep(
      {
        dest: Settings.path.uploadFolder,
        limits: { fileSize },
      },
      Settings.multerOptions
    )
  )
}

// FIXED: 2026-11-15 普通用户单个文件 10MB，VIP 沿用全局上限。
// 项目 zip 不按「单个文档」限制，仍走全局 50MB；但会额外检查磁盘配额。
const normalFileUpload = buildUpload(
  UserVip.getLimitsForUser(null).maxUploadSize
)
const projectZipUpload = buildUpload(Settings.maxUploadSize)
const vipFileUpload = buildUpload(Settings.maxUploadSize)

module.exports = ProjectUploadController = {
  uploadProject(req, res, next) {
    const timer = new metrics.Timer('project-upload')
    const userId = SessionManager.getLoggedInUserId(req.session)
    const { path } = req.file
    const name = Path.basename(req.body.name, '.zip')
    return ProjectUploadManager.createProjectFromZipArchive(
      userId,
      name,
      path,
      function (error, project) {
        fs.unlink(path, function () {})
        timer.done()
        if (error != null) {
          logger.error(
            { err: error, filePath: path, fileName: name },
            'error uploading project'
          )
          if (error instanceof InvalidZipFileError) {
            return res.status(422).json({
              success: false,
              error: req.i18n.translate(error.message),
            })
          } else if (
            error instanceof ProjectLimitExceededError ||
            error instanceof StorageQuotaExceededError
          ) {
            return res.status(422).json({
              success: false,
              error: req.i18n.translate(
                error instanceof ProjectLimitExceededError
                  ? 'project_limit_exceeded'
                  : 'storage_quota_exceeded'
              ),
            })
          } else if (error instanceof FileTooLargeError) {
            return res.status(422).json({
              success: false,
              error: req.i18n.translate('file_too_large'),
            })
          } else {
            return res.status(500).json({
              success: false,
              error: req.i18n.translate('upload_failed'),
            })
          }
        } else {
          // 上传成功后清掉 usage 缓存，避免下一次上传还按旧用量判断。
          UserLimits.invalidateUsage(userId)
          return res.json({ success: true, project_id: project._id })
        }
      }
    )
  },

  uploadFile(req, res, next) {
    const timer = new metrics.Timer('file-upload')
    const name = req.body.name
    const path = req.file != null ? req.file.path : undefined
    const projectId = req.params.Project_id
    const { folder_id: folderId } = req.query
    if (name == null || name.length === 0 || name.length > 150) {
      logger.err(
        { projectId, fileName: name },
        'bad name when trying to upload file'
      )
      return res.status(422).json({
        success: false,
        error: 'invalid_filename',
      })
    }
    const userId = SessionManager.getLoggedInUserId(req.session)

    return FileSystemImportManager.addEntity(
      userId,
      projectId,
      folderId,
      name,
      path,
      true,
      function (error, entity) {
        fs.unlink(path, function () {})
        timer.done()
        if (error != null) {
          logger.error(
            {
              err: error,
              projectId,
              filePath: path,
              fileName: name,
              folderId,
            },
            'error uploading file'
          )
          if (error.name === 'InvalidNameError') {
            return res.status(422).json({
              success: false,
              error: 'invalid_filename',
            })
          } else if (error.message === 'project_has_too_many_files') {
            return res.status(422).json({
              success: false,
              error: 'project_has_too_many_files',
            })
          } else if (error instanceof FileTooLargeError) {
            return res.status(422).json({
              success: false,
              error: req.i18n.translate('file_too_large'),
            })
          } else if (error instanceof StorageQuotaExceededError) {
            return res.status(422).json({
              success: false,
              error: req.i18n.translate('storage_quota_exceeded'),
            })
          } else {
            return res.status(422).json({ success: false })
          }
        } else {
          UserLimits.invalidateUsage(userId)
          return res.json({
            success: true,
            entity_id: entity != null ? entity._id : undefined,
            entity_type: entity != null ? entity.type : undefined,
          })
        }
      }
    )
  },

  multerMiddleware(req, res, next) {
    const send = upload => {
      if (upload == null) {
        return res
          .status(500)
          .json({ success: false, error: req.i18n.translate('upload_failed') })
      }
      return upload.single('qqfile')(req, res, function (err) {
        if (
          err instanceof multer.MulterError &&
          err.code === 'LIMIT_FILE_SIZE'
        ) {
          return res.status(422).json({
            success: false,
            error: req.i18n.translate('file_too_large'),
          })
        }

        return next(err)
      })
    }

    // FIXED: 2026-11-15 项目 zip 上传不区分用户，普通用户也允许 50MB 的 zip；
    // 编辑器里的单文件上传才按 10MB / 50MB 区分。
    if (!req.params.Project_id) {
      return send(projectZipUpload)
    }

    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!userId) {
      return send(normalFileUpload)
    }

    return UserGetter.promises
      .getUser(userId, { vipEndDate: 1, vipExpired: 1 })
      .then(user => {
        return send(UserVip.isVipUser(user) ? vipFileUpload : normalFileUpload)
      })
      .catch(err => {
        logger.warn(
          { err, userId },
          'failed to check vip status for upload, fallback to normal limit'
        )
        return send(normalFileUpload)
      })
  },

  // FIXED: 2026-11-15 普通用户磁盘用量上限 256MB（VIP 2GB）。
  // 在 multer 落盘之后、真正导入项目之前检查，超限时删除临时文件。
  checkStorageQuota(req, res, next) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!userId || !req.file) {
      return next()
    }

    // 项目 zip 的压缩包大小不等于解压后的占用，这里只做粗筛；
    // 真正的用量在 ProjectUploadManager 导入完成后按实际大小再检查一次。
    const additionalBytes = req.params.Project_id ? req.file.size : 0
    return UserLimits.assertStorageAvailable(userId, additionalBytes)
      .then(() => next())
      .catch(err => {
        fs.unlink(req.file.path, () => {})
        if (err instanceof StorageQuotaExceededError) {
          return res.status(422).json({
            success: false,
            error: req.i18n.translate('storage_quota_exceeded'),
          })
        }
        return next(err)
      })
  },
}
