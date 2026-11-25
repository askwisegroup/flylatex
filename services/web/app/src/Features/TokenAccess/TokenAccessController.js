const SessionManager = require('../Authentication/SessionManager')
const TokenAccessHandler = require('./TokenAccessHandler')
const Errors = require('../Errors/Errors')
const logger = require('@overleaf/logger')
const settings = require('@overleaf/settings')
const OError = require('@overleaf/o-error')
const { expressify } = require('@overleaf/promise-utils')
const AuthorizationManager = require('../Authorization/AuthorizationManager')
const PrivilegeLevels = require('../Authorization/PrivilegeLevels')
const {
  handleAdminDomainRedirect,
} = require('../Authorization/AuthorizationMiddleware')
const ProjectAuditLogHandler = require('../Project/ProjectAuditLogHandler')

const orderedPrivilegeLevels = [
  PrivilegeLevels.NONE,
  PrivilegeLevels.READ_ONLY,
  PrivilegeLevels.READ_AND_WRITE,
  PrivilegeLevels.OWNER,
]

async function _userAlreadyHasHigherPrivilege(userId, projectId, tokenType) {
  if (!Object.values(TokenAccessHandler.TOKEN_TYPES).includes(tokenType)) {
    throw new Error('bad token type')
  }
  if (!userId) {
    return false
  }
  const privilegeLevel =
    await AuthorizationManager.promises.getPrivilegeLevelForProject(
      userId,
      projectId
    )
  return (
    orderedPrivilegeLevels.indexOf(privilegeLevel) >=
    orderedPrivilegeLevels.indexOf(tokenType)
  )
}

const makePostUrl = token => {
  // FIXED: 2026-11-14 与新的 /project/e|r/<token> 路径保持一致
  if (TokenAccessHandler.isReadAndWriteToken(token)) {
    return `/project/e/${token}/grant`
  } else if (TokenAccessHandler.isReadOnlyToken(token)) {
    return `/project/r/${token}/grant`
  } else {
    throw new Error('invalid token type')
  }
}

async function _handleV1Project(token, userId) {
  if (!userId) {
    return { v1Import: { status: 'mustLogin' } }
  } else {
    const docInfo = await TokenAccessHandler.promises.getV1DocInfo(
      token,
      userId
    )
    // This should not happen anymore, but it does show
    // a nice "contact support" message, so it can stay
    if (!docInfo) {
      return { v1Import: { status: 'cannotImport' } }
    }
    if (!docInfo.exists) {
      return null
    }
    if (docInfo.exported) {
      return null
    }
    return {
      v1Import: {
        status: 'canDownloadZip',
        projectId: token,
        hasOwner: docInfo.has_owner,
        name: docInfo.name || 'Untitled',
        brandInfo: docInfo.brand_info,
      },
    }
  }
}

async function tokenAccessPage(req, res, next) {
  const { token } = req.params
  if (!TokenAccessHandler.isValidToken(token)) {
    return next(new Errors.NotFoundError())
  }
  if (handleAdminDomainRedirect(req, res)) {
    // Admin users do not join the project, but view it on the admin domain.
    return
  }
  try {
    if (TokenAccessHandler.isReadOnlyToken(token)) {
      const docPublishedInfo =
        await TokenAccessHandler.promises.getV1DocPublishedInfo(token)
      if (docPublishedInfo.allow === false) {
        return res.redirect(302, docPublishedInfo.published_path)
      }
    }

    // FIXED: 2026-11-14 链接已关闭 / 失效时给友好提示，而不是干巴巴的 404。
    // 两种情况：
    //   a) token 已不在库里（关闭分享会清空 tokens）→ 查不到项目
    //   b) token 还在但 publicAccesLevel 已是 private → 分享实际已关闭
    // settings.overleaf 的 v1 迁移流程保持原样（由前端页面处理）。
    const project = await TokenAccessHandler.promises.getProjectByToken(
      TokenAccessHandler.getTokenType(token),
      token
    )
    const linkIsClosed =
      project == null
        ? !settings.overleaf
        : !TokenAccessHandler.tokenAccessEnabledForProject(project)
    if (linkIsClosed) {
      // FIXED: 2026-11-14 用 200 渲染友好页，不要用 404。
      // 线上外层 nginx 配了 `error_page 404 /404.html`（品牌化的「页面不存在」），
      // 任何 404 的响应体都会被整页替换 —— 我们写的
      // 「分享链接已失效，请联系所有者重新分享」用户根本看不到，
      // 只会看到那张通用 404 图。返回 200，body 才是我们的提示。
      return res.render('project/token/link-closed')
    }

    res.render('project/token/access', {
      postUrl: makePostUrl(token),
    })
  } catch (err) {
    return next(
      OError.tag(err, 'error while rendering token access page', { token })
    )
  }
}

async function checkAndGetProjectOrResponseAction(
  tokenType,
  token,
  userId,
  req,
  res,
  next
) {
  const isAnonymousUser = !userId
  // FIXED: 2026-11-14 删掉「匿名用户不许用可编辑链接」的整段拦截。
  // 它读的是 Settings.allowAnonymousReadAndWriteSharing（档位/环境变量决定），
  // 造成 sg 能用、cn 被送去 /restricted 的两套行为。
  // 现在：所有者既然生成了可编辑链接，未登录访问者凭该链接直接获得编辑权限。
  // Try to get the project, and/or an alternative action to take.
  // Returns a tuple of [project, action]
  const project = await TokenAccessHandler.promises.getProjectByToken(
    tokenType,
    token
  )
  if (!project) {
    if (settings.overleaf) {
      const v1ImportData = await _handleV1Project(token, userId)
      return [
        null,
        () => {
          if (v1ImportData) {
            res.json(v1ImportData)
          } else {
            res.sendStatus(404)
          }
        },
      ]
    } else {
      return [null, null]
    }
  }

  const projectId = project._id
  const tokenAccessEnabled =
    TokenAccessHandler.tokenAccessEnabledForProject(project)
  if (isAnonymousUser && tokenAccessEnabled) {
    if (tokenType === TokenAccessHandler.TOKEN_TYPES.READ_AND_WRITE) {
      logger.debug({ projectId }, 'granting read-write anonymous access')
      TokenAccessHandler.grantSessionTokenAccess(req, projectId, token)
      return [
        null,
        () => {
          res.json({
            redirect: `/project/${projectId}`,
            grantAnonymousAccess: tokenType,
          })
        },
      ]
    } else if (tokenType === TokenAccessHandler.TOKEN_TYPES.READ_ONLY) {
      logger.debug({ projectId }, 'granting read-only anonymous access')
      TokenAccessHandler.grantSessionTokenAccess(req, projectId, token)
      return [
        null,
        () => {
          res.json({
            redirect: `/project/${projectId}`,
            grantAnonymousAccess: tokenType,
          })
        },
      ]
    } else {
      throw new Error('unreachable')
    }
  }
  const userHasPrivilege = await _userAlreadyHasHigherPrivilege(
    userId,
    projectId,
    tokenType
  )
  if (userHasPrivilege) {
    return [
      null,
      () => {
        res.json({ redirect: `/project/${project._id}`, higherAccess: true })
      },
    ]
  }
  if (!tokenAccessEnabled) {
    return [
      null,
      () => {
        next(new Errors.NotFoundError())
      },
    ]
  }
  return [project, null]
}

async function grantTokenAccessReadAndWrite(req, res, next) {
  const { token } = req.params
  const { confirmedByUser, tokenHashPrefix } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!TokenAccessHandler.isReadAndWriteToken(token)) {
    return res.sendStatus(400)
  }
  const tokenType = TokenAccessHandler.TOKEN_TYPES.READ_AND_WRITE

  try {
    const [project, action] = await checkAndGetProjectOrResponseAction(
      tokenType,
      token,
      userId,
      req,
      res,
      next
    )

    TokenAccessHandler.checkTokenHashPrefix(
      token,
      tokenHashPrefix,
      tokenType,
      userId,
      project?._id
    )

    if (action) {
      return action()
    }
    if (!project) {
      // FIXED: 2026-11-14 页面渲染后链接被关闭（竞态）：让前端刷新，
      // 刷新后 GET 会渲染友好提示页。
      // 200 而非 404：否则外层 nginx 的 error_page 404 会把 body 换成
      // HTML 品牌页，前端拿不到 linkClosed 标志。
      return res.json({ linkClosed: true })
    }

    if (!confirmedByUser) {
      return res.json({
        requireAccept: {
          projectName: project.name,
        },
      })
    }

    if (!project.tokenAccessReadAndWrite_refs.some(id => id.equals(userId))) {
      await ProjectAuditLogHandler.promises.addEntry(
        project._id,
        'join-via-token',
        userId,
        req.ip,
        { privileges: 'readAndWrite' }
      )
    }

    await TokenAccessHandler.promises.addReadAndWriteUserToProject(
      userId,
      project._id
    )

    return res.json({
      redirect: `/project/${project._id}`,
      tokenAccessGranted: tokenType,
    })
  } catch (err) {
    return next(
      OError.tag(
        err,
        'error while trying to grant read-and-write token access',
        { token }
      )
    )
  }
}

async function grantTokenAccessReadOnly(req, res, next) {
  const { token } = req.params
  const { confirmedByUser, tokenHashPrefix } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!TokenAccessHandler.isReadOnlyToken(token)) {
    return res.sendStatus(400)
  }

  const tokenType = TokenAccessHandler.TOKEN_TYPES.READ_ONLY

  const docPublishedInfo =
    await TokenAccessHandler.promises.getV1DocPublishedInfo(token)
  if (docPublishedInfo.allow === false) {
    return res.json({ redirect: docPublishedInfo.published_path })
  }
  try {
    const [project, action] = await checkAndGetProjectOrResponseAction(
      tokenType,
      token,
      userId,
      req,
      res,
      next
    )

    TokenAccessHandler.checkTokenHashPrefix(
      token,
      tokenHashPrefix,
      tokenType,
      userId,
      project?._id
    )

    if (action) {
      return action()
    }
    if (!project) {
      // FIXED: 2026-11-14 只读链接同理：链接已关闭时让前端刷新看友好提示页
      // （200 而非 404，避免被外层 nginx 的 error_page 404 换掉）
      return res.json({ linkClosed: true })
    }

    if (!confirmedByUser) {
      return res.json({
        requireAccept: {
          projectName: project.name,
        },
      })
    }

    if (!project.tokenAccessReadOnly_refs.some(id => id.equals(userId))) {
      await ProjectAuditLogHandler.promises.addEntry(
        project._id,
        'join-via-token',
        userId,
        req.ip,
        { privileges: 'readOnly' }
      )
    }

    await TokenAccessHandler.promises.addReadOnlyUserToProject(
      userId,
      project._id
    )

    return res.json({
      redirect: `/project/${project._id}`,
      tokenAccessGranted: tokenType,
    })
  } catch (err) {
    return next(
      OError.tag(err, 'error while trying to grant read-only token access', {
        token,
      })
    )
  }
}

module.exports = {
  READ_ONLY_TOKEN_PATTERN: TokenAccessHandler.READ_ONLY_TOKEN_PATTERN,
  READ_AND_WRITE_TOKEN_PATTERN: TokenAccessHandler.READ_AND_WRITE_TOKEN_PATTERN,

  tokenAccessPage: expressify(tokenAccessPage),
  grantTokenAccessReadOnly: expressify(grantTokenAccessReadOnly),
  grantTokenAccessReadAndWrite: expressify(grantTokenAccessReadAndWrite),
}
