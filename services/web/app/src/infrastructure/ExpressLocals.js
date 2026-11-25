const logger = require('@overleaf/logger')
const Metrics = require('@overleaf/metrics')
const Settings = require('@overleaf/settings')
const querystring = require('querystring')
const _ = require('lodash')
const { URL } = require('url')
const Path = require('path')
const moment = require('moment')
const request = require('request')
const contentDisposition = require('content-disposition')
const Features = require('./Features')
const Billing = require('../Features/Billing')
const SessionManager = require('../Features/Authentication/SessionManager')
const SplitTestMiddleware = require('../Features/SplitTests/SplitTestMiddleware')
const PackageVersions = require('./PackageVersions')
const Modules = require('./Modules')
// FIXED: 2026-11-22 顶部导航的「站点功能菜单」改成配置驱动（Mongo: nav_menus/portal）
const PortalMenu = require('../Features/Navigation/PortalMenu')
const {
  canRedirectToAdminDomain,
  hasAdminAccess,
} = require('../Features/Helpers/AdminAuthorizationHelper')
const {
  addOptionalCleanupHandlerAfterDrainingConnections,
} = require('./GracefulShutdown')
const { expressify } = require('@overleaf/promise-utils')

const IEEE_BRAND_ID = Settings.ieeeBrandId

let webpackManifest
switch (process.env.NODE_ENV) {
  case 'production':
    // Only load webpack manifest file in production.
    webpackManifest = require('../../../public/manifest.json')
    break
  case 'development': {
    // In dev, fetch the manifest from the webpack container.
    loadManifestFromWebpackDevServer()
    const intervalHandle = setInterval(
      loadManifestFromWebpackDevServer,
      10 * 1000
    )
    addOptionalCleanupHandlerAfterDrainingConnections(
      'refresh webpack manifest',
      () => {
        clearInterval(intervalHandle)
      }
    )
    break
  }
  default:
    // In ci, all entries are undefined.
    webpackManifest = {}
}
function loadManifestFromWebpackDevServer(done = function () {}) {
  request(
    {
      uri: `${Settings.apis.webpack.url}/manifest.json`,
      headers: { Host: 'localhost' },
      json: true,
    },
    (err, res, body) => {
      if (!err && res.statusCode !== 200) {
        err = new Error(`webpack responded with statusCode: ${res.statusCode}`)
      }
      if (err) {
        logger.err({ err }, 'cannot fetch webpack manifest')
        return done(err)
      }
      webpackManifest = body
      done()
    }
  )
}
const IN_CI = process.env.NODE_ENV === 'test'
function getWebpackAssets(entrypoint, section) {
  if (IN_CI) {
    // Emit an empty list of entries in CI.
    return []
  }
  return webpackManifest.entrypoints[entrypoint].assets[section] || []
}

module.exports = function (webRouter, privateApiRouter, publicApiRouter) {
  webRouter.use(
    expressify(
      SplitTestMiddleware.loadAssignmentsInLocals([
        'design-system-updates',
        'features-page',
      ])
    )
  )

  if (process.env.NODE_ENV === 'development') {
    // In the dev-env, delay requests until we fetched the manifest once.
    webRouter.use(function (req, res, next) {
      if (!webpackManifest) {
        loadManifestFromWebpackDevServer(next)
      } else {
        next()
      }
    })
  }

  webRouter.use(function (req, res, next) {
    res.locals.session = req.session
    next()
  })

  function addSetContentDisposition(req, res, next) {
    res.setContentDisposition = function (type, { filename }) {
      res.setHeader(
        'Content-Disposition',
        contentDisposition(filename, { type })
      )
    }
    next()
  }
  webRouter.use(addSetContentDisposition)
  privateApiRouter.use(addSetContentDisposition)
  publicApiRouter.use(addSetContentDisposition)

  webRouter.use(function (req, res, next) {
    req.externalAuthenticationSystemUsed =
      Features.externalAuthenticationSystemUsed
    res.locals.externalAuthenticationSystemUsed =
      Features.externalAuthenticationSystemUsed
    req.hasFeature = res.locals.hasFeature = Features.hasFeature
    next()
  })

  webRouter.use(function (req, res, next) {
    let staticFilesBase

    const cdnAvailable =
      Settings.cdn && Settings.cdn.web && !!Settings.cdn.web.host
    const cdnBlocked =
      req.query.nocdn === 'true' || req.session.cdnBlocked || false
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (cdnBlocked && req.session.cdnBlocked == null) {
      logger.debug(
        { userId, ip: req != null ? req.ip : undefined },
        'cdnBlocked for user, not using it and turning it off for future requets'
      )
      Metrics.inc('no_cdn', 1, {
        path: userId ? 'logged-in' : 'pre-login',
        method: 'true',
      })
      req.session.cdnBlocked = true
    }
    Metrics.inc('cdn_blocked', 1, {
      path: userId ? 'logged-in' : 'pre-login',
      method: String(cdnBlocked),
    })
    const host = req.headers && req.headers.host
    const isSmoke = host.slice(0, 5).toLowerCase() === 'smoke'
    if (cdnAvailable && !isSmoke && !cdnBlocked) {
      staticFilesBase = Settings.cdn.web.host
    } else {
      staticFilesBase = ''
    }

    res.locals.buildBaseAssetPath = function () {
      // Return the base asset path (including the CDN url) so that webpack can
      // use this to dynamically fetch scripts (e.g. PDFjs worker)
      return staticFilesBase + '/'
    }

    res.locals.buildJsPath = function (jsFile) {
      return staticFilesBase + webpackManifest[jsFile]
    }

    res.locals.buildCopiedJsAssetPath = function (jsFile) {
      return staticFilesBase + (webpackManifest[jsFile] || '/' + jsFile)
    }

    let runtimeEmitted = false
    const runtimeChunk = webpackManifest['runtime.js']
    res.locals.entrypointScripts = function (entrypoint) {
      // Each "entrypoint" contains the runtime chunk as imports.
      // Loading the entrypoint twice results in broken execution.
      let chunks = getWebpackAssets(entrypoint, 'js')
      if (runtimeEmitted) {
        chunks = chunks.filter(chunk => chunk !== runtimeChunk)
      }
      runtimeEmitted = true
      return chunks.map(chunk => staticFilesBase + chunk)
    }

    res.locals.entrypointStyles = function (entrypoint) {
      const chunks = getWebpackAssets(entrypoint, 'css')
      return chunks.map(chunk => staticFilesBase + chunk)
    }

    res.locals.mathJaxPath = `/js/libs/mathjax/MathJax.js?${querystring.stringify(
      {
        config: 'TeX-AMS_HTML,Safe',
        v: PackageVersions.version.mathjax,
      }
    )}`

    res.locals.mathJax3Path = `/js/libs/mathjax-3-${PackageVersions.version['mathjax-3']}/es5/tex-svg-full.js`

    res.locals.lib = PackageVersions.lib

    res.locals.moment = moment

    res.locals.isIEEE = brandVariation =>
      brandVariation?.brand_id === IEEE_BRAND_ID

    res.locals.getCssThemeModifier = function (userSettings, brandVariation) {
      // Themes only exist in OL v2
      // FIXED: 2026-10-29 本 fork 没有配 Settings.overleaf，主题永远拿不到 modifier，
      // 所以增加 enableOverallThemes 开关（默认 true）作为等效条件。
      // OLD: if (Settings.overleaf != null) {
      if (Settings.overleaf != null || Settings.enableOverallThemes) {
        // The IEEE theme takes precedence over the user personal setting, i.e. a user with
        // a theme setting of "light" will still get the IEE theme in IEEE branded projects.
        if (res.locals.isIEEE(brandVariation)) {
          return 'ieee-'
        } else if (userSettings && userSettings.overallTheme != null) {
          return userSettings.overallTheme
        }
      }
      return ''
    }

    res.locals.buildStylesheetPath = function (cssFileName) {
      return staticFilesBase + webpackManifest[cssFileName]
    }

    res.locals.buildCssPath = function (themeModifier = '') {
      if (
        res.locals.splitTestVariants?.['design-system-updates'] === 'enabled'
      ) {
        themeModifier = `main-${themeModifier}`
      }
      return res.locals.buildStylesheetPath(`${themeModifier}style.css`)
    }

    res.locals.buildImgPath = function (imgFile) {
      const path = Path.join('/img/', imgFile)
      return staticFilesBase + path
    }

    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.translate = req.i18n.translate

    // Don't include the query string parameters, otherwise Google
    // treats ?nocdn=true as the canonical version
    const parsedOriginalUrl = new URL(req.originalUrl, Settings.siteUrl)
    res.locals.currentUrl = parsedOriginalUrl.pathname
    res.locals.currentUrlWithQueryParams =
      parsedOriginalUrl.pathname + parsedOriginalUrl.search
    res.locals.capitalize = function (string) {
      if (string.length === 0) {
        return ''
      }
      return string.charAt(0).toUpperCase() + string.slice(1)
    }
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.getUserEmail = function () {
      const user = SessionManager.getSessionUser(req.session)
      const email = (user != null ? user.email : undefined) || ''
      return email
    }
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.StringHelper = require('../Features/Helpers/StringHelper')
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.buildReferalUrl = function (referalMedium) {
      let url = Settings.siteUrl
      const currentUser = SessionManager.getSessionUser(req.session)
      if (
        currentUser != null &&
        (currentUser != null ? currentUser.referal_id : undefined) != null
      ) {
        url += `?r=${currentUser.referal_id}&rm=${referalMedium}&rs=b` // Referal source = bonus
      }
      return url
    }
    res.locals.getReferalId = function () {
      const currentUser = SessionManager.getSessionUser(req.session)
      if (
        currentUser != null &&
        (currentUser != null ? currentUser.referal_id : undefined) != null
      ) {
        return currentUser.referal_id
      }
    }
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.csrfToken = req != null ? req.csrfToken() : undefined
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.getReqQueryParam = field =>
      req.query != null ? req.query[field] : undefined
    next()
  })

  webRouter.use(function (req, res, next) {
    const currentUser = SessionManager.getSessionUser(req.session)
    if (currentUser != null) {
      res.locals.user = {
        email: currentUser.email,
        first_name: currentUser.first_name,
        last_name: currentUser.last_name,
      }
      // FIXED: 2026-10-29 主题是全局观感：layout-base.pug 用 locals.userSettings
      // 算样式表名，之前只有编辑器页（ProjectController）传了这个值，
      // 项目列表/账号设置页永远落到默认配色。这里从 session 快照里取，不查库。
      // （编辑器页仍用 ProjectController 传的完整对象，render locals 优先级更高）
      res.locals.userSettings = {
        overallTheme: currentUser.overallTheme,
        // FIXED: 2026-10-30 AI 面板布局（editor meta.pug 用）
        aiPanelLayout: currentUser.aiPanelLayout,
        // FIXED: 2026-11-01 设置的显示方式（editor meta.pug 用）
        settingsPanelMode: currentUser.settingsPanelMode,
        // FIXED: 2026-11-01 搜索/替换面板位置
        searchPanelPosition: currentUser.searchPanelPosition,
        // FIXED: 2026-11-02 自动探测编译器（默认关闭）
        autoDetectCompiler: currentUser.autoDetectCompiler === true,
        // FIXED: 2026-11-06 导航栏是否显示标题（默认不显示）
        navbarShowTitle: currentUser.navbarShowTitle === true,
        // FIXED: 2026-11-08 AI 助手默认 LLM 模型
        aiModel: currentUser.aiModel || '',
      }
    }
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.getLoggedInUserId = () =>
      SessionManager.getLoggedInUserId(req.session)
    res.locals.getSessionUser = () => SessionManager.getSessionUser(req.session)
    res.locals.canRedirectToAdminDomain = () =>
      canRedirectToAdminDomain(SessionManager.getSessionUser(req.session))
    res.locals.hasAdminAccess = () =>
      hasAdminAccess(SessionManager.getSessionUser(req.session))
    next()
  })

  webRouter.use(function (req, res, next) {
    // Clone the nav settings so they can be modified for each request
    res.locals.nav = {}
    for (const key in Settings.nav) {
      res.locals.nav[key] = _.clone(Settings.nav[key])
    }
    res.locals.templates = Settings.templateLinks
    next()
  })

  // FIXED: 2026-11-22 站点功能菜单（原来写死在 navbar-marketing.pug 里的
  // 白板 / 论文模板 / TikZ 模板）：数据来自 MongoDB（sharelatex.nav_menus，
  // _id=portal），由运营后台 carsi-mgr 维护，不发版就能加临时入口。
  //
  // 注意三点：
  //  1. PortalMenu.items() 自己兜底，永不出错 —— 读不到库就回退内置三项，
  //     不会让导航栏整块消失（这比「报错」更难治：用户只会觉得少了个入口）；
  //  2. 有 60s 进程内缓存 + stale-while-revalidate，正常请求不会真去查库；
  //  3. 这里按 visibility 预先把菜单拆成「访客可见」和「登录用户可见」两份，
  //     模板只负责画，所有判断都在服务端做完（pug 里判断多了最容易漏）。
  webRouter.use(
    expressify(async function (req, res, next) {
      const items = await PortalMenu.items()
      res.locals.portalMenu = PortalMenu.splitByVisibility(items)
      res.locals.portalMenuLabel = label =>
        PortalMenu.resolveLabel(label, res.locals.currentLngCode)
      next()
    })
  )

  webRouter.use(function (req, res, next) {
    if (Settings.reloadModuleViewsOnEachRequest) {
      Modules.loadViewIncludes()
    }
    res.locals.moduleIncludes = Modules.moduleIncludes
    res.locals.moduleIncludesAvailable = Modules.moduleIncludesAvailable
    next()
  })

  webRouter.use(function (req, res, next) {
    // TODO
    // FIXED: 2026-10-29 同上：不依赖 Settings.overleaf，否则前端拿不到 ol-overallThemes，
    // 设置面板里只剩"编辑器主题"，看不到"全局主题"。
    // OLD: if (Settings.overleaf != null) {
    if (Settings.overleaf != null || Settings.enableOverallThemes) {
      // FIXED: 2026-11-05 导航栏新增「全局主题」快捷切换（原先只能进项目 → 设置 里改）。
      // 这里给每个主题多带一个 editorTheme：选中它时应该一并保存的编辑器（语法高亮）主题，
      // 规则与前端 theme-pairing.ts 保持一致 —— 用户自定义过编辑器主题时为空串，表示别动它。
      // 这样可以只点一次就把 overallTheme / editorTheme 都存对，避免"暖色外壳 + 冷白代码区"。
      const sessionUser = SessionManager.getSessionUser(req.session)
      const recommendedEditorTheme = {
        '': 'textmate',
        'light-': 'eclipse',
        'soft-': 'soft',
      }
      const currentEditorTheme = sessionUser && sessionUser.editorTheme
      const currentRecommended =
        recommendedEditorTheme[(sessionUser && sessionUser.overallTheme) || ''] ||
        'textmate'
      const editorThemeIsCustomised =
        currentEditorTheme == null || currentEditorTheme !== currentRecommended
      const getPairedEditorTheme = themeVal => {
        const recommended = recommendedEditorTheme[themeVal]
        if (editorThemeIsCustomised || !recommended) {
          return ''
        }
        return recommended === currentEditorTheme ? '' : recommended
      }

      // FIXED: 2026-10-29 多主题：新增"柔和色调"。
      // name 保留英文作为回退，nameKey 供前端 i18n 取本地化名称。
      res.locals.overallThemes = [
        {
          name: 'Default',
          nameKey: 'overall_theme_default',
          val: '',
          path: res.locals.buildCssPath(),
          editorTheme: getPairedEditorTheme(''),
        },
        {
          name: 'Light',
          nameKey: 'overall_theme_light',
          val: 'light-',
          path: res.locals.buildCssPath('light-'),
          editorTheme: getPairedEditorTheme('light-'),
        },
        {
          name: 'Soft',
          nameKey: 'overall_theme_soft',
          val: 'soft-',
          path: res.locals.buildCssPath('soft-'),
          editorTheme: getPairedEditorTheme('soft-'),
        },
      ]
    }
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.settings = Settings
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.showThinFooter = !Features.hasFeature('saas')
    next()
  })

  webRouter.use(function (req, res, next) {
    res.locals.ExposedSettings = {
      isOverleaf: Settings.overleaf != null,
      appName: Settings.appName,
      adminEmail: Settings.adminEmail,
      dropboxAppName:
        Settings.apis.thirdPartyDataStore?.dropboxAppName || 'Overleaf',
      hasSamlBeta: req.session.samlBeta,
      hasAffiliationsFeature: Features.hasFeature('affiliations'),
      hasSamlFeature: Features.hasFeature('saml'),
      samlInitPath: _.get(Settings, ['saml', 'ukamf', 'initPath']),
      hasLinkUrlFeature: Features.hasFeature('link-url'),
      hasLinkedProjectFileFeature: Features.hasFeature('linked-project-file'),
      hasLinkedProjectOutputFileFeature: Features.hasFeature(
        'linked-project-output-file'
      ),
      siteUrl: Settings.siteUrl,
      // 关于弹窗版权持有方（cn 公司主体 / sg 产品名，可由 COPYRIGHT_HOLDER 覆盖）
      copyrightHolder: Settings.copyrightHolder,
      emailConfirmationDisabled: Settings.emailConfirmationDisabled,
      maxEntitiesPerProject: Settings.maxEntitiesPerProject,
      maxUploadSize: Settings.maxUploadSize,
      projectUploadTimeout: Settings.projectUploadTimeout,
      recaptchaSiteKey: Settings.recaptcha?.siteKey,
      recaptchaSiteKeyV3: Settings.recaptcha?.siteKeyV3,
      recaptchaDisabled: Settings.recaptcha?.disabled,
      textExtensions: Settings.textExtensions,
      editableFilenames: Settings.editableFilenames,
      validRootDocExtensions: Settings.validRootDocExtensions,
      sentryAllowedOriginRegex: Settings.sentry.allowedOriginRegex,
      sentryDsn: Settings.sentry.publicDSN,
      sentryEnvironment: Settings.sentry.environment,
      sentryRelease: Settings.sentry.release,
      enableSubscriptions: Settings.enableSubscriptions,
      gaToken:
        Settings.analytics &&
        Settings.analytics.ga &&
        Settings.analytics.ga.token,
      gaTokenV4:
        Settings.analytics &&
        Settings.analytics.ga &&
        Settings.analytics.ga.tokenV4,
      cookieDomain: Settings.cookieDomain,
      templateLinks: Settings.templateLinks,
      labsEnabled: Settings.labs && Settings.labs.enable,
      // 设置页「充值」按钮：没有支付渠道时前端显示为禁用态，
      // 因此这里只暴露开关和可选的外链，不暴露任何密钥。
      // FIXED: 2026-11-12 改密入口跟着后端开关走，默认关闭（见 settings.defaults.js）
      passwordChangeEnabled: Boolean(Settings.passwordChangeEnabled),
      // 部署档位（cn / sg）：前端只拿它做文案与默认行为，不做权限判断。
      // FIXED: 2026-11-25 之前只暴露了 billing.*，海外站想换个分组名都做不到，
      // 只能写死「NE LLM Service」——部署在海外却告诉用户在上 NE 网关。
      deployment: {
        profile: _.get(Settings, ['deployment', 'profile']) || 'cn',
        isGlobal: Boolean(_.get(Settings, ['deployment', 'isGlobal'])),
        region: _.get(Settings, ['deployment', 'region']) || null,
      },
      billing: {
        enabled: Features.hasFeature('billing'),        ledgerEnabled: Boolean(_.get(Settings, ['billing', 'ledgerEnabled'])),
        currency: _.get(Settings, ['billing', 'currency']) || 'USD',
        topupUrl: _.get(Settings, ['billing', 'topupUrl']) || null,
        // FIXED: 2026-11-12 站内收银台。
        // 之前只有 topupUrl（外部收银台外链），没配就永远是禁用态 ——
        // 表现为「充值按钮完全点不动」。现在只要支付渠道可用，
        // 前端就走站内 POST /billing/topup 拿到 checkoutUrl 再跳转。
        topupAvailable: Billing.canTopUp(),
      },
    }
    next()
  })
}
