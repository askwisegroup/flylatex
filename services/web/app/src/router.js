const AdminController = require('./Features/ServerAdmin/AdminController')
const ErrorController = require('./Features/Errors/ErrorController')
const ProjectController = require('./Features/Project/ProjectController')
const ProjectApiController = require('./Features/Project/ProjectApiController')
const ProjectListController = require('./Features/Project/ProjectListController')
const SpellingController = require('./Features/Spelling/SpellingController')
const EditorRouter = require('./Features/Editor/EditorRouter')
const Settings = require('@overleaf/settings')
const TpdsController = require('./Features/ThirdPartyDataStore/TpdsController')
const SubscriptionRouter = require('./Features/Subscription/SubscriptionRouter')
const UploadsRouter = require('./Features/Uploads/UploadsRouter')
const metrics = require('@overleaf/metrics')
const ReferalController = require('./Features/Referal/ReferalController')
const AuthenticationController = require('./Features/Authentication/AuthenticationController')
const PermissionsController = require('./Features/Authorization/PermissionsController')
const SessionManager = require('./Features/Authentication/SessionManager')
const TagsController = require('./Features/Tags/TagsController')
const NotificationsController = require('./Features/Notifications/NotificationsController')
const CollaboratorsRouter = require('./Features/Collaborators/CollaboratorsRouter')
const UserInfoController = require('./Features/User/UserInfoController')
const UserController = require('./Features/User/UserController')
const UserEmailsController = require('./Features/User/UserEmailsController')
const UserUsageController = require('./Features/User/UserUsageController')
const UserPagesController = require('./Features/User/UserPagesController')
// FIXED: 2026-11-14 「您共享的」统一管理页（列表 + 批量取消分享）
const TutorialController = require('./Features/Tutorial/TutorialController')
const DocumentController = require('./Features/Documents/DocumentController')
const CompileManager = require('./Features/Compile/CompileManager')
const CompileController = require('./Features/Compile/CompileController')
// FIXED: 2026-11-05 About System 显示真实的 TeX Live 版本（不再写死）
const TeXLiveVersion = require('./Features/Compile/TeXLiveVersion')
const ClsiCookieManager = require('./Features/Compile/ClsiCookieManager')(
  Settings.apis.clsi != null ? Settings.apis.clsi.backendGroupName : undefined
)
const HealthCheckController = require('./Features/HealthCheck/HealthCheckController')
const ProjectDownloadsController = require('./Features/Downloads/ProjectDownloadsController')
const FileStoreController = require('./Features/FileStore/FileStoreController')
const HistoryController = require('./Features/History/HistoryController')
const ProjectSearchController = require('./Features/ProjectSearch/ProjectSearchController')
const ExportsController = require('./Features/Exports/ExportsController')
const PasswordResetRouter = require('./Features/PasswordReset/PasswordResetRouter')
const StaticPagesRouter = require('./Features/StaticPages/StaticPagesRouter')
const AIChatRouter = require('./Features/AIChat/AIChatRouter')
const ChatController = require('./Features/Chat/ChatController')
const ImageRouter = require('./Features/AgentImages/ImageRouter')
// FIXED: 2026-10-14 DesktopSync —— 桌面端项目同步（扩展性质，默认关闭，环境变量开关）
const DesktopSync = require('./Features/DesktopSync')
// FIXED: 2026-11-10 个人知识库 HTTP 接口（复用 desktop_sync_keys 做 Bearer 认证，不新造密钥体系）
const KnowledgeBaseRouter = require('./Features/KnowledgeBase/KnowledgeBaseRouter')

const Modules = require('./infrastructure/Modules')
const {
  RateLimiter,
  openProjectRateLimiter,
} = require('./infrastructure/RateLimiter')
const RateLimiterMiddleware = require('./Features/Security/RateLimiterMiddleware')
const InactiveProjectController = require('./Features/InactiveData/InactiveProjectController')
const ContactRouter = require('./Features/Contacts/ContactRouter')
const ReferencesController = require('./Features/References/ReferencesController')
const AuthorizationMiddleware = require('./Features/Authorization/AuthorizationMiddleware')
const BetaProgramController = require('./Features/BetaProgram/BetaProgramController')
const AnalyticsRouter = require('./Features/Analytics/AnalyticsRouter')
const MetaController = require('./Features/Metadata/MetaController')
const TokenAccessController = require('./Features/TokenAccess/TokenAccessController')
const Features = require('./infrastructure/Features')
const LinkedFilesRouter = require('./Features/LinkedFiles/LinkedFilesRouter')
const TemplatesRouter = require('./Features/Templates/TemplatesRouter')
const InstitutionsController = require('./Features/Institutions/InstitutionsController')
const UserMembershipRouter = require('./Features/UserMembership/UserMembershipRouter')
const GitController = require('./Features/Git/GitController')
const GitPagesController = require('./Features/Git/GitPagesController')
const GitRouter = require('./Features/Git/GitRouter')
const SystemMessageController = require('./Features/SystemMessages/SystemMessageController')
const AnalyticsRegistrationSourceMiddleware = require('./Features/Analytics/AnalyticsRegistrationSourceMiddleware')
const AnalyticsUTMTrackingMiddleware = require('./Features/Analytics/AnalyticsUTMTrackingMiddleware')
const CaptchaMiddleware = require('./Features/Captcha/CaptchaMiddleware')
const { Joi, validate } = require('./infrastructure/Validation')
const {
  renderUnsupportedBrowserPage,
  unsupportedBrowserMiddleware,
} = require('./infrastructure/UnsupportedBrowserMiddleware')

const logger = require('@overleaf/logger')
const _ = require('underscore')
const { plainTextResponse } = require('./infrastructure/Response')
const PublicAccessLevels = require('./Features/Authorization/PublicAccessLevels')
const NEService = require('../../commercial')
const BillingController = require('./Features/Billing/BillingController')
const Billing = require('./Features/Billing')
// FIXED: 2026-11-16 Zotero（第三方文献库）：只读元数据代理，供设置页绑定与「插入引用」使用
const ZoteroController = require('./Features/Zotero/ZoteroController')
const CarsiService = require('../../commercial/carsi')
const CarsiV2Service = require('../../commercial/carsi-v2') // FIXED: 2026-10-11 认证 V2 CARSI
// FIXED: 2026-10-27 一键重新连接 NE 账号（NE 会话到期后的修修入口）
const NeLinkService = require('../../commercial/ne-link')
// FIXED: 2026-11-12 Google 登录（海外站主登录方式）
const GoogleAuthController = require('./Features/IdentityProviders/GoogleAuthController')
// FIXED: 2026-05-06 导入CARSI认证回调处理器
const CarsiAuthCallbackController = require('./Features/Authentication/CarsiAuthCallbackController')
const CrossRefService = require('../../commercial/crosrefsearch')
const AIAgentService = require('../../commercial/ai-agent')
// FIXED: 2026-11-20 FlyLaTeX SSO（生态统一身份，见 Features/Sso/index.js 与
// docs/sso-provider-design.md）。注意：它不 require 任何私有模块，
// 只读 req.session.user。
const Sso = require('./Features/Sso')

const rateLimiters = {
  addEmail: new RateLimiter('add-email', {
    points: 10,
    duration: 60,
  }),
  addProjectToTag: new RateLimiter('add-project-to-tag', {
    points: 30,
    duration: 60,
  }),
  addProjectsToTag: new RateLimiter('add-projects-to-tag', {
    points: 30,
    duration: 60,
  }),
  canSkipCaptcha: new RateLimiter('can-skip-captcha', {
    points: 20,
    duration: 60,
  }),
  changePassword: new RateLimiter('change-password', {
    points: 10,
    duration: 60,
  }),
  compileProjectHttp: new RateLimiter('compile-project-http', {
    points: 800,
    duration: 60 * 60,
  }),
  confirmEmail: new RateLimiter('confirm-email', {
    points: 10,
    duration: 60,
  }),
  createProject: new RateLimiter('create-project', {
    points: 20,
    duration: 60,
  }),
  createTag: new RateLimiter('create-tag', {
    points: 30,
    duration: 60,
  }),
  deleteEmail: new RateLimiter('delete-email', {
    points: 10,
    duration: 60,
  }),
  deleteTag: new RateLimiter('delete-tag', {
    points: 30,
    duration: 60,
  }),
  deleteUser: new RateLimiter('delete-user', {
    points: 10,
    duration: 60,
  }),
  downloadProjectRevision: new RateLimiter('download-project-revision', {
    points: 30,
    duration: 60 * 60,
  }),
  endorseEmail: new RateLimiter('endorse-email', {
    points: 30,
    duration: 60,
  }),
  getProjects: new RateLimiter('get-projects', {
    points: 30,
    duration: 60,
  }),
  grantTokenAccessReadOnly: new RateLimiter('grant-token-access-read-only', {
    points: 10,
    duration: 60,
  }),
  grantTokenAccessReadWrite: new RateLimiter('grant-token-access-read-write', {
    points: 10,
    duration: 60,
  }),
  indexAllProjectReferences: new RateLimiter('index-all-project-references', {
    points: 30,
    duration: 60,
  }),
  miscOutputDownload: new RateLimiter('misc-output-download', {
    points: 1000,
    duration: 60 * 60,
  }),
  multipleProjectsZipDownload: new RateLimiter(
    'multiple-projects-zip-download',
    {
      points: 10,
      duration: 60,
    }
  ),
  openDashboard: new RateLimiter('open-dashboard', {
    points: 30,
    duration: 60,
  }),
  readAndWriteToken: new RateLimiter('read-and-write-token', {
    points: 15,
    duration: 60,
  }),
  readOnlyToken: new RateLimiter('read-only-token', {
    points: 15,
    duration: 60,
  }),
  removeProjectFromTag: new RateLimiter('remove-project-from-tag', {
    points: 30,
    duration: 60,
  }),
  removeProjectsFromTag: new RateLimiter('remove-projects-from-tag', {
    points: 30,
    duration: 60,
  }),
  renameTag: new RateLimiter('rename-tag', {
    points: 30,
    duration: 60,
  }),
  resendConfirmation: new RateLimiter('resend-confirmation', {
    points: 1,
    duration: 60,
  }),
  sendChatMessage: new RateLimiter('send-chat-message', {
    points: 100,
    duration: 60,
  }),
  statusCompiler: new RateLimiter('status-compiler', {
    points: 10,
    duration: 60,
  }),
  zipDownload: new RateLimiter('zip-download', {
    points: 10,
    duration: 60,
  }),
}

function initialize(webRouter, privateApiRouter, publicApiRouter) {
  webRouter.use(unsupportedBrowserMiddleware)

  if (!Settings.allowPublicAccess) {
    webRouter.all('*', AuthenticationController.requireGlobalLogin)
  }

  webRouter.get('*', AnalyticsRegistrationSourceMiddleware.setInbound())
  webRouter.get('*', AnalyticsUTMTrackingMiddleware.recordUTMTags())

  // Mount onto /login in order to get the deviceHistory cookie.
  webRouter.post(
    '/login/can-skip-captcha',
    // Keep in sync with the overleaf-login options.
    RateLimiterMiddleware.rateLimit(rateLimiters.canSkipCaptcha),
    CaptchaMiddleware.canSkipCaptcha
  )

  webRouter.get('/login', UserPagesController.loginPage)
  AuthenticationController.addEndpointToLoginWhitelist('/login')

  webRouter.post(
    '/login',
    CaptchaMiddleware.validateCaptcha('login'),
    AuthenticationController.passportLogin
  )
  // FIXED: 2026-11-19 应急：线上 POST /login 返回 403（csurf EBADCSRFTOKEN），
  // 先把该路由的 CSRF 校验关掉，恢复登录。
  // TODO: 定位到根因（session cookie / 反代）后恢复，不要长期保留。
  webRouter.csrf.disableDefaultCsrfProtection('/login', 'POST')

  // =====================================================================
  // FIXED: 2026-11-12 Google 登录（海外站主登录方式）
  //
  // 只在 google-login 可用时才注册 —— 未配 GOOGLE_CLIENT_ID 的部署上
  // 这两个 URL 直接 404，不存在"能调到但必然失败"的中间态。
  // 两个端点都要在登录白名单里，否则未登录用户会被 requireLogin 拦掉。
  // =====================================================================
  if (Features.hasFeature('google-login')) {
    AuthenticationController.addEndpointToLoginWhitelist('/auth/google/nonce')
    AuthenticationController.addEndpointToLoginWhitelist('/auth/google/verify')
    webRouter.get('/auth/google/nonce', GoogleAuthController.issueNonce)
    webRouter.post('/auth/google/verify', GoogleAuthController.verify)
  }

  if (Settings.enableLegacyLogin) {
    AuthenticationController.addEndpointToLoginWhitelist('/login/legacy')
    webRouter.get('/login/legacy', UserPagesController.loginPage)
    webRouter.post(
      '/login/legacy',
      CaptchaMiddleware.validateCaptcha('login'),
      AuthenticationController.passportLogin
    )
    // FIXED: 2026-11-19 应急：同上
    webRouter.csrf.disableDefaultCsrfProtection('/login/legacy', 'POST')
  }

  webRouter.get(
    '/read-only/one-time-login',
    UserPagesController.oneTimeLoginPage
  )
  AuthenticationController.addEndpointToLoginWhitelist(
    '/read-only/one-time-login'
  )

  webRouter.post('/logout', UserController.logout)

  // =====================================================================
  // FIXED: 2026-11-20 FlyLaTeX SSO · T0 前门（同源应用的身份接口）
  //
  // 生态里的模板系统 / 运营系统 / 白板 / TikZ 库 / 桌面端 / MCP 都要知道
  // 「现在是哪个用户」，而它们各自去接 NE account 或 Google account 会重复
  // 四份对接、且换上游就会割裂（master=NE、sg=Google）。
  //
  // 这里只先落最小的一条：`GET /sso/session`。同源应用一次 fetch 就能拿到
  // 稳定的 `sub`（= 本地 User._id），未登录拿 401 + loginUrl 自己去跳登录。
  //
  // 为什么“未登录 → 跳 FlyLaTeX 登录 → 跳回来”不需要新机制：
  //   loginUrl 拼出的 `/login?redir=...` 由 UserPagesController.loginPage
  //   写入 session.postLoginRedirect，登录完成后 finishLogin() 送回原处。
  //   后续 T2（/sso/authorize）也是复用这条同一链路。
  //
  // 设计文档：docs/sso-provider-design.md
  // 开源边界：app/src/Features/Sso/sso-boundary.test.js（禁止依赖私有模块）
  // =====================================================================
  webRouter.get('/sso/session', Sso.Session.session)
  // 防御性入白名单：/sso/session 自己会返回 401 JSON，不能让它被
  // requireGlobalLogin 302 到登录页（那会把 fetch 变成一个 HTML 跳转）。
  // 当前 `Settings.allowPublicAccess` 写死为 true，这层其实挂不到，
  // 但只要有部署把它关掉，这一条就是唯一能让同源应用不出错的东西。
  AuthenticationController.addEndpointToLoginWhitelist('/sso/session')

  // ---------------------------------------------------------------------
  // T2：跨域 / 桌面端 / MCP 的标准 OAuth2 前门
  //
  // 三条端点故意挂在**两个不同的 router** 上，这是安全设计不是随手放：
  //
  //   /sso/authorize  → webRouter   （需要 Session + 登录重定向）
  //   /sso/token      → publicApiRouter（服务器到服务器，**必须没有 CSRF**）
  //   /sso/userinfo   → publicApiRouter（Bearer，没有 cookie）
  //
  // `webRouter` 全体套了 `webRouter.csrf.middleware`；把 /sso/token 挂进
  // webRouter 会让 word2latex 的后端请求直接 403 —— 而它既没有 cookie 也
  // 拿不到 CSRF token。这不是「关掉 CSRF 图方便」：CSRF 在这里根本不适用，
  // 请求的凭据是 client_secret + code_verifier，不是用户的浏览器会话。
  //
  // `SSO_CLIENTS` 为空时三个 handler 各自返回 404（见 Features/Sso/index.js），
  // 开源版本不需要把这几行删掉。
  // ---------------------------------------------------------------------
  webRouter.get(
    '/sso/authorize',
    AuthenticationController.requireLogin(),
    Sso.authorize
  )
  publicApiRouter.post('/sso/token', Sso.token)
  publicApiRouter.get('/sso/userinfo', Sso.userinfo)

  webRouter.get('/restricted', AuthorizationMiddleware.restricted)

  if (Features.hasFeature('registration-page')) {
    webRouter.get('/register', UserPagesController.registerPage)
    AuthenticationController.addEndpointToLoginWhitelist('/register')
  }

  webRouter.get(
    '/git-import',
    AuthenticationController.requireLogin(),
    GitPagesController.gitImportPage
  )

  EditorRouter.apply(webRouter, privateApiRouter)
  CollaboratorsRouter.apply(webRouter, privateApiRouter)
  SubscriptionRouter.apply(webRouter, privateApiRouter, publicApiRouter)
  UploadsRouter.apply(webRouter, privateApiRouter)
  PasswordResetRouter.apply(webRouter, privateApiRouter)
  StaticPagesRouter.apply(webRouter, privateApiRouter)
  AIChatRouter.apply(webRouter, privateApiRouter)
  ContactRouter.apply(webRouter, privateApiRouter)
  AnalyticsRouter.apply(webRouter, privateApiRouter, publicApiRouter)
  LinkedFilesRouter.apply(webRouter, privateApiRouter, publicApiRouter)
  TemplatesRouter.apply(webRouter)
  UserMembershipRouter.apply(webRouter)
  GitRouter.apply(webRouter, publicApiRouter)

  // Agent Image API (public endpoints for backend Agent)
  ImageRouter.apply(webRouter)

  // FIXED: 2026-10-14 DesktopSync —— 默认启用（v5.2 起），DESKTOP_SYNC_ENABLED=false 可关闭；
  // 关闭时 Router 不挂载、Key 集合不初始化、中间件不注册，零副作用。
  // 挂载点必须在 catch-all (ErrorController.notFound) 之前。
  if (DesktopSync.isEnabled()) {
    DesktopSync.Router.apply(webRouter, publicApiRouter)
  }

  // FIXED: 2026-11-10 个人知识库：/api/kb/*（Bearer Key）+ /kb/api/*（Web 登录态）。
  // 两者都只是门面层 personal-kb/index.js 的 HTTP 适配器，零业务逻辑。
  // 复用 DesktopSync 的 requireApiKey，所以桌面端已有的 KEY 直接可用于知识库。
  KnowledgeBaseRouter.apply(webRouter, publicApiRouter)

  Modules.applyRouter(webRouter, privateApiRouter, publicApiRouter)

  if (Settings.enableSubscriptions) {
    webRouter.get(
      '/user/bonus',
      AuthenticationController.requireLogin(),
      ReferalController.bonus
    )
  }

  // .getMessages will generate an empty response for anonymous users.
  webRouter.get('/system/messages', SystemMessageController.getMessages)

  // FIXED: 2026-11-05 探测 TeX Live 版本（`tlmgr --version`，服务端缓存 10 分钟）
  webRouter.get(
    '/system/texlive-version',
    AuthenticationController.requireLogin(),
    TeXLiveVersion.get
  )

  webRouter.get(
    '/user/settings',
    AuthenticationController.requireLogin(),
    PermissionsController.useCapabilities(),
    UserPagesController.settingsPage
  )
  webRouter.post(
    '/user/settings',
    AuthenticationController.requireLogin(),
    UserController.updateUserSettings
  )

  // FIXED: 2026-11-14 「您共享的」：项目列表新增一档过滤器（sharedByMe），
  // 勾选后批量取消分享走这里。列表数据由 /api/project 提供
  // （ProjectListController 里注入 publicAccessLevel / sharedAt）。
  webRouter.post(
    '/user/password/update',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.changePassword),
    UserController.changePassword
  )
  webRouter.get(
    '/user/emails',
    AuthenticationController.requireLogin(),
    PermissionsController.useCapabilities(),
    UserController.promises.ensureAffiliationMiddleware,
    UserEmailsController.list
  )
  webRouter.get('/user/emails/confirm', UserEmailsController.showConfirm)
  webRouter.post(
    '/user/emails/confirm',
    RateLimiterMiddleware.rateLimit(rateLimiters.confirmEmail),
    UserEmailsController.confirm
  )
  webRouter.post(
    '/user/emails/resend_confirmation',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.resendConfirmation),
    UserEmailsController.resendConfirmation
  )

  webRouter.get(
    '/user/emails/primary-email-check',
    AuthenticationController.requireLogin(),
    UserEmailsController.primaryEmailCheckPage
  )

  webRouter.post(
    '/user/emails/primary-email-check',
    AuthenticationController.requireLogin(),
    UserEmailsController.primaryEmailCheck
  )

  if (Features.hasFeature('affiliations')) {
    webRouter.post(
      '/user/emails',
      AuthenticationController.requireLogin(),
      PermissionsController.requirePermission('add-secondary-email'),
      RateLimiterMiddleware.rateLimit(rateLimiters.addEmail),
      CaptchaMiddleware.validateCaptcha('addEmail'),
      UserEmailsController.add
    )
    webRouter.post(
      '/user/emails/delete',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.deleteEmail),
      UserEmailsController.remove
    )
    webRouter.post(
      '/user/emails/default',
      AuthenticationController.requireLogin(),
      UserEmailsController.setDefault
    )
    webRouter.post(
      '/user/emails/endorse',
      AuthenticationController.requireLogin(),
      PermissionsController.requirePermission('endorse-email'),
      RateLimiterMiddleware.rateLimit(rateLimiters.endorseEmail),
      UserEmailsController.endorse
    )
  }

  webRouter.get(
    '/user/sessions',
    AuthenticationController.requireLogin(),
    UserPagesController.sessionsPage
  )
  webRouter.post(
    '/user/sessions/clear',
    AuthenticationController.requireLogin(),
    UserController.clearSessions
  )

  // deprecated
  webRouter.delete(
    '/user/newsletter/unsubscribe',
    AuthenticationController.requireLogin(),
    UserController.unsubscribe
  )

  webRouter.post(
    '/user/newsletter/unsubscribe',
    AuthenticationController.requireLogin(),
    UserController.unsubscribe
  )

  webRouter.post(
    '/user/newsletter/subscribe',
    AuthenticationController.requireLogin(),
    UserController.subscribe
  )

  webRouter.get(
    '/user/email-preferences',
    AuthenticationController.requireLogin(),
    UserPagesController.emailPreferencesPage
  )

  webRouter.post(
    '/user/delete',
    RateLimiterMiddleware.rateLimit(rateLimiters.deleteUser),
    AuthenticationController.requireLogin(),
    PermissionsController.requirePermission('delete-own-account'),
    UserController.tryDeleteUser
  )

  webRouter.get(
    '/user/personal_info',
    AuthenticationController.requireLogin(),
    UserInfoController.getLoggedInUsersPersonalInfo
  )
  privateApiRouter.get(
    '/user/:user_id/personal_info',
    AuthenticationController.requirePrivateApiAuth(),
    UserInfoController.getPersonalInfo
  )

  // 用户磁盘使用量 API
  webRouter.get(
    '/api/user/usage',
    AuthenticationController.requireLogin(),
    UserUsageController.getUserUsage
  )

  // 管理员 API - 查看指定用户的使用量
  privateApiRouter.get(
    '/user/:userId/usage',
    AuthenticationController.requirePrivateApiAuth(),
    UserUsageController.getUserUsageAdmin
  )

  webRouter.get(
    '/user/reconfirm',
    UserPagesController.renderReconfirmAccountPage
  )
  // for /user/reconfirm POST, see password router

  webRouter.get(
    '/user/tpds/queues',
    AuthenticationController.requireLogin(),
    TpdsController.getQueues
  )

  webRouter.post(
    '/tutorial/:tutorialKey/complete',
    AuthenticationController.requireLogin(),
    TutorialController.completeTutorial
  )

  webRouter.get(
    '/user/projects',
    AuthenticationController.requireLogin(),
    ProjectController.userProjectsJson
  )
  webRouter.get(
    '/project/:Project_id/entities',
    // FIXED: 2026-11-15 去掉 requireLogin()。
    // 这是编辑器加载后第一个 XHR（文档树）。带 requireLogin 时，匿名访问者
    // 即使刚通过分享链接拿到 token，也会在这里收到 401 Unauthorized，
    // 前端 errorCatcher 随即把整页送去 /login?redir=/project/xxx ——
    // 表现就是「分享链接打开后又要登录」。读权限由 ensureUserCanReadProject
    // 逐项目校验（含 token），不需要再加一道登录墙。
    // OLD: AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectController.projectEntitiesJson
  )

  webRouter.get(
    '/project',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.openDashboard),
    ProjectListController.projectListPage
  )
  webRouter.post(
    '/project/new',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.createProject),
    ProjectController.newProject
  )
  webRouter.post(
    '/api/project',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.getProjects),
    ProjectListController.getProjectsJson
  )

  for (const route of [
    // Keep the old route for continuous metrics
    '/Project/:Project_id',
    // New route for pdf-detach
    '/Project/:Project_id/:detachRole(detacher|detached)',
  ]) {
    webRouter.get(
      route,
      RateLimiterMiddleware.rateLimit(openProjectRateLimiter, {
        params: ['Project_id'],
      }),
      AuthenticationController.validateUserSession(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      ProjectController.loadEditor
    )
  }
  webRouter.head(
    '/Project/:Project_id/file/:File_id',
    AuthorizationMiddleware.ensureUserCanReadProject,
    FileStoreController.getFileHead
  )
  webRouter.get(
    '/Project/:Project_id/file/:File_id',
    AuthorizationMiddleware.ensureUserCanReadProject,
    FileStoreController.getFile
  )
  webRouter.post(
    '/project/:Project_id/settings',
    validate({
      body: Joi.object({
        publicAccessLevel: Joi.string()
          .valid(PublicAccessLevels.PRIVATE, PublicAccessLevels.TOKEN_BASED)
          .optional(),
      }),
    }),
    AuthorizationMiddleware.ensureUserCanWriteProjectSettings,
    ProjectController.updateProjectSettings
  )
  webRouter.post(
    '/project/:Project_id/settings/admin',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectController.updateProjectAdminSettings
  )

  webRouter.post(
    '/project/:Project_id/compile',
    RateLimiterMiddleware.rateLimit(rateLimiters.compileProjectHttp, {
      params: ['Project_id'],
    }),
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.compile
  )

  webRouter.post(
    '/project/:Project_id/compile/stop',
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.stopCompile
  )

  // FIXED: 2026-11-08 编译新鲜度检查：内容与上次成功编译一致时返回 fresh:true。
  // 阶段 ② 只提供能力 + 日志（用于观察命中率），前端尚未据此跳过编译。
  webRouter.get(
    '/project/:Project_id/compile/fresh',
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.getCompileFreshness
  )

  // LEGACY: Used by the web download buttons, adds filename header, TODO: remove at some future date
  webRouter.get(
    '/project/:Project_id/output/output.pdf',
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.downloadPdf
  )

  // PDF Download button
  webRouter.get(
    /^\/download\/project\/([^/]*)\/output\/output\.pdf$/,
    function (req, res, next) {
      const params = { Project_id: req.params[0] }
      req.params = params
      next()
    },
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.downloadPdf
  )

  // PDF Download button for specific build
  webRouter.get(
    /^\/download\/project\/([^/]*)\/build\/([0-9a-f-]+)\/output\/output\.pdf$/,
    function (req, res, next) {
      const params = {
        Project_id: req.params[0],
        build_id: req.params[1],
      }
      req.params = params
      next()
    },
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.downloadPdf
  )

  // Align with limits defined in CompileController.downloadPdf
  const rateLimiterMiddlewareOutputFiles = RateLimiterMiddleware.rateLimit(
    rateLimiters.miscOutputDownload,
    { params: ['Project_id'] }
  )

  // Used by the pdf viewers
  webRouter.get(
    /^\/project\/([^/]*)\/output\/(.*)$/,
    function (req, res, next) {
      const params = {
        Project_id: req.params[0],
        file: req.params[1],
      }
      req.params = params
      next()
    },
    rateLimiterMiddlewareOutputFiles,
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.getFileFromClsi
  )
  // direct url access to output files for a specific build (query string not required)
  webRouter.get(
    /^\/project\/([^/]*)\/build\/([0-9a-f-]+)\/output\/(.*)$/,
    function (req, res, next) {
      const params = {
        Project_id: req.params[0],
        build_id: req.params[1],
        file: req.params[2],
      }
      req.params = params
      next()
    },
    rateLimiterMiddlewareOutputFiles,
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.getFileFromClsi
  )

  // direct url access to output files for user but no build, to retrieve files when build fails
  webRouter.get(
    /^\/project\/([^/]*)\/user\/([0-9a-f-]+)\/output\/(.*)$/,
    function (req, res, next) {
      const params = {
        Project_id: req.params[0],
        user_id: req.params[1],
        file: req.params[2],
      }
      req.params = params
      next()
    },
    rateLimiterMiddlewareOutputFiles,
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.getFileFromClsi
  )

  // direct url access to output files for a specific user and build (query string not required)
  webRouter.get(
    /^\/project\/([^/]*)\/user\/([0-9a-f]+)\/build\/([0-9a-f-]+)\/output\/(.*)$/,
    function (req, res, next) {
      const params = {
        Project_id: req.params[0],
        user_id: req.params[1],
        build_id: req.params[2],
        file: req.params[3],
      }
      req.params = params
      next()
    },
    rateLimiterMiddlewareOutputFiles,
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.getFileFromClsi
  )

  webRouter.delete(
    '/project/:Project_id/output',
    validate({ query: { clsiserverid: Joi.string() } }),
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.deleteAuxFiles
  )
  webRouter.get(
    '/project/:Project_id/sync/code',
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.proxySyncCode
  )
  webRouter.get(
    '/project/:Project_id/sync/pdf',
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.proxySyncPdf
  )
  webRouter.get(
    '/project/:Project_id/wordcount',
    validate({ query: { clsiserverid: Joi.string() } }),
    AuthorizationMiddleware.ensureUserCanReadProject,
    CompileController.wordCount
  )

  webRouter.post(
    '/Project/:Project_id/archive',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectController.archiveProject
  )
  webRouter.delete(
    '/Project/:Project_id/archive',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectController.unarchiveProject
  )
  webRouter.post(
    '/project/:project_id/trash',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectController.trashProject
  )
  webRouter.delete(
    '/project/:project_id/trash',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectController.untrashProject
  )

  webRouter.delete(
    '/Project/:Project_id',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectController.deleteProject
  )

  webRouter.post(
    '/Project/:Project_id/restore',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectController.restoreProject
  )
  webRouter.post(
    '/Project/:Project_id/clone',
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectController.cloneProject
  )

  webRouter.post(
    '/project/:Project_id/rename',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectController.renameProject
  )
  webRouter.get(
    '/project/:Project_id/updates',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    HistoryController.proxyToHistoryApiAndInjectUserDetails
  )
  // FIXED: 2026-11-13 项目级全文检索（编辑菜单 → 全项目搜索）。
  // 只读操作：和 /updates 同一套权限中间件，不额外开放给受限成员。
  webRouter.get(
    '/project/:Project_id/search',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectSearchController.search
  )
  webRouter.get(
    '/project/:Project_id/doc/:doc_id/diff',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    HistoryController.proxyToHistoryApi
  )
  webRouter.get(
    '/project/:Project_id/diff',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    HistoryController.proxyToHistoryApiAndInjectUserDetails
  )
  webRouter.get(
    '/project/:Project_id/filetree/diff',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    HistoryController.proxyToHistoryApi
  )
  webRouter.post(
    '/project/:project_id/restore_file',
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    HistoryController.restoreFileFromV2
  )
  webRouter.get(
    '/project/:project_id/version/:version/zip',
    RateLimiterMiddleware.rateLimit(rateLimiters.downloadProjectRevision),
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    HistoryController.downloadZipOfVersion
  )
  privateApiRouter.post(
    '/project/:Project_id/history/resync',
    AuthenticationController.requirePrivateApiAuth(),
    HistoryController.resyncProjectHistory
  )

  webRouter.get(
    '/project/:Project_id/labels',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    HistoryController.getLabels
  )
  webRouter.post(
    '/project/:Project_id/labels',
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    HistoryController.createLabel
  )
  webRouter.delete(
    '/project/:Project_id/labels/:label_id',
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    HistoryController.deleteLabel
  )

  webRouter.post(
    '/project/:project_id/export/:brand_variation_id',
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    ExportsController.exportProject
  )
  webRouter.get(
    '/project/:project_id/export/:export_id',
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    ExportsController.exportStatus
  )
  webRouter.get(
    '/project/:project_id/export/:export_id/:type',
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    ExportsController.exportDownload
  )

  webRouter.get(
    '/Project/:Project_id/download/zip',
    RateLimiterMiddleware.rateLimit(rateLimiters.zipDownload, {
      params: ['Project_id'],
    }),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectDownloadsController.downloadProject
  )
  webRouter.get(
    '/project/download/zip',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.multipleProjectsZipDownload),
    AuthorizationMiddleware.ensureUserCanReadMultipleProjects,
    ProjectDownloadsController.downloadMultipleProjects
  )

  webRouter.get(
    '/project/:project_id/metadata',
    AuthorizationMiddleware.ensureUserCanReadProject,
    // FIXED: 2026-11-14 删掉「配置为假就 requireLogin」这个中间件。
    // 为假时匿名可编辑的分享链接会在 /metadata 上拿到 401，前端 errorCatcher
    // 随即把用户丢去 /login?redir=/project/xxx —— 表现就是「链接打开后要登录」。
    // 读权限已由上面的 ensureUserCanReadProject 逐项目校验（含 token），无需再加。
    // OLD: Settings.allowAnonymousReadAndWriteSharing ? (req,res,next)=>next() : requireLogin()
    MetaController.getMetadata
  )
  webRouter.post(
    '/project/:project_id/doc/:doc_id/metadata',
    AuthorizationMiddleware.ensureUserCanReadProject,
    // FIXED: 2026-11-14 删掉「配置为假就 requireLogin」这个中间件。
    // 为假时匿名可编辑的分享链接会在 /metadata 上拿到 401，前端 errorCatcher
    // 随即把用户丢去 /login?redir=/project/xxx —— 表现就是「链接打开后要登录」。
    // 读权限已由上面的 ensureUserCanReadProject 逐项目校验（含 token），无需再加。
    // OLD: Settings.allowAnonymousReadAndWriteSharing ? (req,res,next)=>next() : requireLogin()
    MetaController.broadcastMetadataForDoc
  )
  privateApiRouter.post(
    '/internal/expire-deleted-projects-after-duration',
    AuthenticationController.requirePrivateApiAuth(),
    ProjectController.expireDeletedProjectsAfterDuration
  )
  privateApiRouter.post(
    '/internal/expire-deleted-users-after-duration',
    AuthenticationController.requirePrivateApiAuth(),
    UserController.expireDeletedUsersAfterDuration
  )
  privateApiRouter.post(
    '/internal/project/:projectId/expire-deleted-project',
    AuthenticationController.requirePrivateApiAuth(),
    ProjectController.expireDeletedProject
  )
  privateApiRouter.post(
    '/internal/users/:userId/expire',
    AuthenticationController.requirePrivateApiAuth(),
    UserController.expireDeletedUser
  )

  privateApiRouter.get(
    '/user/:userId/tag',
    AuthenticationController.requirePrivateApiAuth(),
    TagsController.apiGetAllTags
  )
  webRouter.get(
    '/tag',
    AuthenticationController.requireLogin(),
    TagsController.getAllTags
  )
  webRouter.post(
    '/tag',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.createTag),
    validate({
      body: Joi.object({
        name: Joi.string().required(),
        color: Joi.string(),
      }),
    }),
    TagsController.createTag
  )
  webRouter.post(
    '/tag/:tagId/rename',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.renameTag),
    validate({
      body: Joi.object({
        name: Joi.string().required(),
      }),
    }),
    TagsController.renameTag
  )
  webRouter.post(
    '/tag/:tagId/edit',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.renameTag),
    validate({
      body: Joi.object({
        name: Joi.string().required(),
        color: Joi.string(),
      }),
    }),
    TagsController.editTag
  )
  webRouter.delete(
    '/tag/:tagId',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.deleteTag),
    TagsController.deleteTag
  )
  webRouter.post(
    '/tag/:tagId/project/:projectId',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.addProjectToTag),
    TagsController.addProjectToTag
  )
  webRouter.post(
    '/tag/:tagId/projects',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.addProjectsToTag),
    validate({
      body: Joi.object({
        projectIds: Joi.array().items(Joi.string()).required(),
      }),
    }),
    TagsController.addProjectsToTag
  )
  webRouter.delete(
    '/tag/:tagId/project/:projectId',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.removeProjectFromTag),
    TagsController.removeProjectFromTag
  )
  webRouter.delete(
    '/tag/:tagId/projects',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.removeProjectsFromTag),
    validate({
      body: Joi.object({
        projectIds: Joi.array().items(Joi.string()).required(),
      }),
    }),
    TagsController.removeProjectsFromTag
  )

  webRouter.get(
    '/notifications',
    AuthenticationController.requireLogin(),
    NotificationsController.getAllUnreadNotifications
  )
  webRouter.delete(
    '/notifications/:notificationId',
    AuthenticationController.requireLogin(),
    NotificationsController.markNotificationAsRead
  )

  // Deprecated in favour of /internal/project/:project_id but still used by versioning
  privateApiRouter.get(
    '/project/:project_id/details',
    AuthenticationController.requirePrivateApiAuth(),
    ProjectApiController.getProjectDetails
  )

  // New 'stable' /internal API end points
  privateApiRouter.get(
    '/internal/project/:project_id',
    AuthenticationController.requirePrivateApiAuth(),
    ProjectApiController.getProjectDetails
  )
  privateApiRouter.get(
    '/internal/project/:Project_id/zip',
    AuthenticationController.requirePrivateApiAuth(),
    ProjectDownloadsController.downloadProject
  )
  privateApiRouter.get(
    '/internal/project/:project_id/compile/pdf',
    AuthenticationController.requirePrivateApiAuth(),
    CompileController.compileAndDownloadPdf
  )

  privateApiRouter.post(
    '/internal/deactivateOldProjects',
    AuthenticationController.requirePrivateApiAuth(),
    InactiveProjectController.deactivateOldProjects
  )
  privateApiRouter.post(
    '/internal/project/:project_id/deactivate',
    AuthenticationController.requirePrivateApiAuth(),
    InactiveProjectController.deactivateProject
  )

  privateApiRouter.get(
    /^\/internal\/project\/([^/]*)\/output\/(.*)$/,
    function (req, res, next) {
      const params = {
        Project_id: req.params[0],
        file: req.params[1],
      }
      req.params = params
      next()
    },
    AuthenticationController.requirePrivateApiAuth(),
    CompileController.getFileFromClsi
  )

  privateApiRouter.get(
    '/project/:Project_id/doc/:doc_id',
    AuthenticationController.requirePrivateApiAuth(),
    DocumentController.getDocument
  )
  privateApiRouter.post(
    '/project/:Project_id/doc/:doc_id',
    AuthenticationController.requirePrivateApiAuth(),
    DocumentController.setDocument
  )

  privateApiRouter.post(
    '/user/:user_id/project/new',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.createProject
  )
  privateApiRouter.post(
    '/tpds/folder-update',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.updateFolder
  )
  privateApiRouter.post(
    '/user/:user_id/update/*',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.mergeUpdate
  )
  privateApiRouter.delete(
    '/user/:user_id/update/*',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.deleteUpdate
  )
  privateApiRouter.post(
    '/project/:project_id/user/:user_id/update/*',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.mergeUpdate
  )
  privateApiRouter.delete(
    '/project/:project_id/user/:user_id/update/*',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.deleteUpdate
  )

  privateApiRouter.post(
    '/project/:project_id/contents/*',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.updateProjectContents
  )
  privateApiRouter.delete(
    '/project/:project_id/contents/*',
    AuthenticationController.requirePrivateApiAuth(),
    TpdsController.deleteProjectContents
  )

  webRouter.post(
    '/spelling/check',
    AuthenticationController.requireLogin(),
    SpellingController.proxyRequestToSpellingApi
  )
  webRouter.post(
    '/spelling/learn',
    validate({
      body: Joi.object({
        word: Joi.string().required(),
      }),
    }),
    AuthenticationController.requireLogin(),
    SpellingController.learn
  )

  webRouter.post(
    '/spelling/unlearn',
    validate({
      body: Joi.object({
        word: Joi.string().required(),
      }),
    }),
    AuthenticationController.requireLogin(),
    SpellingController.unlearn
  )

  webRouter.get(
    '/project/:project_id/messages',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    ChatController.getMessages
  )
  webRouter.post(
    '/project/:project_id/messages',
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
    RateLimiterMiddleware.rateLimit(rateLimiters.sendChatMessage),
    ChatController.sendMessage
  )

  webRouter.post(
    '/project/:Project_id/references/indexAll',
    AuthorizationMiddleware.ensureUserCanReadProject,
    RateLimiterMiddleware.rateLimit(rateLimiters.indexAllProjectReferences),
    ReferencesController.indexAll
  )

  // disable beta program while v2 is in beta
  webRouter.get(
    '/beta/participate',
    AuthenticationController.requireLogin(),
    BetaProgramController.optInPage
  )
  webRouter.post(
    '/beta/opt-in',
    AuthenticationController.requireLogin(),
    BetaProgramController.optIn
  )
  webRouter.post(
    '/beta/opt-out',
    AuthenticationController.requireLogin(),
    BetaProgramController.optOut
  )

  // New "api" endpoints. Started as a way for v1 to call over to v2 (for
  // long-term features, as opposed to the nominally temporary ones in the
  // overleaf-integration module), but may expand beyond that role.
  publicApiRouter.post(
    '/api/clsi/compile/:submission_id',
    AuthenticationController.requirePrivateApiAuth(),
    CompileController.compileSubmission
  )
  publicApiRouter.get(
    /^\/api\/clsi\/compile\/([^/]*)\/build\/([0-9a-f-]+)\/output\/(.*)$/,
    function (req, res, next) {
      const params = {
        submission_id: req.params[0],
        build_id: req.params[1],
        file: req.params[2],
      }
      req.params = params
      next()
    },
    AuthenticationController.requirePrivateApiAuth(),
    CompileController.getFileFromClsiWithoutUser
  )
  publicApiRouter.post(
    '/api/institutions/confirm_university_domain',
    AuthenticationController.requirePrivateApiAuth(),
    InstitutionsController.confirmDomain
  )

  webRouter.get('/chrome', function (req, res, next) {
    // Match v1 behaviour - this is used for a Chrome web app
    if (SessionManager.isUserLoggedIn(req.session)) {
      res.redirect('/project')
    } else {
      res.redirect('/register')
    }
  })

  webRouter.get(
    '/admin',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.index
  )

  if (!Features.hasFeature('saas')) {
    webRouter.post(
      '/admin/openEditor',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.openEditor
    )
    webRouter.post(
      '/admin/closeEditor',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.closeEditor
    )
    webRouter.post(
      '/admin/disconnectAllUsers',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.disconnectAllUsers
    )
  }
  webRouter.post(
    '/admin/flushProjectToTpds',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.flushProjectToTpds
  )
  webRouter.post(
    '/admin/pollDropboxForUser',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.pollDropboxForUser
  )
  webRouter.post(
    '/admin/messages',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.createMessage
  )
  webRouter.post(
    '/admin/messages/clear',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.clearMessages
  )

  privateApiRouter.get('/perfTest', (req, res) => {
    plainTextResponse(res, 'hello')
  })

  publicApiRouter.get('/status', (req, res) => {
    if (Settings.shuttingDown) {
      res.sendStatus(503) // Service unavailable
    } else if (!Settings.siteIsOpen) {
      plainTextResponse(res, 'web site is closed (web)')
    } else if (!Settings.editorIsOpen) {
      plainTextResponse(res, 'web editor is closed (web)')
    } else {
      plainTextResponse(res, 'web sharelatex is alive (web)')
    }
  })
  privateApiRouter.get('/status', (req, res) => {
    plainTextResponse(res, 'web sharelatex is alive (api)')
  })

  // used by kubernetes health-check and acceptance tests
  publicApiRouter.get('/dev/csrf', (req, res) => {
    plainTextResponse(res, res.locals.csrfToken)
  })

  publicApiRouter.get(
    '/health_check',
    HealthCheckController.checkActiveHandles,
    HealthCheckController.check
  )
  privateApiRouter.get(
    '/health_check',
    HealthCheckController.checkActiveHandles,
    HealthCheckController.checkApi
  )
  publicApiRouter.get(
    '/health_check/api',
    HealthCheckController.checkActiveHandles,
    HealthCheckController.checkApi
  )
  privateApiRouter.get(
    '/health_check/api',
    HealthCheckController.checkActiveHandles,
    HealthCheckController.checkApi
  )
  publicApiRouter.get(
    '/health_check/full',
    HealthCheckController.checkActiveHandles,
    HealthCheckController.check
  )
  privateApiRouter.get(
    '/health_check/full',
    HealthCheckController.checkActiveHandles,
    HealthCheckController.check
  )

  publicApiRouter.get('/health_check/redis', HealthCheckController.checkRedis)
  privateApiRouter.get('/health_check/redis', HealthCheckController.checkRedis)

  publicApiRouter.get('/health_check/mongo', HealthCheckController.checkMongo)
  privateApiRouter.get('/health_check/mongo', HealthCheckController.checkMongo)

  webRouter.get(
    '/status/compiler/:Project_id',
    RateLimiterMiddleware.rateLimit(rateLimiters.statusCompiler),
    AuthorizationMiddleware.ensureUserCanReadProject,
    function (req, res) {
      const projectId = req.params.Project_id
      // use a valid user id for testing
      const testUserId = '123456789012345678901234'
      const sendRes = _.once(function (statusCode, message) {
        res.status(statusCode)
        plainTextResponse(res, message)
        ClsiCookieManager.clearServerId(projectId, testUserId, () => {})
      }) // force every compile to a new server
      // set a timeout
      let handler = setTimeout(function () {
        sendRes(500, 'Compiler timed out')
        handler = null
      }, 10000)
      // run the compile
      CompileManager.compile(
        projectId,
        testUserId,
        {},
        function (error, status) {
          if (handler) {
            clearTimeout(handler)
          }
          if (error) {
            sendRes(500, `Compiler returned error ${error.message}`)
          } else if (status === 'success') {
            sendRes(200, 'Compiler returned in less than 10 seconds')
          } else {
            sendRes(500, `Compiler returned failure ${status}`)
          }
        }
      )
    }
  )

  webRouter.get('/no-cache', function (req, res, next) {
    res.header('Cache-Control', 'max-age=0')
    res.sendStatus(404)
  })

  webRouter.get('/oops-express', (req, res, next) =>
    next(new Error('Test error'))
  )
  webRouter.get('/oops-internal', function (req, res, next) {
    throw new Error('Test error')
  })
  webRouter.get('/oops-mongo', (req, res, next) =>
    require('./models/Project').Project.findOne({}, function () {
      throw new Error('Test error')
    })
  )

  privateApiRouter.get('/opps-small', function (req, res, next) {
    logger.err('test error occured')
    res.sendStatus(200)
  })

  webRouter.post('/error/client', function (req, res, next) {
    logger.warn(
      { err: req.body.error, meta: req.body.meta },
      'client side error'
    )
    metrics.inc('client-side-error')
    res.sendStatus(204)
  })

  // FIXED: 2026-11-14 链接分享的新地址：/project/e/<token>（可编辑）
  // 与 /project/r/<token>（只读）。
  // 为什么换：原来的根路径 `/<token>` 需要外层 nginx 有单段路径规则，线上没有，
  // 复制出来的链接直接打不开；`/read/<token>` 也容易被静态资源路由吃掉。
  // 挂在 /project/ 前缀下，现有 nginx 的 /project 规则即可覆盖，
  // 且与下面的老路由并存（老书签继续可用）。
  webRouter.get(
    `/project/e/:token(${TokenAccessController.READ_AND_WRITE_TOKEN_PATTERN})`,
    RateLimiterMiddleware.rateLimit(rateLimiters.readAndWriteToken),
    AnalyticsRegistrationSourceMiddleware.setSource(
      'collaboration',
      'link-sharing'
    ),
    TokenAccessController.tokenAccessPage,
    AnalyticsRegistrationSourceMiddleware.clearSource()
  )

  webRouter.get(
    `/project/r/:token(${TokenAccessController.READ_ONLY_TOKEN_PATTERN})`,
    RateLimiterMiddleware.rateLimit(rateLimiters.readOnlyToken),
    AnalyticsRegistrationSourceMiddleware.setSource(
      'collaboration',
      'link-sharing'
    ),
    TokenAccessController.tokenAccessPage,
    AnalyticsRegistrationSourceMiddleware.clearSource()
  )

  webRouter.post(
    `/project/e/:token(${TokenAccessController.READ_AND_WRITE_TOKEN_PATTERN})/grant`,
    RateLimiterMiddleware.rateLimit(rateLimiters.grantTokenAccessReadWrite),
    TokenAccessController.grantTokenAccessReadAndWrite
  )

  webRouter.post(
    `/project/r/:token(${TokenAccessController.READ_ONLY_TOKEN_PATTERN})/grant`,
    RateLimiterMiddleware.rateLimit(rateLimiters.grantTokenAccessReadOnly),
    TokenAccessController.grantTokenAccessReadOnly
  )

  webRouter.get(
    `/read/:token(${TokenAccessController.READ_ONLY_TOKEN_PATTERN})`,
    RateLimiterMiddleware.rateLimit(rateLimiters.readOnlyToken),
    AnalyticsRegistrationSourceMiddleware.setSource(
      'collaboration',
      'link-sharing'
    ),
    TokenAccessController.tokenAccessPage,
    AnalyticsRegistrationSourceMiddleware.clearSource()
  )

  webRouter.get(
    `/:token(${TokenAccessController.READ_AND_WRITE_TOKEN_PATTERN})`,
    RateLimiterMiddleware.rateLimit(rateLimiters.readAndWriteToken),
    AnalyticsRegistrationSourceMiddleware.setSource(
      'collaboration',
      'link-sharing'
    ),
    TokenAccessController.tokenAccessPage,
    AnalyticsRegistrationSourceMiddleware.clearSource()
  )

  webRouter.post(
    `/:token(${TokenAccessController.READ_AND_WRITE_TOKEN_PATTERN})/grant`,
    RateLimiterMiddleware.rateLimit(rateLimiters.grantTokenAccessReadWrite),
    TokenAccessController.grantTokenAccessReadAndWrite
  )

  webRouter.post(
    `/read/:token(${TokenAccessController.READ_ONLY_TOKEN_PATTERN})/grant`,
    RateLimiterMiddleware.rateLimit(rateLimiters.grantTokenAccessReadOnly),
    TokenAccessController.grantTokenAccessReadOnly
  )

  // LLM relay for same-origin front-ends (whiteboard). Cookie + CSRF only:
  // no API key is ever handed to the browser, and the gateway never sees a
  // cross-origin request. See commercial/llm-relay.js.
  // FIXED: 2026-11-16 Zotero 集成（文献源，不是文件同步）
  //
  // 双前缀注册，两条都能用：
  //   /api/zotero/*  —— 服务器最外层 nginx 已经按这条配好了 location（不要再让人改）
  //   /user/zotero/* —— /user 本来就代理，没配 /api/zotero 的环境也能直接用
  // 两个前缀指向同一组 controller，行为完全一致；前端默认走 /api/zotero。
  const zoteroPrefixes = ['/api/zotero', '/user/zotero']
  for (const base of zoteroPrefixes) {
    webRouter.get(
      `${base}/status`,
      AuthenticationController.requireLogin(),
      ZoteroController.status
    )
    webRouter.post(
      `${base}/link`,
      AuthenticationController.requireLogin(),
      ZoteroController.link
    )
    webRouter.post(
      `${base}/unlink`,
      AuthenticationController.requireLogin(),
      ZoteroController.unlink
    )
    webRouter.get(
      `${base}/collections`,
      AuthenticationController.requireLogin(),
      ZoteroController.collections
    )
    webRouter.get(
      `${base}/items`,
      AuthenticationController.requireLogin(),
      ZoteroController.items
    )
    webRouter.post(
      `${base}/bibtex`,
      AuthenticationController.requireLogin(),
      ZoteroController.bibtex
    )
    webRouter.post(
      `${base}/export-bibtex`,
      AuthenticationController.requireLogin(),
      ZoteroController.exportBibtex
    )
    webRouter.post(
      `${base}/import-attachment`,
      AuthenticationController.requireLogin(),
      ZoteroController.importAttachment
    )
    // OAuth1 授权（可选，需配 ZOTERO_OAUTH_CLIENT_KEY/SECRET）
    webRouter.get(
      `${base}/oauth`,
      AuthenticationController.requireLogin(),
      ZoteroController.oauthStart
    )
    // FIXED: 2026-11-16 回调**不要 requireLogin**：从 zotero.org 跳回来是跨站顶层导航，
    // 若会话 cookie 是 SameSite=Strict 就不带 cookie，会被踢去 /login（线上「循环登录」）。
    // 用户身份从发起时写进 Redis 的 pending（含 userId）里取，与 cookie 无关。
    webRouter.get(`${base}/oauth/callback`, ZoteroController.oauthCallback)
  }

  webRouter.get('/api/llm/session', NEService.LlmSession)
  webRouter.get('/api/llm/balance', NEService.LlmBalance)
  webRouter.get('/api/llm/usage', NEService.LlmUsage)
  // 设置页「充值记录」：本地账本的只读视图（余额 + 最近流水）。
  // 与 /api/llm/balance 分开：那个读 NE 网关，这个读我们自己的账本。
  webRouter.get('/api/billing/ledger', BillingController.ledger)
  webRouter.get('/api/billing/orders', BillingController.orders)
  // 会员（订阅）：卖能力，与 LLM 余额两本账
  webRouter.get('/api/billing/plans', BillingController.plans)
  webRouter.get('/api/billing/membership', BillingController.membership)
  // 价格表对未登录用户也要可见（决策前要能比价），因此加白名单
  AuthenticationController.addEndpointToLoginWhitelist('/api/billing/plans')
  AuthenticationController.addEndpointToLoginWhitelist('/api/billing/membership')
  webRouter.post(
    '/billing/subscribe',
    AuthenticationController.requireLogin(),
    BillingController.subscribe
  )

  // =========================================================================
  // FIXED: 2026-11-12 站内充值（支付渠道 + 订单）
  //
  // 之前只有 `billing.topupUrl`（外部收银台外链），没配时设置页的「充值」
  // 按钮就是禁用态 —— 用户看到的是「充值按钮完全点不动」。
  // 现在：后端有自己的下单接口，前端 POST 拿到 checkoutUrl 再整页跳转，
  // 不再依赖某个人手工去配一个外链。
  //
  // 三个端点各自的信任边界都不同，注释里写清楚：
  //   POST /billing/topup    需要登录 + CSRF（用户主动发起）
  //   POST /billing/webhook  不能要登录、不能要 CSRF（渠道不会带 cookie），
  //                          靠 HMAC 验签保证真实性
  //   /billing/mock/*        只在 provider=fake 时注册，生产环境不存在
  // =========================================================================
  webRouter.post(
    '/billing/topup',
    AuthenticationController.requireLogin(),
    BillingController.topup
  )
  webRouter.post('/billing/webhook', BillingController.webhook)
  // 渠道回调：未登录可访问，且必须跳过 CSRF
  AuthenticationController.addEndpointToLoginWhitelist('/billing/webhook')
  webRouter.csrf.disableDefaultCsrfProtection('/billing/webhook', 'POST')

  if (Features.hasFeature('billing') && Billing.providerId() === 'fake') {
    // 本地假收银台。生产环境 provider 不是 fake，这两条路由压根不注册。
    webRouter.get(
      '/billing/mock/checkout/:orderId',
      AuthenticationController.requireLogin(),
      BillingController.mockCheckout
    )
    webRouter.post(
      '/billing/mock/pay/:orderId',
      AuthenticationController.requireLogin(),
      BillingController.mockPay
    )
  }
  webRouter.post('/api/llm/chat/completions', NEService.LlmChatCompletions)
  // OpenAI-SDK-shaped alias: set `baseURL: https://www.example.com/api/llm/v1`
  // and any OpenAI client reaches the same handler. Also keeps older whiteboard
  // builds (which posted to /v1/chat/completions) working across a server-first
  // deploy.
  webRouter.post('/api/llm/v1/chat/completions', NEService.LlmChatCompletions)

  // AI Chat Service - authenticated endpoint for project file access
  // Disable CSRF protection for API calls (client sends token in request body or header)
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai', 'POST')

  webRouter.post(
    '/ft-ai',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      const mode = req.body.mode

      if (['translate', 'summary', 'abstract'].includes(mode)) {
        // 简单模式：不需要工具调用，只需要大模型+提示词
        // - translate: 翻译
        // - summary: 总结
        // - abstract: 生成摘要
        NEService.AiSimpleService(req, res).catch(next)
      } else if (['chat', 'ask', 'agent'].includes(mode)) {
        // 复杂模式：需要工具调用支持
        // - chat: 通用聊天模式
        // - ask: 只读咨询模式
        // - agent: 完整操作模式（支持智能体选择）
        // FIXED: 2026-11-07 带上 stream 开关：true 时走 SSE（边跑边推工具步骤/结论增量），
        // 不传时完全是旧行为（一次性 JSON）
        NEService.AIService(req, res, {
          stream: req.body.stream === true,
        }).catch(next)
      } else {
        // 未知模式，默认使用 AIService
        NEService.AIService(req, res, next)
      }
    }
  )
  // FIXED: 2026-11-07 SSE 探针：排查“事件流不吐”时用，3 秒 4 帧，不调模型不计费
  webRouter.get('/ft-ai/stream-probe', (req, res, next) => {
    NEService.AiChatStreamProbe(req, res).catch(next)
  })

  // FIXED: 2026-11-16 编译错误一键修复：生成建议（读+提议，不写项目）/ 应用建议（复用 Agent 写通道）
  // 两条都挂在既有 /ft-ai 前缀下，nginx 不需要新增 location。
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/error-fix', 'POST')
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/error-fix/apply', 'POST')
  webRouter.post(
    '/ft-ai/error-fix',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiErrorFix(req, res).catch(next)
    }
  )
  webRouter.post(
    '/ft-ai/error-fix/apply',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiErrorFixApply(req, res).catch(next)
    }
  )

  // FIXED: 2026-11-01 切走页面不再中断 Agent 后，「停止」必须显式告知服务端：
  // 以前前端 abort fetch 就等于关页签，服务端无法区分。
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/stop', 'POST')
  webRouter.post(
    '/ft-ai/stop',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiStopRun(req, res).catch(next)
    }
  )

  // FIXED: 2026-11-01 面板打开时查询“上一轮是不是还在跑”（不调模型、不计费）
  webRouter.get(
    '/ft-ai/run',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiRunStatus(req, res).catch(next)
    }
  )

  // FIXED: 2026-11 切回页面「接上」进行中的一轮（只读快照 + 订阅增量，不调模型、不计费）：
  // 200 = SSE 快照+增量；204 = 没有可接的（前端去拉历史消息）
  webRouter.get(
    '/ft-ai/stream',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiResumeStream(req, res).catch(next)
    }
  )

  // FIXED: 2026-11-01 设置 → AI 助手 → AMiner 搜索（互联网论文检索）
  // 查询当前账号是否已配置（不回传明文 token）
  webRouter.get(
    '/ft-ai/aminer-status',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiAminerStatus(req, res).catch(next)
    }
  )
  // 保存 / 清除 token（空串 = 关闭）；服务端先拿它做一次真实检索验证
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/aminer-key', 'POST')
  webRouter.post(
    '/ft-ai/aminer-key',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiAminerKeySave(req, res).catch(next)
    }
  )

  // FIXED: 2026-11 设置 → AI 助手 → Agent 耐心程度（严格 / 标准 / 更耐心）
  // GET 回「档位 + 每档实际生效的上限 + 服务端硬顶」，POST 只写档位名。
  webRouter.get(
    '/ft-ai/agent-effort',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiAgentEffortStatus(req, res).catch(next)
    }
  )
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/agent-effort', 'POST')
  webRouter.post(
    '/ft-ai/agent-effort',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiAgentEffortSave(req, res).catch(next)
    }
  )

  // FIXED: 2026-11-13 设置 → AI 助手 → MCP 服务（用户自己接入的远程 MCP 服务，最多 3 个）
  // GET 回清单（headers 只回掩码，从不回明文）；POST 整份替换。
  webRouter.get(
    '/ft-ai/mcp-servers',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiMcpServers(req, res).catch(next)
    }
  )
  // FIXED: 2026-11-18 AI 面板输入 `/` 的 MCP 服务菜单：只回「启用中」的服务名
  // （不含地址/headers），没有可用服务时回空数组 → 前端什么都不弹。
  webRouter.get(
    '/ft-ai/mcp-servers/usable',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiMcpServersUsable(req, res).catch(next)
    }
  )
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/mcp-servers', 'POST')
  webRouter.post(
    '/ft-ai/mcp-servers',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiMcpServersSave(req, res).catch(next)
    }
  )
  // 保存前先试连通（也用于设置页的「测试」按钮）：回 serverInfo / 工具数 / 错误原因
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/mcp-servers/test', 'POST')
  webRouter.post(
    '/ft-ai/mcp-servers/test',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiMcpServersTest(req, res).catch(next)
    }
  )
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/mcp-servers/delete', 'POST')
  webRouter.post(
    '/ft-ai/mcp-servers/delete',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiMcpServersDelete(req, res).catch(next)
    }
  )

  // FIXED: 2026-11-08 设置 → AI 助手 → 默认 LLM 模型：返回当前账号可用的对话模型清单，
  // 不调模型、不计费（网关清单拿不到时返回空数组，前端只显示“跟随系统默认”）
  webRouter.get(
    '/ft-ai/models',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiModels(req, res).catch(next)
    }
  )

  // FIXED: 2026-10-30 网关自检：排查"AI 服务无响应"时用，返回
  // {model, billing, status, errorMessage}。只发一句 "ping"，成本可忽略。
  webRouter.csrf.disableDefaultCsrfProtection('/ft-ai/diag', 'POST')
  webRouter.post(
    '/ft-ai/diag',
    AuthenticationController.requireLogin(),
    (req, res, next) => {
      NEService.AiDiagService(req, res).catch(next)
    }
  )

  // console.log('add ai service, and add to whitelist')

  // FIXED: 2026-05-06 CARSI认证回调处理
  // 禁用CSRF保护因为：1) 认证信息由服务端缓存保证 2) AUT token已验证 3) 自动提交表单来自服务器
  // 必须加入全局登录白名单，因为用户在此端点处理之前尚未登录
  webRouter.csrf.disableDefaultCsrfProtection('/carsi-auth-callback', 'POST')
  AuthenticationController.addEndpointToLoginWhitelist('/carsi-auth-callback')

  webRouter.post(
    '/carsi-auth-callback',
    CarsiAuthCallbackController.handleCarsiAuthCallback
  )

  // add CrossRef search service
  publicApiRouter.post('/cross-ref-search', CrossRefService.crossRefSearch)

  webRouter.post(
    '/project/:Project_id/update-bib-file',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    CrossRefService.updateBibFile
  )
  // console.log('add CrossRef search service')

  webRouter.get('/unsupported-browser', renderUnsupportedBrowserPage)

  // FIXED: 2026-10-11 登录页人机验证（用户中心认证 V2）：服务端代理字典返回验证码配置，
  // 避免把用户中心地址/公钥以及 baseUrl 暴露给前端。
  AuthenticationController.addEndpointToLoginWhitelist('/ne/captcha-config')
  webRouter.get('/ne/captcha-config', NEService.GetCaptchaConfig)

  // FIXED: 2026-10-11 认证 V2：短信验证码登录
  // 发短信接口（匿名可访问，需先通过登录页的人机验证）
  AuthenticationController.addEndpointToLoginWhitelist('/ne/sendcode')
  webRouter.post('/ne/sendcode', NEService.SendLoginSms)

  // FIXED: 2026-10-11 认证 V2：CARSI（字典入口 + PKCE）
  // 注意：/ne-auth-callback 必须与用户在 NE 登记的 redirect 逐字符一致
  AuthenticationController.addEndpointToLoginWhitelist('/carsi')
  webRouter.get('/carsi', CarsiV2Service.startCarsiLogin)
  AuthenticationController.addEndpointToLoginWhitelist('/ne-auth-callback')
  webRouter.get('/ne-auth-callback', CarsiV2Service.handleCarsiCallback)
  // FIXED: 2026-10-27 设置页的「重新连接 NE 账号」：已登录用户点一下就走一次
  // 授权码流程（用户中心还有会话时无需输入密码），回调仍在 /ne-auth-callback。
  webRouter.get('/ne-relink', NeLinkService.startRelink)
  // 短信验证码登录表单提交
  AuthenticationController.addEndpointToLoginWhitelist('/login/sms')
  webRouter.post('/login/sms', AuthenticationController.smsLogin)
  // FIXED: 2026-11-19 应急：同上，短信登录也先关掉 CSRF 校验
  webRouter.csrf.disableDefaultCsrfProtection('/login/sms', 'POST')

  webRouter.get('/neTexUsedInformation', NEService.UsedInformation)

  webRouter.get('/getSid', NEService.GetSID)

  publicApiRouter.get('/carsiLogin', CarsiService.login)

  webRouter.get('*', ErrorController.notFound)
}

module.exports = { initialize, rateLimiters }
