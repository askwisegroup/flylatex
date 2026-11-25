const AuthorizationMiddleware = require('../Authorization/AuthorizationMiddleware')
const AuthenticationController = require('../Authentication/AuthenticationController')
const ProjectUploadController = require('./ProjectUploadController')
const { RateLimiter } = require('../../infrastructure/RateLimiter')
const RateLimiterMiddleware = require('../Security/RateLimiterMiddleware')

const rateLimiters = {
  projectUpload: new RateLimiter('project-upload', {
    points: 20,
    duration: 60,
  }),
  fileUpload: new RateLimiter('file-upload', {
    points: 200,
    duration: 60 * 15,
  }),
}

module.exports = {
  apply(webRouter) {
    webRouter.post(
      '/project/new/upload',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.projectUpload),
      ProjectUploadController.multerMiddleware,
      ProjectUploadController.checkStorageQuota,
      ProjectUploadController.uploadProject
    )

    const fileUploadEndpoint = '/Project/:Project_id/upload'
    const fileUploadRateLimit = RateLimiterMiddleware.rateLimit(
      rateLimiters.fileUpload,
      {
        params: ['Project_id'],
      }
    )
    // FIXED: 2026-11-14 上传路由不再按 Settings.allowAnonymousReadAndWriteSharing 分支。
    // OLD: if (Settings.allowAnonymousReadAndWriteSharing) { <本段> }
    //      else { ...AuthenticationController.requireLogin(), <其余同上> }
    // 那个开关为假时，匿名可编辑的分享链接连图片都传不上去；它的取值又由
    // 环境变量/部署档位决定，属于纯配置造成的产品行为分裂。
    // 写权限仍由 ensureUserCanWriteProjectContent 逐项目校验（含 token）。
    webRouter.post(
      fileUploadEndpoint,
      fileUploadRateLimit,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      ProjectUploadController.multerMiddleware,
      ProjectUploadController.checkStorageQuota,
      ProjectUploadController.uploadFile
    )
  },
}
