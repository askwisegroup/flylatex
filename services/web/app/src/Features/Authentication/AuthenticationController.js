const AuthenticationManager = require('./AuthenticationManager')
const SessionManager = require('./SessionManager')
const OError = require('@overleaf/o-error')
const LoginRateLimiter = require('../Security/LoginRateLimiter')
const UserUpdater = require('../User/UserUpdater')
const Metrics = require('@overleaf/metrics')
const logger = require('@overleaf/logger')
const querystring = require('querystring')
const Settings = require('@overleaf/settings')
const basicAuth = require('basic-auth')
const tsscmp = require('tsscmp')
const UserHandler = require('../User/UserHandler')
const UserSessionsManager = require('../User/UserSessionsManager')
const SessionStoreManager = require('../../infrastructure/SessionStoreManager')
const Analytics = require('../Analytics/AnalyticsManager')
const passport = require('passport')
const NotificationsBuilder = require('../Notifications/NotificationsBuilder')
const UrlHelper = require('../Helpers/UrlHelper')
const AsyncFormHelper = require('../Helpers/AsyncFormHelper')
const _ = require('lodash')
const UserAuditLogHandler = require('../User/UserAuditLogHandler')
const AnalyticsRegistrationSourceHelper = require('../Analytics/AnalyticsRegistrationSourceHelper')
const {
  acceptsJson,
} = require('../../infrastructure/RequestContentTypeDetection')
const { ParallelLoginError } = require('./AuthenticationErrors')
const { hasAdminAccess } = require('../Helpers/AdminAuthorizationHelper')
const Modules = require('../../infrastructure/Modules')
// FIXED: 2026-11-12 首次登录赠送额度（覆盖密码 / 短信 / CARSI / Google 全部登录方式）
const Billing = require('../Billing')
const {
  decodeLoginPassword,
} = require('../../../../commercial/ne-auth-v2/password-transport')

function send401WithChallenge(res) {
  res.setHeader('WWW-Authenticate', 'OverleafLogin')
  res.sendStatus(401)
}

function checkCredentials(userDetailsMap, user, password) {
  const expectedPassword = userDetailsMap.get(user)
  const userExists = userDetailsMap.has(user) && expectedPassword // user exists with a non-null password
  const isValid = userExists && tsscmp(expectedPassword, password)
  if (!isValid) {
    logger.err({ user }, 'invalid login details')
  }
  Metrics.inc('security.http-auth.check-credentials', 1, {
    path: userExists ? 'known-user' : 'unknown-user',
    status: isValid ? 'pass' : 'fail',
  })
  return isValid
}

const AuthenticationController = {
  serializeUser(user, callback) {
    if (!user._id || !user.email) {
      const err = new Error('serializeUser called with non-user object')
      logger.warn({ user }, err.message)
      return callback(err)
    }
    const lightUser = {
      _id: user._id,
      first_name: user.first_name,
      last_name: user.last_name,
      isAdmin: user.isAdmin,
      staffAccess: user.staffAccess,
      email: user.email,
      referal_id: user.referal_id,
      session_created: new Date().toISOString(),
      ip_address: user._login_req_ip,
      must_reconfirm: user.must_reconfirm,
      v1_id: user.overleaf != null ? user.overleaf.id : undefined,
      analyticsId: user.analyticsId || user._id,
      alphaProgram: user.alphaProgram || undefined, // only store if set
      betaProgram: user.betaProgram || undefined, // only store if set
      // FIXED: 2026-10-16 跨库检索需按「登录标识」查找 NE 令牌：
      //   carsiEmail 始终等于当前登录标识（见 AuthenticationManager._updateAndMergeUser），
      //   account_id 为稳定标识。原 lightUser 未包含二者，下游只能拿 email 猜，
      //   手机号登录（不会改写 email）时会查不到令牌 → 跨库检索报「凭据已失效」。
      carsiEmail: user.carsiEmail || undefined,
      account_id: user.account_id,
      // FIXED: 2026-10-29 主题是全局观感，非编辑器页面（项目列表/账号设置）也要用对样式表。
      // layout-base.pug 读的是 locals.userSettings，而 session 里的 light user 是登录时的快照，
      // 不带上这个字段的话，换主题后换页会退回默认配色。
      overallTheme: user.ace?.overallTheme,
      // FIXED: 2026-11-05 项目列表页的主题快捷切换要判断「用户是否自定义过编辑器主题」，
      // 才能决定要不要跟着换推荐的语法高亮主题，同样放进快照。
      editorTheme: user.ace?.theme,
      // FIXED: 2026-10-30 同上，AI 面板布局也进快照，避免换页后丢设置
      aiPanelLayout: user.ace?.aiPanelLayout,
      // FIXED: 2026-11-01 同上，设置的显示方式也进快照
      settingsPanelMode: user.ace?.settingsPanelMode,
      // FIXED: 2026-11-01 同上，搜索/替换面板位置也进快照
      searchPanelPosition: user.ace?.searchPanelPosition,
      // FIXED: 2026-11-02 同上，自动探测编译器也进快照
      autoDetectCompiler: user.ace?.autoDetectCompiler,
      // FIXED: 2026-11-06 同上，导航栏标题开关也进快照
      navbarShowTitle: user.ace?.navbarShowTitle,
      // FIXED: 2026-11-08 同上，AI 助手默认 LLM 模型也进快照
      aiModel: user.ace?.aiModel,
    }
    callback(null, lightUser)
  },

  deserializeUser(user, cb) {
    cb(null, user)
  },

  passportLogin(req, res, next) {
    // This function is middleware which wraps the passport.authenticate middleware,
    // so we can send back our custom `{message: {text: "", type: ""}}` responses on failure,
    // and send a `{redir: ""}` response on success
    passport.authenticate('local', function (err, user, info) {
      if (err) {
        return next(err)
      }
      if (user) {
        // `user` is either a user object or false
        AuthenticationController.setAuditInfo(req, { method: 'Password login' })
        return AuthenticationController.finishLogin(user, req, res, next)
      } else {
        if (info.redir != null) {
          return res.json({ redir: info.redir })
        } else {
          res.status(info.status || 200)
          delete info.status
          const body = { message: info }
          const { errorReason } = info
          if (errorReason) {
            body.errorReason = errorReason
            delete info.errorReason
          }
          return res.json(body)
        }
      }
    })(req, res, next)
  },

  finishLogin(user, req, res, next) {
    if (user === false) {
      return AsyncFormHelper.redirect(req, res, '/login')
    } // OAuth2 'state' mismatch

    if (Settings.adminOnlyLogin && !hasAdminAccess(user)) {
      return res.status(403).json({
        message: { type: 'error', text: 'Admin only panel' },
      })
    }

    const auditInfo = AuthenticationController.getAuditInfo(req)

    const anonymousAnalyticsId = req.session.analyticsId
    const isNewUser = req.session.justRegistered || false

    Modules.hooks.fire(
      'preFinishLogin',
      req,
      res,
      user,
      function (error, results) {
        if (error) {
          return next(error)
        }
        if (results.some(result => result && result.doNotFinish)) {
          return
        }

        if (user.must_reconfirm) {
          return AuthenticationController._redirectToReconfirmPage(
            req,
            res,
            user
          )
        }

        const redir =
          AuthenticationController._getRedirectFromSession(req) || '/project'
        // FIXED: 2026-11-20 postLoginRedirect 是一次性的，用完必须清。
        //
        // 之前它永远留在 session 里（_clearRedirectFromSession 是死代码）：
        //   · UserPagesController.loginPage 只在「session 里没有」时才认 ?redir=，
        //     于是一个陈旧的落地页会持续劫持后续所有登录；
        //   · 接入 SSO 后更严重：/sso/authorize?state=... 被当成落地页存下来，
        //     下次登录跳回去时 state 已过期、code 已被消费 → 授权失败。
        AuthenticationController._clearRedirectFromSession(req)
        _loginAsyncHandlers(req, user, anonymousAnalyticsId, isNewUser)

        // FIXED: 2026-11-12 首次登录赠送额度。
        //
        // 为什么放在 finishLogin 而不是各个登录控制器里：
        //   这里是密码 / 短信 / CARSI / Google **唯一的共同收尾**，
        //   放一处就覆盖了全部登录方式（需求：每个第一次登录的用户都送）。
        //   幂等键是 `signup-grant:<userId>`，因此老账号在升级后首次登录也会
        //   拿到，且反复登录不会重复发放。
        //
        // 不 await：赠送失败（Mongo 抖动等）绝不能把一次成功的登录变成 500。
        // 失败会打 error 日志，按 userId 可以对账补发。
        Billing.onUserRegistered(user).catch(err =>
          logger.error(
            { err, userId: String(user._id) },
            'failed to grant signup credit'
          )
        )

        const userId = user._id
        UserAuditLogHandler.addEntry(
          userId,
          'login',
          userId,
          req.ip,
          auditInfo,
          err => {
            if (err) {
              return next(err)
            }
            _afterLoginSessionSetup(req, user, function (err) {
              if (err) {
                return next(err)
              }
              AuthenticationController._clearRedirectFromSession(req)
              AnalyticsRegistrationSourceHelper.clearSource(req.session)
              AnalyticsRegistrationSourceHelper.clearInbound(req.session)
              AsyncFormHelper.redirect(req, res, redir)
            })
          }
        )
      }
    )
  },

  /**
   * FIXED: 2026-10-11 认证 V2：短信验证码登录页面入口（表单 name="smsLoginForm"）。
   * 与 passportLogin 结构一致，复用同一套 finishLogin（会话/审计/跳转）。
   */
  smsLogin(req, res, next) {
    passport.authenticate('ne-sms', function (err, user, info) {
      if (err) {
        return next(err)
      }
      if (user) {
        AuthenticationController.setAuditInfo(req, { method: 'SMS login' })
        return AuthenticationController.finishLogin(user, req, res, next)
      }
      if (info && info.redir != null) {
        return res.json({ redir: info.redir })
      }
      const out = info || { text: '短信登录失败', type: 'error', status: 401 }
      res.status(out.status || 200)
      delete out.status
      const body = { message: out }
      const { errorReason } = out
      if (errorReason) {
        body.errorReason = errorReason
        delete out.errorReason
      }
      return res.json(body)
    })(req, res, next)
  },

  /**
   * FIXED: 2026-10-11 认证 V2：短信验证码登录的 passport 校验回调。
   * 与 doPassportLogin 同构（钩子 → 限流 → AuthenticationManager），
   * 但不需要密码，也不需要登录前的人机验证 —— 人机验证在「发送短信」那一步完成。
   */
  doPassportSmsLogin(req, mobile, code, done) {
    const identifier = String(mobile || '').trim()
    if (!identifier || !code) {
      return done(null, false, {
        text: '请输入手机号和短信验证码',
        type: 'error',
        status: 401,
      })
    }

    Modules.hooks.fire('preDoPassportLogin', req, identifier, function (err, infoList) {
      if (err) {
        return done(err)
      }
      const info = (infoList || []).find(i => i != null)
      if (info != null) {
        return done(null, false, info)
      }

      LoginRateLimiter.processLoginRequest(identifier, function (err, isAllowed) {
        if (err) {
          return done(err)
        }
        if (!isAllowed) {
          logger.debug({ identifier }, 'too many sms login requests')
          return done(null, null, {
            text: req.i18n.translate('to_many_login_requests_2_mins'),
            type: 'error',
            status: 429,
          })
        }

        AuthenticationManager.authenticateBySms(
          identifier,
          String(code).trim(),
          function (error, user, info) {
            if (error != null) {
              const errorMessage =
                typeof error === 'string' ? error : error.message
              return done(null, false, {
                text: errorMessage,
                type: 'error',
                status: 401,
              })
            }
            if (user) {
              return done(null, user)
            }
            if (info) {
              return done(null, false, info)
            }
            return done(null, false, {
              text: '短信登录失败',
              type: 'error',
              status: 401,
            })
          }
        )
      })
    })
  },

  doPassportLogin(req, username, password, done) {
    // FIXED: 2026-10-12 Decode SDK browser transport before existing local,
    // temporary CARSI and NE password checks. Older clients keep their contract.
    try {
      password = decodeLoginPassword(
        password,
        req.session,
        req.body && req.body.ne_password_encoding
      )
    } catch (error) {
      return done(null, false, { text: error.message, type: 'error', status: 400 })
    }
    const ip_address = req.headers['x-real-ip'] || req.ip;
    const email = username.toLowerCase()
    Modules.hooks.fire(
      'preDoPassportLogin',
      req,
      email,
      function (err, infoList) {
        if (err) {
          return done(err)
        }
        const info = infoList.find(i => i != null)
        if (info != null) {
          return done(null, false, info)
        }
        LoginRateLimiter.processLoginRequest(email, function (err, isAllowed) {
          if (err) {
            return done(err)
          }
          if (!isAllowed) {
            logger.debug({ email }, 'too many login requests')
            return done(null, null, {
              text: req.i18n.translate('to_many_login_requests_2_mins'),
              type: 'error',
              status: 429,
            })
          }
          const auditLog = {
            ipAddress: ip_address,
            info: { method: 'Password login' },
          }
          // FIXED: 2026-10-11 认证 V2：把登录页提交的人机验证结果透传给用户中心
          // OLD: AuthenticationManager.authenticate({ email }, password, auditLog, ...)
          AuthenticationManager.authenticate(
            { email, captchaVerifyParam: req.body && req.body.captcha_verify_param },
            password,
            auditLog,
            function (error, user, info) {
              console.log('user:', user)
              if (error != null) {
                if (error instanceof ParallelLoginError) {
                  return done(null, false, { status: 429 })
                }
                const errorMessage = typeof error === 'string' ? error : error.message
                return done(null, false, {
                  text: errorMessage,
                  type: 'error',
                  status: 401
                })
              }

              if (
                user &&
                AuthenticationController.captchaRequiredForLogin(req, user)
              ) {
                done(null, false, {
                  text: req.i18n.translate('cannot_verify_user_not_robot'),
                  type: 'error',
                  errorReason: 'cannot_verify_user_not_robot',
                  status: 400,
                })
              }

              if (user) {
                // async actions
                return done(null, user)
              }

              if (info) {
                return done(null, false, info)
              }

              AuthenticationController._recordFailedLogin()
              logger.debug({ email }, 'failed log in')
              done(null, false, {
                text: req.i18n.translate('email_or_password_wrong_try_again'),
                type: 'error',
                status: 401,
              })
            }
          )
        })
      }
    )
  },

  captchaRequiredForLogin(req, user) {
    switch (AuthenticationController.getAuditInfo(req).captcha) {
      case 'disabled':
        return false
      case 'solved':
        return false
      case 'skipped': {
        let required = false
        if (user.lastFailedLogin) {
          const requireCaptchaUntil =
            user.lastFailedLogin.getTime() +
            Settings.elevateAccountSecurityAfterFailedLogin
          required = requireCaptchaUntil >= Date.now()
        }
        Metrics.inc('force_captcha_on_login', 1, {
          status: required ? 'yes' : 'no',
        })
        return required
      }
      default:
        throw new Error('captcha middleware missing in handler chain')
    }
  },

  ipMatchCheck(req, user) {
    return UserUpdater.updateUser(
      user._id.toString(),
      {
        $set: { lastLoginIp: req.headers['x-real-ip'] || req.ip },
      },
      () => { }
    )
  },

  requireLogin() {
    const doRequest = function (req, res, next) {
      if (next == null) {
        next = function () { }
      }
      if (!SessionManager.isUserLoggedIn(req.session)) {
        if (acceptsJson(req)) return send401WithChallenge(res)
        return AuthenticationController._redirectToLoginOrRegisterPage(req, res)
      } else {
        req.user = SessionManager.getSessionUser(req.session)
        return next()
      }
    }

    return doRequest
  },

  requireOauth() {
    // require this here because module may not be included in some versions
    const Oauth2Server = require('../../../../modules/oauth2-server/app/src/Oauth2Server')
    return function (req, res, next) {
      if (next == null) {
        next = function () { }
      }
      const request = new Oauth2Server.Request(req)
      const response = new Oauth2Server.Response(res)
      return Oauth2Server.server.authenticate(
        request,
        response,
        {},
        function (err, token) {
          if (err) {
            // use a 401 status code for malformed header for git-bridge
            if (
              err.code === 400 &&
              err.message === 'Invalid request: malformed authorization header'
            ) {
              err.code = 401
            }
            // send all other errors
            return res
              .status(err.code)
              .json({ error: err.name, error_description: err.message })
          }
          req.oauth = { access_token: token.accessToken }
          req.oauth_token = token
          req.oauth_user = token.user
          return next()
        }
      )
    }
  },

  validateUserSession: function () {
    // Middleware to check that the user's session is still good on key actions,
    // such as opening a a project. Could be used to check that session has not
    // exceeded a maximum lifetime (req.session.session_created), or for session
    // hijacking checks (e.g. change of ip address, req.session.ip_address). For
    // now, just check that the session has been loaded from the session store
    // correctly.
    return function (req, res, next) {
      // check that the session store is returning valid results
      if (req.session && !SessionStoreManager.hasValidationToken(req)) {
        // FIXED: 2026-11-14 未登录访客不再被踢回登录页。
        //
        // 真实场景：访客浏览器里带着一年前种下的 sharelatex.sid，
        // 这个 session 里已经有 anonTokenAccess（分享链接刚授的权），
        // 但没有 validationToken。原来这里立刻 regenerate + 跳 /login，
        // 而 regenerate 会把刚拿到的匿名授权一起丢掉 —— 于是
        // 「点开分享链接 → 被送到 /login?redir=/project/xxx → 登录进去还是没权限」。
        // 未登录访客没有需要保护的登录态，直接放行；
        // 真正的权限判定仍然由 ensureUserCanReadProject 逐项目完成。
        if (!SessionManager.isUserLoggedIn(req.session)) {
          return next()
        }
        // force user to update session
        req.session.regenerate(() => {
          // need to destroy the existing session and generate a new one
          // otherwise they will already be logged in when they are redirected
          // to the login page
          if (acceptsJson(req)) return send401WithChallenge(res)
          AuthenticationController._redirectToLoginOrRegisterPage(req, res)
        })
      } else {
        next()
      }
    }
  },

  _globalLoginWhitelist: [],
  addEndpointToLoginWhitelist(endpoint) {
    return AuthenticationController._globalLoginWhitelist.push(endpoint)
  },

  requireGlobalLogin(req, res, next) {
    if (
      AuthenticationController._globalLoginWhitelist.includes(
        req._parsedUrl.pathname
      )
    ) {
      return next()
    }

    if (req.headers.authorization != null) {
      AuthenticationController.requirePrivateApiAuth()(req, res, next)
    } else if (SessionManager.isUserLoggedIn(req.session)) {
      next()
    } else {
      logger.debug(
        { url: req.url },
        'user trying to access endpoint not in global whitelist'
      )
      if (acceptsJson(req)) return send401WithChallenge(res)
      AuthenticationController.setRedirectInSession(req)
      res.redirect('/login')
    }
  },

  validateAdmin(req, res, next) {
    const adminDomains = Settings.adminDomains
    if (
      !adminDomains ||
      !(Array.isArray(adminDomains) && adminDomains.length)
    ) {
      return next()
    }
    const user = SessionManager.getSessionUser(req.session)
    if (!hasAdminAccess(user)) {
      return next()
    }
    const email = user.email
    if (email == null) {
      return next(
        new OError('[ValidateAdmin] Admin user without email address', {
          userId: user._id,
        })
      )
    }
    if (!adminDomains.find(domain => email.endsWith(`@${domain}`))) {
      return next(
        new OError('[ValidateAdmin] Admin user with invalid email domain', {
          email,
          userId: user._id,
        })
      )
    }
    return next()
  },

  checkCredentials,

  requireBasicAuth: function (userDetails) {
    const userDetailsMap = new Map(Object.entries(userDetails))
    return function (req, res, next) {
      const credentials = basicAuth(req)
      if (
        !credentials ||
        !checkCredentials(userDetailsMap, credentials.name, credentials.pass)
      ) {
        send401WithChallenge(res)
        Metrics.inc('security.http-auth', 1, { status: 'reject' })
      } else {
        Metrics.inc('security.http-auth', 1, { status: 'accept' })
        next()
      }
    }
  },

  requirePrivateApiAuth() {
    return AuthenticationController.requireBasicAuth(Settings.httpAuthUsers)
  },

  setAuditInfo(req, info) {
    if (!req.__authAuditInfo) {
      req.__authAuditInfo = {}
    }
    Object.assign(req.__authAuditInfo, info)
  },

  getAuditInfo(req) {
    return req.__authAuditInfo || {}
  },

  setRedirectInSession(req, value) {
    // FIXED: 2026-11-12 只把「用户真的想访问的页面」记成登录后跳转目标。
    //
    // 现象：点了导航栏的「登录」后，登录成功却落到
    //   /event/menu-clicked-login
    // 然后是一个 404 的「没有找到您查找的页面」。
    //
    // 原因：点击埋点是一次 **POST** /event/menu-clicked-login（sendMB）。
    // 未登录时 requireGlobalLogin 拦下它，而下面这段没有传 value 的分支
    // 会把 `req.path` 原样记进 postLoginRedirect。finishLogin 再把用户送到
    // 这个只接受 POST 的埋点端点，GET 必然 404。
    //
    // 只在 `value == null`（即「记住当前 URL」）时跳过非 GET：显式传 value
    // 的调用方（表单提交后指定落地页）行为不变。
    // OLD: if (value == null) { value = req.path ... }
    if (value == null) {
      if (req.method !== 'GET') return
      value =
        Object.keys(req.query).length > 0
          ? `${req.path}?${querystring.stringify(req.query)}`
          : `${req.path}`
    }
    if (
      req.session != null &&
      !/^\/(socket.io|js|stylesheets|img)\/.*$/.test(value) &&
      !/^.*\.(png|jpeg|svg)$/.test(value)
    ) {
      const safePath = UrlHelper.getSafeRedirectPath(value)
      return (req.session.postLoginRedirect = safePath)
    }
  },

  _redirectToLoginOrRegisterPage(req, res) {
    if (
      req.query.zipUrl != null ||
      req.query.project_name != null ||
      req.path === '/user/subscription/new'
    ) {
      AuthenticationController._redirectToRegisterPage(req, res)
    } else {
      AuthenticationController._redirectToLoginPage(req, res)
    }
  },

  _redirectToLoginPage(req, res) {
    logger.debug(
      { url: req.url },
      'user not logged in so redirecting to login page'
    )
    AuthenticationController.setRedirectInSession(req)
    const url = `/login?${querystring.stringify(req.query)}`
    res.redirect(url)
    Metrics.inc('security.login-redirect')
  },

  _redirectToReconfirmPage(req, res, user) {
    logger.debug(
      { url: req.url },
      'user needs to reconfirm so redirecting to reconfirm page'
    )
    req.session.reconfirm_email = user != null ? user.email : undefined
    const redir = '/user/reconfirm'
    AsyncFormHelper.redirect(req, res, redir)
  },

  _redirectToRegisterPage(req, res) {
    logger.debug(
      { url: req.url },
      'user not logged in so redirecting to register page'
    )
    AuthenticationController.setRedirectInSession(req)
    const url = `/register?${querystring.stringify(req.query)}`
    res.redirect(url)
    Metrics.inc('security.login-redirect')
  },

  _recordSuccessfulLogin(userId, callback) {
    if (callback == null) {
      callback = function () { }
    }
    // 将 UTC 时间转换为东八区时间
    const chinaTime = new Date(new Date().getTime() + (8 * 60 * 60 * 1000));
    UserUpdater.updateUser(
      userId.toString(),
      {
        $set: { lastLoggedIn: chinaTime },
        $inc: { loginCount: 1 },
      },
      function (error) {
        if (error != null) {
          callback(error)
        }
        Metrics.inc('user.login.success')
        callback()
      }
    )
  },

  _recordFailedLogin(callback) {
    Metrics.inc('user.login.failed')
    if (callback) callback()
  },

  _getRedirectFromSession(req) {
    let safePath
    const value = _.get(req, ['session', 'postLoginRedirect'])
    if (value) {
      safePath = UrlHelper.getSafeRedirectPath(value)
    }
    // FIXED: 2026-11-12 兜底：埋点/接口端点不是页面，不能当登录落地页。
    // 修复前写进会话的脏值（如 /event/menu-clicked-login）也会走到这里，
    // 统一退回 /project，不让用户看到 404。
    if (safePath && /^\/(event|api)\//.test(safePath)) {
      return null
    }
    return safePath || null
  },

  _clearRedirectFromSession(req) {
    if (req.session != null) {
      delete req.session.postLoginRedirect
    }
  },
}

function _afterLoginSessionSetup(req, user, callback) {
  if (callback == null) {
    callback = function () { }
  }
  req.login(user, function (err) {
    if (err) {
      OError.tag(err, 'error from req.login', {
        user_id: user._id,
      })
      return callback(err)
    }
    // Regenerate the session to get a new sessionID (cookie value) to
    // protect against session fixation attacks
    const oldSession = req.session
    req.session.destroy(function (err) {
      if (err) {
        OError.tag(err, 'error when trying to destroy old session', {
          user_id: user._id,
        })
        return callback(err)
      }
      req.sessionStore.generate(req)
      // Note: the validation token is not writable, so it does not get
      // transferred to the new session below.
      for (const key in oldSession) {
        const value = oldSession[key]
        if (key !== '__tmp' && key !== 'csrfSecret') {
          req.session[key] = value
        }
      }
      req.session.save(function (err) {
        if (err) {
          OError.tag(err, 'error saving regenerated session after login', {
            user_id: user._id,
          })
          return callback(err)
        }
        UserSessionsManager.trackSession(user, req.sessionID, function () { })
        if (!req.deviceHistory) {
          // Captcha disabled or SSO-based login.
          return callback()
        }
        req.deviceHistory.add(user.email)
        req.deviceHistory
          .serialize(req.res)
          .catch(err => {
            logger.err({ err }, 'cannot serialize deviceHistory')
          })
          .finally(() => callback())
      })
    })
  })
}

function _loginAsyncHandlers(req, user, anonymousAnalyticsId, isNewUser) {
  UserHandler.setupLoginData(user, err => {
    if (err != null) {
      logger.warn({ err }, 'error setting up login data')
    }
  })
  LoginRateLimiter.recordSuccessfulLogin(user.email, () => { })
  AuthenticationController._recordSuccessfulLogin(user._id, () => { })
  AuthenticationController.ipMatchCheck(req, user)
  Analytics.recordEventForUser(user._id, 'user-logged-in', {
    source: req.session.saml
      ? 'saml'
      : req.user_info?.auth_provider || 'email-password',
  })
  Analytics.identifyUser(user._id, anonymousAnalyticsId, isNewUser)

  logger.debug(
    { email: user.email, userId: user._id.toString() },
    'successful log in'
  )

  req.session.justLoggedIn = true
  // capture the request ip for use when creating the session
  return (user._login_req_ip = req.headers['x-real-ip'] || req.ip)
}

module.exports = AuthenticationController
