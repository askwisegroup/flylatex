const UserGetter = require('./UserGetter')
const OError = require('@overleaf/o-error')
const UserSessionsManager = require('./UserSessionsManager')
const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')
const AuthenticationController = require('../Authentication/AuthenticationController')
const SessionManager = require('../Authentication/SessionManager')
const NewsletterManager = require('../Newsletter/NewsletterManager')
const SubscriptionLocator = require('../Subscription/SubscriptionLocator')
const _ = require('lodash')
const { expressify } = require('@overleaf/promise-utils')
const Features = require('../../infrastructure/Features')
const SplitTestHandler = require('../SplitTests/SplitTestHandler')
const AiChatHistoryHandler = require('../Chat/AiChatHistoryHandler')
const path = require('path')
const fs = require('fs').promises
const { ObjectId } = require('mongodb')
const { db } = require('../../infrastructure/mongodb')

const USER_DETAILS_PATH = path.join(__dirname, '../../../../scripts/users_detail.json')
let userDetailsCache = null
let lastCacheTime = 0
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24小时缓存

/**
 * 清除用户详情缓存（供其他模块调用）
 */
function clearUserDetailsCache() {
  userDetailsCache = null
  lastCacheTime = 0
  logger.debug('[UserPagesController] User details cache cleared')
}

/**
 * 清除特定用户的缓存数据
 */
function clearUserDetailsCacheForUser(email) {
  if (userDetailsCache && userDetailsCache[email]) {
    delete userDetailsCache[email]
  }
  // 强制重新加载整个缓存文件，确保获取最新数据
  lastCacheTime = 0
  logger.debug({ email }, '[UserPagesController] User details cache cleared and will reload on next access')
}

/**
 * Login metadata straight from the user document.
 *
 * `lastLoggedIn` is stored already shifted to +08:00 by the login handlers
 * (see AuthenticationController._recordSuccessfulLogin), so it is formatted
 * the same way the JSON snapshot used to be: read the components as UTC.
 */
async function readLiveLogin(userId) {
  if (!userId || !ObjectId.isValid(userId)) {
    return null
  }
  try {
    const user = await db.users.findOne(
      { _id: new ObjectId(userId) },
      { projection: { lastLoggedIn: 1, lastLoginIp: 1 } }
    )
    if (!user) return null
    return {
      lastLogin: user.lastLoggedIn
        ? new Date(user.lastLoggedIn).toISOString().replace('T', ' ').slice(0, 19)
        : null,
      lastLoginIp: user.lastLoginIp || '未知'
    }
  } catch (err) {
    logger.warn({ err, userId }, '[UserPagesController] cannot read login metadata')
    return null
  }
}

async function getUserDetail(email, userId, req) {
  try {
    const now = Date.now()
    
    // 如果缓存过期或不存在，重新读取文件
    if (!userDetailsCache || (now - lastCacheTime) > CACHE_TTL) {
      const data = await fs.readFile(USER_DETAILS_PATH, 'utf8')
      userDetailsCache = JSON.parse(data)
      lastCacheTime = now

      // 处理所有用户的时间
      for (const email in userDetailsCache) {
        if (userDetailsCache[email].lastLogin) {
          const localDate = new Date(userDetailsCache[email].lastLogin)
          userDetailsCache[email].lastLogin = localDate.toISOString().replace('T', ' ').slice(0, 19)
          // 确保lastLoginIp存在，如果不存在设置为未知
          userDetailsCache[email].lastLoginIp = userDetailsCache[email].lastLoginIp || req.headers['x-real-ip'] || '未知'
        }
      }
    }

    const baseUserDetail = userDetailsCache[email] || {
      totalSize: 0,
      totalSizeInMB: "0.00",
      documentCount: 0,
      lastLogin: null,
      lastLoginIp: '未知'
    }

    // 「上次登录」以账号文档为准，不读 users_detail.json：
    // 那个文件是按 email 建的快照，同邮箱的历史重复账号会让它显示成
    // 另一个账号一年前的登录时间，而页面看起来完全正常。
    const liveLogin = await readLiveLogin(userId)

    // 从数据库获取实际的 tokens 使用情况
    let tokens = 0
    try {
      tokens = await AiChatHistoryHandler.getUserTotalTokens(userId)
      console.log(`[UserPagesController] ✓ Got tokens for user ${email}: ${tokens}`)
    } catch (err) {
      logger.error({ userId, email, err }, '[UserPagesController] Failed to get tokens from database')
      console.error(`[UserPagesController] ✗ Failed to get tokens: ${err.message}`)
      tokens = baseUserDetail.tokens || 0
    }

    return {
      ...baseUserDetail,
      ...(liveLogin || {}),
      tokens
    }
  } catch (err) {
    logger.error({ err }, 'Error reading user details')
    return null
  }
}

async function settingsPage(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const reconfirmationRemoveEmail = req.query.remove
  // SSO
  const ssoError = req.session.ssoError
  if (ssoError) {
    delete req.session.ssoError
  }
  const ssoErrorMessage = req.session.ssoErrorMessage
  if (ssoErrorMessage) {
    delete req.session.ssoErrorMessage
  }
  const projectSyncSuccessMessage = req.session.projectSyncSuccessMessage
  if (projectSyncSuccessMessage) {
    delete req.session.projectSyncSuccessMessage
  }
  // Institution SSO
  let institutionLinked = _.get(req.session, ['saml', 'linked'])
  if (institutionLinked) {
    // copy object if exists because _.get does not
    institutionLinked = Object.assign(
      {
        hasEntitlement: _.get(req.session, ['saml', 'hasEntitlement']),
      },
      institutionLinked
    )
  }
  const samlError = _.get(req.session, ['saml', 'error'])
  const institutionEmailNonCanonical = _.get(req.session, [
    'saml',
    'emailNonCanonical',
  ])
  const institutionRequestedEmail = _.get(req.session, [
    'saml',
    'requestedEmail',
  ])

  const reconfirmedViaSAML = _.get(req.session, ['saml', 'reconfirmed'])
  delete req.session.saml
  let shouldAllowEditingDetails = true
  if (Settings.ldap && Settings.ldap.updateUserDetailsOnLogin) {
    shouldAllowEditingDetails = false
  }
  if (Settings.saml && Settings.saml.updateUserDetailsOnLogin) {
    shouldAllowEditingDetails = false
  }
  const oauthProviders = Settings.oauthProviders || {}

  const user = await UserGetter.promises.getUser(userId)
  if (!user) {
    // The user has just deleted their account.
    return UserSessionsManager.revokeAllUserSessions({ _id: userId }, [], () =>
      res.redirect('/')
    )
  }

  let showPersonalAccessToken =
    !Features.hasFeature('saas') || req.query?.personal_access_token === 'true'

  // if not already enabled, use a split test to determine whether to offer personal access tokens
  let optionalPersonalAccessToken = false
  if (!showPersonalAccessToken) {
    try {
      const { variant } = await SplitTestHandler.promises.getAssignment(
        req,
        res,
        'personal-access-token'
      )
      optionalPersonalAccessToken = variant === 'enabled' // `?personal-access-token=enabled`
    } catch (error) {
      logger.error(
        { err: error },
        'Failed to get personal-access-token split test assignment'
      )
    }
  }

  let personalAccessTokens = []
  let personalAccessTokensEnabled = showPersonalAccessToken || optionalPersonalAccessToken
  if (personalAccessTokensEnabled) {
    try {
      // 尝试加载模块，如果不存在则忽略
      const PersonalAccessTokenManager = require('../../../../modules/oauth2-server/app/src/OAuthPersonalAccessTokenManager')
      personalAccessTokens = await PersonalAccessTokenManager.listTokens(user._id)
    } catch (error) {
      logger.warn({ err: error }, 'Personal access tokens feature not available')
      // 如果模块不存在，将这些功能标记为不可用
      personalAccessTokensEnabled = false
    }
  }

  let currentManagedUserAdminEmail
  try {
    currentManagedUserAdminEmail = await SubscriptionLocator.promises.getAdminEmail(req.managedBy)
  } catch (err) {
    logger.error({ err }, 'error getting subscription admin email')
  }

  const userEmail = user.email
  const userDetail = await getUserDetail(userEmail, user._id, req)

  // FIXED: 2026-05-15 添加VIP状态和配额信息
  // FIXED: 2026-10-23 统一按账号级别判断：vipEndDate 有效且未被标记过期
  const isVip = Boolean(
    user.vipEndDate && user.vipEndDate > new Date() && user.vipExpired !== true
  )
  const isVipExpired = user.vipExpired === true
  const vipDaysRemaining = user.vipEndDate ? 
    Math.ceil((user.vipEndDate - new Date()) / (1000 * 60 * 60 * 24)) : 
    null

  res.render('user/settings', {
    title: 'account_settings',
    user: {
      id: user._id,
      isAdmin: user.isAdmin,
      email: user.email,
      allowedFreeTrial: user.allowedFreeTrial,
      first_name: user.first_name,
      last_name: user.last_name,
      alphaProgram: user.alphaProgram,
      betaProgram: user.betaProgram,
      labsProgram: user.labsProgram,
      // FIXED: 2026-10-23 getMeta('ol-user').features 现在由 UserGetter 读取时补齐默认值，
      // 这里再兜一层，避免历史文档完全没有 features 时整页 500。
      features: {
        dropbox: user.features?.dropbox,
        github: user.features?.github,
        mendeley: user.features?.mendeley,
        zotero: user.features?.zotero,
        references: user.features?.references,
        compileTimeout: user.features?.compileTimeout,
        collaborators: user.features?.collaborators,
      },
      refProviders: {
        mendeley: Boolean(user.refProviders?.mendeley),
        zotero: Boolean(user.refProviders?.zotero),
      },
      institution: user.institution,
      // FIXED: 2026-10-23 机构来源（ne=自动同步 / manual=人工确认），用于设置页说明
      institutionSource: user.institutionSource || '',
      // FIXED: 2026-05-15 添加VIP相关信息
      vipStatus: {
        isVip: isVip,
        isExpired: isVipExpired,
        vipEndDate: user.vipEndDate,
        daysRemaining: vipDaysRemaining,
      },
    },
    hasPassword: !!user.hashedPassword,
    shouldAllowEditingDetails,
    oauthProviders: UserPagesController._translateProviderDescriptions(
      oauthProviders,
      req
    ),
    institutionLinked,
    samlError,
    institutionEmailNonCanonical:
      institutionEmailNonCanonical && institutionRequestedEmail
        ? institutionEmailNonCanonical
        : undefined,
    reconfirmedViaSAML,
    reconfirmationRemoveEmail,
    samlBeta: req.session.samlBeta,
    ssoErrorMessage,
    thirdPartyIds: UserPagesController._restructureThirdPartyIds(user),
    projectSyncSuccessMessage,
    showPersonalAccessToken: personalAccessTokensEnabled,
    optionalPersonalAccessToken: personalAccessTokensEnabled && optionalPersonalAccessToken,
    personalAccessTokens,
    emailAddressLimit: Settings.emailAddressLimit,
    isManagedAccount: !!req.managedBy,
    userRestrictions: Array.from(req.userRestrictions || []),
    currentManagedUserAdminEmail,
    metaData: {
      'ol-userDetail': userDetail || {
        totalSize: 0,
        totalSizeInMB: "0.00",
        documentCount: 0,
        tokens: 0
      }
    }
  })
}

const UserPagesController = {
  registerPage(req, res) {
    const sharedProjectData = {
      project_name: req.query.project_name,
      user_first_name: req.query.user_first_name,
    }

    const newTemplateData = {}
    if (req.session.templateData != null) {
      newTemplateData.templateName = req.session.templateData.templateName
    }

    res.render('user/register', {
      title: 'register',
      sharedProjectData,
      newTemplateData,
      samlBeta: req.session.samlBeta,
    })
  },

  loginPage(req, res) {
    // FIXED: 2026-11-13 已登录用户访问 /login 时直接跳走。
    // OLD: 无条件渲染登录页，导致右上角已经是「账户/退出」的用户
    //      还停留在登录页，点了按钮又会二次登录。
    const loggedInUserId = SessionManager.getLoggedInUserId(req.session)
    if (loggedInUserId) {
      const target =
        AuthenticationController._getRedirectFromSession(req) || '/project'
      return res.redirect(target)
    }
    // if user is being sent to /login with explicit redirect (redir=/foo),
    // such as being sent from the editor to /login, then set the redirect explicitly
    if (
      req.query.redir != null &&
      AuthenticationController._getRedirectFromSession(req) == null
    ) {
      AuthenticationController.setRedirectInSession(req, req.query.redir)
    }
    // FIXED: 2026-11-12 登录页改为按提供方注册表渲染。
    // OLD: res.render('user/login', { title: 'login' })
    // 模板需要知道「有哪些登录方式」，而不是自己写死 NE / CARSI。
    const googleProvider = Features.loginProviderEnabled('google')
      ? Settings.loginProviders.google
      : null
    res.render('user/login', {
      title: 'login',
      loginProviders: Features.enabledLoginProviders(),
      googleClientId: googleProvider ? googleProvider.clientId : '',
    })
  },

  /**
   * Landing page for users who may have received one-time login
   * tokens from the read-only maintenance site.
   *
   * We tell them that Overleaf is back up and that they can login normally.
   */
  oneTimeLoginPage(req, res, next) {
    res.render('user/one_time_login')
  },

  renderReconfirmAccountPage(req, res) {
    const pageData = {
      reconfirm_email: req.session.reconfirm_email,
    }
    // when a user must reconfirm their account
    res.render('user/reconfirm', pageData)
  },

  settingsPage: expressify(settingsPage),

  sessionsPage(req, res, next) {
    const user = SessionManager.getSessionUser(req.session)
    logger.debug({ userId: user._id }, 'loading sessions page')
    const currentSession = {
      ip_address: req.headers['x-real-ip'] || user.ip_address,
      session_created: user.session_created,
    }
    UserSessionsManager.getAllUserSessions(
      user,
      [req.sessionID],
      (err, sessions) => {
        if (err != null) {
          OError.tag(err, 'error getting all user sessions', {
            userId: user._id,
          })
          return next(err)
        }
        res.render('user/sessions', {
          title: 'sessions',
          currentSession,
          sessions,
        })
      }
    )
  },

  emailPreferencesPage(req, res, next) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    UserGetter.getUser(
      userId,
      { _id: 1, email: 1, first_name: 1, last_name: 1 },
      (err, user) => {
        if (err != null) {
          return next(err)
        }
        NewsletterManager.subscribed(user, (err, subscribed) => {
          if (err != null) {
            OError.tag(err, 'error getting newsletter subscription status')
            return next(err)
          }
          res.render('user/email-preferences', {
            title: 'newsletter_info_title',
            subscribed,
          })
        })
      }
    )
  },

  _restructureThirdPartyIds(user) {
    // 3rd party identifiers are an array of objects
    // this turn them into a single object, which
    // makes data easier to use in template
    if (
      !user.thirdPartyIdentifiers ||
      user.thirdPartyIdentifiers.length === 0
    ) {
      return null
    }
    return user.thirdPartyIdentifiers.reduce((obj, identifier) => {
      obj[identifier.providerId] = identifier.externalUserId
      return obj
    }, {})
  },

  _translateProviderDescriptions(providers, req) {
    const result = {}
    if (providers) {
      for (const provider in providers) {
        const data = providers[provider]
        data.description = req.i18n.translate(
          data.descriptionKey,
          Object.assign({}, data.descriptionOptions)
        )
        result[provider] = data
      }
    }
    return result
  },

  // 清除用户详情缓存
  clearUserDetailsCache() {
    clearUserDetailsCache()
  },

  // 清除特定用户的缓存
  clearUserDetailsCacheForUser(email) {
    clearUserDetailsCacheForUser(email)
  },
}

module.exports = UserPagesController
