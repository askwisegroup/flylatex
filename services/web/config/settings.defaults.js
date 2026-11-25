const fs = require('fs')
const Path = require('path')
const { merge } = require('@overleaf/settings/merge')
// FIXED: 2026-11-18 内部/私有默认值的唯一出口（开源前可整体移出仓库，见该文件头部说明）
const INTERNAL = require('./internal-values')

// FIXED: 2026-11-19 生产保护：容器里历史遗留的 PUBLIC_URL 可能是本机地址。
// 直接采用会让 siteUrl / allowedOrigins 全错（POST 带 Origin 会被
// blockCrossOriginRequests 判成跨域 → 403，前端显示「Session error」）。
// 生产环境遇到本机 PUBLIC_URL 时回落到 internal-values 的 site.url。
const LOOPBACK_URL =
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i
function resolveSiteUrl() {
  const envUrl = process.env.PUBLIC_URL
  const internalUrl = INTERNAL.site && INTERNAL.site.url
  if (
    process.env.NODE_ENV === 'production' &&
    envUrl &&
    LOOPBACK_URL.test(envUrl) &&
    internalUrl &&
    !LOOPBACK_URL.test(internalUrl)
  ) {
    console.warn(
      `[settings] 生产环境忽略本机 PUBLIC_URL=${envUrl}，改用 ${internalUrl}（请尽快修正部署 env）`
    )
    return internalUrl
  }
  return envUrl || internalUrl || 'http://localhost:3000'
}

const MODULES_PATH = Path.join(__dirname, '../modules')
const entryPointsIde = []
const entryPointsMain = []
fs.readdirSync(MODULES_PATH).forEach(module => {
  const entryPathIde = Path.join(
    MODULES_PATH,
    module,
    '/frontend/js/ide/index.js'
  )
  if (fs.existsSync(entryPathIde)) {
    entryPointsIde.push(entryPathIde)
  }
  const entryPathMain = Path.join(
    MODULES_PATH,
    module,
    '/frontend/js/main/index.js'
  )
  if (fs.existsSync(entryPathMain)) {
    entryPointsMain.push(entryPathMain)
  }
})

let defaultFeatures, siteUrl

// Make time interval config easier.
const seconds = 1000
const minutes = 60 * seconds

// These credentials are used for authenticating api requests
// between services that may need to go over public channels
const httpAuthUser = process.env.WEB_API_USER
const httpAuthPass = process.env.WEB_API_PASSWORD
const httpAuthUsers = {}
if (httpAuthUser && httpAuthPass) {
  httpAuthUsers[httpAuthUser] = httpAuthPass
}

const sessionSecret = process.env.SESSION_SECRET || 'secret-please-change'

const intFromEnv = function (name, defaultValue) {
  if (
    [null, undefined].includes(defaultValue) ||
    typeof defaultValue !== 'number'
  ) {
    throw new Error(
      `Bad default integer value for setting: ${name}, ${defaultValue}`
    )
  }
  return parseInt(process.env[name], 10) || defaultValue
}

// ===========================================================================
// FIXED: 2026-11-12 部署档位（DEPLOYMENT_PROFILE）
//
// 目的：同一个 master 代码库同时支撑「中国站(cn)」与「海外站(sg)」，
//       两边差异**只体现在配置上**，不在业务代码里分叉。
//
// 规则（新增代码必须遵守）：
//   1. 禁止在业务代码里写 `if (Settings.deployment.profile === 'sg')`；
//      需要差异化时一律读对应能力开关（loginProviders / billing / llm）。
//   2. 开关默认值由档位推导，仍可用 env 逐项覆盖 —— 覆盖失败可单点回退。
//   3. 这里只声明「默认值」，不含任何业务逻辑。
// ===========================================================================
const DEPLOYMENT_PROFILE = (process.env.DEPLOYMENT_PROFILE || 'cn')
  .trim()
  .toLowerCase()
// 海外档：sg / global 等价，便于运维用更直观的名字。
const IS_GLOBAL_PROFILE = ['sg', 'global', 'overseas'].includes(
  DEPLOYMENT_PROFILE
)

// ===========================================================================
// FIXED: 2026-11-13 审阅面板（行内批注）开关。
//
// 背景：CE 的前端其实带全套审阅面板（source-editor/components/review-panel/**），
//       唯独缺服务端路由。modules/review-panel 把它补齐：模块一加载，
//       路由、面板入口按钮、React 版审阅面板同时生效。
//
// 常开，无环境变量开关 —— 这就是产品功能本身。
// 跟踪修改（接受/拒绝）后端未实现，由 defaultFeatures.trackChanges = false 关闭。
// ===========================================================================

/**
 * 布尔型 env：未设置时用 fallback，设置了就看是否 false/0/off/no。
 * 之所以不用 `process.env.X === 'true'`：运维习惯写 `LOGIN_GOOGLE=1`，
 * 严格比较会把 `1` 当成关闭，属于静默失败，很难排查。
 */
const envFlag = function (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return !/^(0|false|off|no)$/i.test(String(raw).trim())
}


const envNumber = function (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 编译超时（秒）—— 全仓库唯一来源，其他模块一律从 Settings.compileTimeouts 读取。
 *
 * FIXED: 2026-10-23 线上 /etc/sharelatex/settings.js 写的是
 *   `compileTimeout: parseIntOrFail(process.env.COMPILE_TIMEOUT || 180)`
 * 未设置环境变量时静默回落到 180 秒，导致新注册用户也是 3 分钟。
 * 现在仓库默认值与线上配置读同一个环境变量，口径一致。
 *
 * max 与 VIP 值必须与 CLSI 的 MAX_TIMEOUT（services/clsi/app/js/RequestParser.js）
 * 保持一致，否则超时的编译会被 CLSI 截断。
 */
const COMPILE_TIMEOUT_LIMITS = {
  fallback: 300, // 未设置 COMPILE_TIMEOUT 时的标准版默认值
  min: 60,
  max: 600, // CLSI 硬上限
  vip: 600, // VIP 配额，取上限
}

const defaultCompileTimeout = (() => {
  const { fallback, min, max } = COMPILE_TIMEOUT_LIMITS
  const raw = process.env.COMPILE_TIMEOUT
  if (raw === undefined || raw === '') {
    return fallback
  }
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[settings] 忽略非法的 COMPILE_TIMEOUT=${raw}（允许 ${min}..${max} 秒），使用默认 ${fallback} 秒`
    )
    return fallback
  }
  if (parsed < fallback) {
    // 显式设置低于标准版时给出提示，避免历史上「静默回落到 180」的问题重现
    console.warn(
      `[settings] COMPILE_TIMEOUT=${parsed} 低于标准版 ${fallback} 秒，` +
        '新注册用户的编译超时将是该值'
    )
  }
  return parsed
})()

const defaultTextExtensions = [
  'tex',
  'latex',
  'sty',
  'cls',
  'bst',
  'bib',
  'bibtex',
  'txt',
  'tikz',
  'mtx',
  'rtex',
  'md',
  'asy',
  'lbx',
  'bbx',
  'cbx',
  'm',
  'lco',
  'dtx',
  'ins',
  'ist',
  'def',
  'clo',
  'ldf',
  'rmd',
  'lua',
  'gv',
  'mf',
  'yml',
  'yaml',
  'lhs',
  'mk',
  'xmpdata',
]

const parseTextExtensions = function (extensions) {
  if (extensions) {
    return extensions.split(',').map(ext => ext.trim())
  } else {
    return []
  }
}

module.exports = {
  env: 'server-ce',

  limits: {
    httpGlobalAgentMaxSockets: 300,
    httpsGlobalAgentMaxSockets: 300,
  },

  // FIXED: 2026-11-14 这里原本还有一份 allowAnonymousReadAndWriteSharing
  // （只认 SHARELATEX_ALLOW_ANONYMOUS_READ_AND_WRITE_SHARING、缺省 false）。
  // 同一个对象里同名键定义两次，后者胜出 —— 那份定义等于把所有读取它的
  // 代码全部钉死成 false，而肉眼看不出问题。现已合并到文件末尾一份。

  // Databases
  // ---------
  mongo: {
    options: {
      appname: 'web',
      maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE, 10) || 100,
      serverSelectionTimeoutMS:
        parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT, 10) || 60000,
      // Setting socketTimeoutMS to 0 means no timeout
      socketTimeoutMS: parseInt(
        process.env.MONGO_SOCKET_TIMEOUT ?? '60000',
        10
      ),
    },
    url:
      process.env.MONGO_CONNECTION_STRING ||
      process.env.MONGO_URL ||
      `mongodb://${process.env.MONGO_HOST || '127.0.0.1'}/sharelatex`,
    hasSecondaries: process.env.MONGO_HAS_SECONDARIES === 'true',
  },

  redis: {
    web: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || '6379',
      password: process.env.REDIS_PASSWORD || '',
      db: process.env.REDIS_DB,
      maxRetriesPerRequest: parseInt(
        process.env.REDIS_MAX_RETRIES_PER_REQUEST || '20'
      ),
    },

    // websessions:
    // 	cluster: [
    // 		{host: 'localhost', port: 7000}
    // 		{host: 'localhost', port: 7001}
    // 		{host: 'localhost', port: 7002}
    // 		{host: 'localhost', port: 7003}
    // 		{host: 'localhost', port: 7004}
    // 		{host: 'localhost', port: 7005}
    // 	]

    // ratelimiter:
    // 	cluster: [
    // 		{host: 'localhost', port: 7000}
    // 		{host: 'localhost', port: 7001}
    // 		{host: 'localhost', port: 7002}
    // 		{host: 'localhost', port: 7003}
    // 		{host: 'localhost', port: 7004}
    // 		{host: 'localhost', port: 7005}
    // 	]

    // cooldown:
    // 	cluster: [
    // 		{host: 'localhost', port: 7000}
    // 		{host: 'localhost', port: 7001}
    // 		{host: 'localhost', port: 7002}
    // 		{host: 'localhost', port: 7003}
    // 		{host: 'localhost', port: 7004}
    // 		{host: 'localhost', port: 7005}
    // 	]

    api: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || '6379',
      password: process.env.REDIS_PASSWORD || '',
      maxRetriesPerRequest: parseInt(
        process.env.REDIS_MAX_RETRIES_PER_REQUEST || '20'
      ),
    },
  },

  // Service locations
  // -----------------

  // Configure which ports to run each service on. Generally you
  // can leave these as they are unless you have some other services
  // running which conflict, or want to run the web process on port 80.
  internal: {
    web: {
      port: process.env.WEB_PORT || 3000,
      host: process.env.LISTEN_ADDRESS || 'localhost',
    },
  },

  // Tell each service where to find the other services. If everything
  // is running locally then this is easy, but they exist as separate config
  // options incase you want to run some services on remote hosts.
  apis: {
    web: {
      url: `http://${process.env.WEB_API_HOST || process.env.WEB_HOST || 'localhost'
        }:${process.env.WEB_API_PORT || process.env.WEB_PORT || 3000}`,
      user: httpAuthUser,
      pass: httpAuthPass,
    },
    documentupdater: {
      url: `http://${process.env.DOCUPDATER_HOST ||
        process.env.DOCUMENT_UPDATER_HOST ||
        'localhost'
        }:3003`,
    },
    spelling: {
      url: `http://${process.env.SPELLING_HOST || 'localhost'}:3005`,
      host: process.env.SPELLING_HOST,
    },
    docstore: {
      url: `http://${process.env.DOCSTORE_HOST || 'localhost'}:3016`,
      pubUrl: `http://${process.env.DOCSTORE_HOST || 'localhost'}:3016`,
    },
    chat: {
      internal_url: `http://${process.env.CHAT_HOST || 'localhost'}:3010`,
    },
    filestore: {
      url: `http://${process.env.FILESTORE_HOST || 'localhost'}:3009`,
    },
    clsi: {
      url: `http://${process.env.CLSI_HOST || 'localhost'}:3013`,
      // url: "http://#{process.env['CLSI_LB_HOST']}:3014"
      backendGroupName: undefined,
      defaultBackendClass: process.env.CLSI_DEFAULT_BACKEND_CLASS || 'e2',
      submissionBackendClass:
        process.env.CLSI_SUBMISSION_BACKEND_CLASS || 'n2d',
    },
    project_history: {
      sendProjectStructureOps: true,
      url: `http://${process.env.PROJECT_HISTORY_HOST || 'localhost'}:3054`,
    },
    realTime: {
      url: `http://${process.env.REALTIME_HOST || 'localhost'}:3026`,
    },
    contacts: {
      url: `http://${process.env.CONTACTS_HOST || 'localhost'}:3036`,
    },
    notifications: {
      url: `http://${process.env.NOTIFICATIONS_HOST || 'localhost'}:3042`,
    },
    webpack: {
      url: `http://${process.env.WEBPACK_HOST || 'localhost'}:3808`,
    },
    wiki: {
      url: process.env.WIKI_URL || INTERNAL.misc.wikiUrl,
      maxCacheAge: parseInt(process.env.WIKI_MAX_CACHE_AGE || 5 * minutes, 10),
    },

    haveIBeenPwned: {
      enabled: process.env.HAVE_I_BEEN_PWNED_ENABLED === 'true',
      url:
        process.env.HAVE_I_BEEN_PWNED_URL ||
        INTERNAL.misc.haveIBeenPwnedUrl,
      timeout: parseInt(process.env.HAVE_I_BEEN_PWNED_TIMEOUT, 10) || 5 * 1000,
    },

    // FIXED: 2026-11-01 AI 工具「互联网论文检索」（AMiner 开放平台）
    // token 由**每个用户**在 设置 → AI 助手 → AMiner 搜索 里自己填（存 user.ace.aminerApiKey），
    // 没填就不启用。这里只保留基础地址，**不要**把任何 key 写进仓库。
    aminer: {
      // FIXED: 2026-11-18 默认值收口到 internal-values
      url: process.env.AMINER_API_URL || INTERNAL.aminer.apiUrl,
    },

    // For legacy reasons, we need to populate the below objects.
    v1: {},
    recurly: {},
  },

  jwt: {
    key: process.env.OT_JWT_AUTH_KEY,
    algorithm: process.env.OT_JWT_AUTH_ALG || 'HS256',
  },

  splitTests: [],

  // Where your instance of ShareLaTeX can be found publically. Used in emails
  // that are sent out, generated links, etc.
  // FIXED: 2026-11-19 修掉死代码 `('https://www.example.com' || PUBLIC_URL)`：
  // PUBLIC_URL 现在生效，但生产环境会忽略「本机地址」的 PUBLIC_URL（见 resolveSiteUrl），
  // 避免历史遗留的 localhost 把 siteUrl / allowedOrigins 带偏。
  siteUrl: siteUrl = resolveSiteUrl(),

  // FIXED: 2026-11-01 「帮助 - 联系我们」点击后跳转的地址。
  // 可以是 http(s) 链接，也可以是 mailto: / tel: 这类协议。
  // 没配环境变量就回落到公司论坛（前端 shared/utils/contact-us.ts 里还有一层兜底）。
  contactUsUrl:
    process.env.CONTACT_US_URL || INTERNAL.misc.contactUsUrl,

  lockManager: {
    lockTestInterval: intFromEnv('LOCK_MANAGER_LOCK_TEST_INTERVAL', 50),
    maxTestInterval: intFromEnv('LOCK_MANAGER_MAX_TEST_INTERVAL', 1000),
    maxLockWaitTime: intFromEnv('LOCK_MANAGER_MAX_LOCK_WAIT_TIME', 10000),
    redisLockExpiry: intFromEnv('LOCK_MANAGER_REDIS_LOCK_EXPIRY', 30),
    slowExecutionThreshold: intFromEnv(
      'LOCK_MANAGER_SLOW_EXECUTION_THRESHOLD',
      5000
    ),
  },

  // Optional separate location for websocket connections, if unset defaults to siteUrl.
  wsUrl: process.env.WEBSOCKET_URL,
  wsUrlV2: process.env.WEBSOCKET_URL_V2,
  wsUrlBeta: process.env.WEBSOCKET_URL_BETA,

  wsUrlV2Percentage: parseInt(
    process.env.WEBSOCKET_URL_V2_PERCENTAGE || '0',
    10
  ),
  wsRetryHandshake: parseInt(process.env.WEBSOCKET_RETRY_HANDSHAKE || '5', 10),

  // cookie domain
  // use full domain for cookies to only be accessible from that domain,
  // replace subdomain with dot to have them accessible on all subdomains
  // FIXED: 2026-11-19 恢复原行为：session cookie 只认 COOKIE_DOMAIN，
  // 不再回落到 internal-values（否则 session cookie 会突然变成跨子域，
  // 与浏览器里已有的 host-only cookie 冲突，表现为登录 403/Session error）。
  cookieDomain: process.env.COOKIE_DOMAIN,
  // 语言选择 cookie 的域（仅模板使用），与 session cookie 分开
  languageCookieDomain:
    process.env.LANGUAGE_COOKIE_DOMAIN ||
    (INTERNAL.site && INTERNAL.site.cookieDomain),
  // FIXED: 2026-11-19 白板地址收口到 internal-values（layout-base.pug 不再写死）
  whiteboardUrl:
    process.env.WHITEBOARD_URL ||
    (INTERNAL.site && INTERNAL.site.whiteboardUrl),
  cookieName: process.env.COOKIE_NAME || 'sharelatex.sid',
  cookieRollingSession: true,

  // this is only used if cookies are used for clsi backend
  // clsiCookieKey: "clsiserver"

  robotsNoindex: process.env.ROBOTS_NOINDEX === 'true' || false,

  maxEntitiesPerProject: 2000,

  projectUploadTimeout: parseInt(
    process.env.PROJECT_UPLOAD_TIMEOUT || '120000',
    10
  ),
  maxUploadSize: 50 * 1024 * 1024, // 50 MB

  // FIXED: 2026-11-15 普通用户 / VIP 的资源上限（见 Features/User/UserVip.js）
  // 注意：这里的数字只影响新逻辑，不改动上面的 maxUploadSize 等既有配置，
  // 避免影响未登录、系统内部调用等没有用户上下文的路径。
  userLimits: {
    normal: {
      collaborators: 5,
      projects: 50,
      storageBytes: 256 * 1024 * 1024, // 256 MB
      maxUploadSize: 10 * 1024 * 1024, // 10 MB
    },
    vip: {
      collaborators: -1, // -1 = 不限制
      projects: null, // null = 不限制
      storageBytes: 2 * 1024 * 1024 * 1024, // 2 GB
      // 0 = 使用全局 Settings.maxUploadSize，保留部署方可调空间
      maxUploadSize: 0,
      agentCompileTimeout: 600, // 10 分钟，与 CLSI MAX_TIMEOUT 对齐
    },
  },

  multerOptions: {
    preservePath: process.env.MULTER_PRESERVE_PATH,
  },

  // start failing the health check if active handles exceeds this limit
  maxActiveHandles: process.env.MAX_ACTIVE_HANDLES
    ? parseInt(process.env.MAX_ACTIVE_HANDLES, 10)
    : undefined,

  // Security
  // --------
  security: {
    sessionSecret,
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
  }, // number of rounds used to hash user passwords (raised to power 2)

  adminUrl: process.env.ADMIN_URL,
  adminOnlyLogin: process.env.ADMIN_ONLY_LOGIN === 'true',
  adminPrivilegeAvailable: process.env.ADMIN_PRIVILEGE_AVAILABLE === 'true',
  blockCrossOriginRequests: process.env.BLOCK_CROSS_ORIGIN_REQUESTS === 'true',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || siteUrl).split(','),

  httpAuthUsers,

  // Default features
  // ----------------
  //
  // You can select the features that are enabled by default for new
  // new users.
  // 编译超时（秒）：default 为当前生效值，其余为上限/下限，供业务代码统一引用
  compileTimeouts: Object.assign({}, COMPILE_TIMEOUT_LIMITS, {
    default: defaultCompileTimeout,
  }),

  defaultFeatures: (defaultFeatures = {
    collaborators: -1,
    dropbox: true,
    github: true,
    gitBridge: true,
    versioning: true,
    // FIXED: 2026-10-23 由 COMPILE_TIMEOUT 环境变量控制，默认 300 秒
    // OLD: compileTimeout: 300, // 180 seconds upgrade to 300 seconds
    compileTimeout: defaultCompileTimeout,
    compileGroup: 'standard',
    references: true,
    templates: true,
    // FIXED: 2026-11-13 打开「跟踪修改」（track changes）。
    // 后端已补齐（modules/review-panel 的 /track_changes 与 /doc/:id/changes/accept，
    // 合并逻辑走 document-updater 的 DocumentManager.acceptChanges）。
    // OLD: trackChanges: false,   // 当时后端路由缺失，开着会 404
    trackChanges: true,
  }),

  // featuresEpoch: 'YYYY-MM-DD',

  features: {
    personal: defaultFeatures,
  },

  groupPlanModalOptions: {
    plan_codes: [],
    currencies: [],
    sizes: [],
    usages: [],
  },
  plans: [
    {
      planCode: 'personal',
      name: 'Personal',
      price_in_cents: 0,
      features: defaultFeatures,
    },
  ],

  enableSubscriptions: false,

  // FIXED: 2026-10-29 主题开关。
  // 上游用 `Settings.overleaf != null` 判断是否开启主题能力（那是云版专属配置），
  // 本 fork 没有配 overleaf，导致主题下拉框根本不渲染、服务端也只发默认样式表。
  // 设成 false 可恢得上游的旧行为。
  enableOverallThemes: true,

  restrictedCountries: [],

  enabledLinkedFileTypes: (process.env.ENABLED_LINKED_FILE_TYPES || '').split(
    ','
  ),

  // i18n
  // ------
  //
  i18n: {
    checkForHTMLInVars: process.env.I18N_CHECK_FOR_HTML_IN_VARS === 'true',
    escapeHTMLInVars: process.env.I18N_ESCAPE_HTML_IN_VARS === 'true',
    subdomainLang: {
      www: { lngCode: 'zh-CN', url: siteUrl },
    },
    defaultLng: 'zh-CN', //en',
  },

  // Spelling languages
  // ------------------
  //
  // You must have the corresponding aspell package installed to
  // be able to use a language.
  languages: [
    { code: 'en', name: 'English' },
    { code: 'en_US', name: 'English (American)' },
    { code: 'en_GB', name: 'English (British)' },
    { code: 'en_CA', name: 'English (Canadian)' },
    { code: 'af', name: 'Afrikaans' },
    { code: 'ar', name: 'Arabic' },
    { code: 'gl', name: 'Galician' },
    { code: 'eu', name: 'Basque' },
    { code: 'br', name: 'Breton' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'ca', name: 'Catalan' },
    { code: 'hr', name: 'Croatian' },
    { code: 'cs', name: 'Czech' },
    { code: 'da', name: 'Danish' },
    { code: 'nl', name: 'Dutch' },
    { code: 'eo', name: 'Esperanto' },
    { code: 'et', name: 'Estonian' },
    { code: 'fo', name: 'Faroese' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'el', name: 'Greek' },
    { code: 'id', name: 'Indonesian' },
    { code: 'ga', name: 'Irish' },
    { code: 'it', name: 'Italian' },
    { code: 'kk', name: 'Kazakh' },
    { code: 'ku', name: 'Kurdish' },
    { code: 'lv', name: 'Latvian' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'nr', name: 'Ndebele' },
    { code: 'ns', name: 'Northern Sotho' },
    { code: 'no', name: 'Norwegian' },
    { code: 'fa', name: 'Persian' },
    { code: 'pl', name: 'Polish' },
    { code: 'pt_BR', name: 'Portuguese (Brazilian)' },
    { code: 'pt_PT', name: 'Portuguese (European)' },
    { code: 'pa', name: 'Punjabi' },
    { code: 'ro', name: 'Romanian' },
    { code: 'ru', name: 'Russian' },
    { code: 'sk', name: 'Slovak' },
    { code: 'sl', name: 'Slovenian' },
    { code: 'st', name: 'Southern Sotho' },
    { code: 'es', name: 'Spanish' },
    { code: 'sv', name: 'Swedish' },
    { code: 'tl', name: 'Tagalog' },
    { code: 'ts', name: 'Tsonga' },
    { code: 'tn', name: 'Tswana' },
    { code: 'hsb', name: 'Upper Sorbian' },
    { code: 'cy', name: 'Welsh' },
    { code: 'xh', name: 'Xhosa' },
  ],

  translatedLanguages: {
    cn: '简体中文',
    cs: 'Čeština',
    da: 'Dansk',
    de: 'Deutsch',
    en: 'English',
    es: 'Español',
    fi: 'Suomi',
    fr: 'Français',
    it: 'Italiano',
    ja: '日本語',
    ko: '한국어',
    nl: 'Nederlands',
    no: 'Norsk',
    pl: 'Polski',
    pt: 'Português',
    ro: 'Română',
    ru: 'Русский',
    sv: 'Svenska',
    tr: 'Türkçe',
    uk: 'Українська',
    'zh-CN': '简体中文',
    // FIXED: 2026-11-10 zh-TW 是已支持的语言（locales/zh-TW.json + availableLanguageCodes 都有），
    // 但这里一直漏了，语言选择器取 settings.translatedLanguages[currentLngCode] 会拿到空。
    'zh-TW': '繁體中文',
  },

  maxDictionarySize: 1024 * 1024, // 1 MB

  // Password Settings
  // -----------
  // These restrict the passwords users can use when registering
  // opts are from http://antelle.github.io/passfield
  passwordStrengthOptions: {
    length: {
      min: 8,
      // Bcrypt does not support longer passwords than that.
      max: 72,
    },
  },

  elevateAccountSecurityAfterFailedLogin:
    parseInt(process.env.ELEVATED_ACCOUNT_SECURITY_AFTER_FAILED_LOGIN_MS, 10) ||
    24 * 60 * 60 * 1000,

  deviceHistory: {
    cookieName: process.env.DEVICE_HISTORY_COOKIE_NAME || 'deviceHistory',
    entryExpiry:
      parseInt(process.env.DEVICE_HISTORY_ENTRY_EXPIRY_MS, 10) ||
      90 * 24 * 60 * 60 * 1000,
    maxEntries: parseInt(process.env.DEVICE_HISTORY_MAX_ENTRIES, 10) || 10,
    secret: process.env.DEVICE_HISTORY_SECRET,
  },

  // Email support
  // -------------
  //
  //	ShareLaTeX uses nodemailer (http://www.nodemailer.com/) to send transactional emails.
  //	To see the range of transport and options they support, see http://www.nodemailer.com/docs/transports
  // email:
  //	fromAddress: ""
  //	replyTo: ""
  //	lifecycle: false
  // # Example transport and parameter settings for Amazon SES
  //	transport: "SES"
  //	parameters:
  //		AWSAccessKeyID: ""
  //		AWSSecretKey: ""

  // For legacy reasons, we need to populate this object.
  sentry: {},

  // Production Settings
  // -------------------
  debugPugTemplates: process.env.DEBUG_PUG_TEMPLATES === 'true',
  precompilePugTemplatesAtBootTime: process.env
    .PRECOMPILE_PUG_TEMPLATES_AT_BOOT_TIME
    ? process.env.PRECOMPILE_PUG_TEMPLATES_AT_BOOT_TIME === 'true'
    : process.env.NODE_ENV === 'production',

  // Should javascript assets be served minified or not.
  useMinifiedJs: process.env.MINIFIED_JS === 'true' || false,

  // Should static assets be sent with a header to tell the browser to cache
  // them.
  cacheStaticAssets: false,

  // If you are running ShareLaTeX over https, set this to true to send the
  // cookie with a secure flag (recommended).
  secureCookie: false,

  // 'SameSite' cookie setting. Can be set to 'lax', 'none' or 'strict'
  // 'lax' is recommended, as 'strict' will prevent people linking to projects
  // https://tools.ietf.org/html/draft-ietf-httpbis-rfc6265bis-03#section-4.1.2.7
  sameSiteCookie: 'lax',

  // If you are running ShareLaTeX behind a proxy (like Apache, Nginx, etc)
  // then set this to true to allow it to correctly detect the forwarded IP
  // address and http/https protocol information.
  behindProxy: false,

  // Delay before closing the http server upon receiving a SIGTERM process signal.
  gracefulShutdownDelayInMs:
    parseInt(process.env.GRACEFUL_SHUTDOWN_DELAY_SECONDS ?? '5', 10) * seconds,

  // Expose the hostname in the `X-Served-By` response header
  exposeHostname: process.env.EXPOSE_HOSTNAME === 'true',

  // Cookie max age (in milliseconds). Set to false for a browser session.
  cookieSessionLength: 24 * 60 * 60 * 1000, // 24 hours

  // When true, only allow invites to be sent to email addresses that
  // already have user accounts
  restrictInvitesToExistingAccounts: false,

  // Should we allow access to any page without logging in? This includes
  // public projects, /learn, /templates, about pages, etc.
  //
  // FIXED: 2026-11-14 默认打开（**所有档位**，不再只限海外）。
  //
  // 原来固定按 env 取，缺省 false → `router.js` 会挂上 requireGlobalLogin
  // 这道「全站登录墙」。白名单是精确路径匹配，动态的分享链接
  // 写死 true，不读环境变量（FIXED: 2026-11-14）。
  //
  // 它决定 router.js 要不要挂 requireGlobalLogin 那道「全站登录墙」。
  // 登录墙的白名单是精确路径匹配，动态的 /project/e/<token> 永远进不去，
  // grant 之后跳转的 /project/<id> 也会被拦 —— 只要它是 false，链接分享就废；
  // 而这个值此前由「环境变量 + 部署档位」决定，于是 sg 能用、cn 不能用。
  // 权限控制没有放宽：每条路由仍各自校验（requireLogin /
  // ensureUserCanReadProject），没权限一样进不去。上游 CE 也默认 true。
  allowPublicAccess: true,

  // 写死 true，不读环境变量（FIXED: 2026-11-14）。
  //
  // 可编辑分享链接由项目所有者主动创建：拿到链接的人直接获得编辑权限，
  // 不该再让他注册登录。此前它由「环境变量 + 部署档位」决定，为假时
  // TokenAccessController 会把匿名访问者丢去 /restricted → /login。
  // 权限边界仍在：链接必须有效（tokens 存在且 publicAccesLevel=tokenBased），
  // 关闭分享会清空 tokens，旧链接立刻失效。
  allowAnonymousReadAndWriteSharing: true,

  // editor should be open by default
  editorIsOpen: process.env.EDITOR_OPEN !== 'false',

  // site should be open by default
  siteIsOpen: process.env.SITE_OPEN !== 'false',
  // status file for closing/opening the site at run-time, polled every 5s
  siteMaintenanceFile: process.env.SITE_MAINTENANCE_FILE,

  // Use a single compile directory for all users in a project
  // (otherwise each user has their own directory)
  // disablePerUserCompiles: true

  // Domain the client (pdfjs) should download the compiled pdf from
  pdfDownloadDomain: process.env.PDF_DOWNLOAD_DOMAIN, // "http://clsi-lb:3014"
  compilesUserContentDomain: process.env.COMPILES_USER_CONTENT_DOMAIN,

  // By default turn on feature flag, can be overridden per request.
  enablePdfCaching: process.env.ENABLE_PDF_CACHING === 'true',

  // FIXED: 2026-11-08 编译新鲜度指纹（CompileFreshness）
  //   enabled=false（默认）：只记录指纹 + 提供 GET /compile/fresh 供观察，
  //                        前端不会据此跳过编译，行为与之前完全一致。
  //   enabled=true        ：前端（阶段 ③）在内容未变时跳过编译。
  // ttlSeconds：指纹保留时长，默认 7 天。
  compileFreshness: {
    // FIXED: 2026-11-08 改成默认开启（opt-out）。
    // 之前是 opt-in（=== 'true'），而部署里没人设置这个环境变量 →
    // 接口永远返回 skipEnabled:false → 前端每次打开项目照样编一遍，
    // 表现就是「这个功能根本没生效」。默认开启后不需要改部署配置。
    // 要关掉：COMPILE_FRESHNESS_ENABLED=false
    enabled: process.env.COMPILE_FRESHNESS_ENABLED !== 'false',
    ttlSeconds:
      parseInt(process.env.COMPILE_FRESHNESS_TTL_SECONDS, 10) ||
      7 * 24 * 60 * 60,
  },

  // Maximum size of text documents in the real-time editing system.
  max_doc_length: 5 * 1024 * 1024, // 2mb upgrade to 5mb 

  primary_email_check_expiration: 1000 * 60 * 60 * 24 * 9000, // 90 days upgrade to 9000 days

  // Maximum JSON size in HTTP requests
  // We should be able to process twice the max doc length, to allow for
  //   - the doc content
  //   - text ranges spanning the whole doc
  //
  // There's also overhead required for the JSON encoding and the UTF-8 encoding,
  // theoretically up to 3 times the max doc length. On the other hand, we don't
  // want to block the event loop with JSON parsing, so we try to find a
  // practical compromise.
  max_json_request_size:
    parseInt(process.env.MAX_JSON_REQUEST_SIZE) || 6 * 1024 * 1024, // 6 MB

  // Internal configs
  // ----------------
  path: {
    // If we ever need to write something to disk (e.g. incoming requests
    // that need processing but may be too big for memory, then write
    // them to disk here).
    dumpFolder: Path.resolve(__dirname, '../data/dumpFolder'),
    uploadFolder: Path.resolve(__dirname, '../data/uploads'),
    // Git cache directory for storing cloned repositories
    gitCacheDir: process.env.GIT_CACHE_DIR || Path.resolve(__dirname, '../data/git-cache'),
    // FIXED: 2026-10-23 AI Agent 读取编译产物（output.log/output.pdf/aux 等）需要该路径。
    // OLD: 只有 CLSI 的 settings 里有 path.compilesDir，web 侧没有；
    //      导致 ai-agent 的 getCompileDir() 直接抛 "Settings.path.compilesDir is not configured"，
    //      AI 只能回复「无法访问文件列表 / 无法读取编译日志」。
    compilesDir:
      process.env.CLSI_COMPILES_PATH ||
      process.env.COMPILES_DIR ||
      Path.resolve(__dirname, '../../clsi/compiles'),
  },

  // Automatic Snapshots
  // -------------------
  automaticSnapshots: {
    // How long should we wait after the user last edited to
    // take a snapshot?
    waitTimeAfterLastEdit: 5 * minutes,
    // Even if edits are still taking place, this is maximum
    // time to wait before taking another snapshot.
    maxTimeBetweenSnapshots: 30 * minutes,
  },

  // Smoke test
  // ----------
  // Provide log in credentials and a project to be able to run
  // some basic smoke tests to check the core functionality.
  //
  smokeTest: {
    user: process.env.SMOKE_TEST_USER,
    userId: process.env.SMOKE_TEST_USER_ID,
    password: process.env.SMOKE_TEST_PASSWORD,
    projectId: process.env.SMOKE_TEST_PROJECT_ID,
    rateLimitSubject: process.env.SMOKE_TEST_RATE_LIMIT_SUBJECT || '127.0.0.1',
    stepTimeout: parseInt(process.env.SMOKE_TEST_STEP_TIMEOUT || '10000', 10),
  },

  appName: process.env.APP_NAME || 'FlyLaTeX (Fork from Overleaf Community Edition)',

  // FIXED: 2026-11-24 关于弹窗（编辑器 Help/About）的版权持有方不再写死。
  // 中国大陆站是公司主体，海外站是产品名 —— 但组件里**不要**判断部署档位，
  // 只读这个值（与 loginProviders 同一套思路：默认值按档位给，业务代码只读数据）。
  // 年份由前端取当前年，这里只管「谁」。
  copyrightHolder:
    process.env.COPYRIGHT_HOLDER ||
    (INTERNAL.misc && INTERNAL.misc.copyrightHolder) ||
    'FlyLaTeX',

  // FIXED: 2026-11-19 对外联系邮箱收口到 internal-values（开源版会是 admin@example.com）
  adminEmail: process.env.ADMIN_EMAIL || INTERNAL.misc.adminEmail,
  adminDomains: process.env.ADMIN_DOMAINS
    ? JSON.parse(process.env.ADMIN_DOMAINS)
    : undefined,

  nav: {
    title: process.env.APP_NAME || 'FlyLaTeX Edition',

    hide_powered_by: process.env.NAV_HIDE_POWERED_BY === 'true',
    left_footer: [],

    right_footer: [
      {
        text: "<i class='fa fa-github-square'></i> Fork on Gitee!",
        // FIXED: 2026-11-19 对外仓库链接收口到 internal-values
        url: INTERNAL.misc.helpRepoUrl,
      },
    ],

    showSubscriptionLink: false,

    header_extras: [],

    // FIXED: 2026-11-22 顶部导航的「站点功能菜单」（改造前是 navbar-marketing.pug
    // 里写死的 白板 / 论文模板 / TikZ 模板 三项）。
    //
    // 数据放 MongoDB（sharelatex.nav_menus，文档 _id=portal），由运营后台
    // carsi-mgr 的「导航菜单」页维护 —— 加临时入口不用发版。读取/容错细节见
    // app/src/Features/Navigation/PortalMenu.js。
    //   enabled=false          → 完全不读库，只用代码内置的三项（回滚开关）
    //   ttlMs                  → 进程内缓存时长（多实例靠它收敛）
    // 文档不存在时仍用内置三项；文档存在且 items=[] 表示「一个都不显示」。
    portalMenu: {
      enabled: (process.env.NAV_PORTAL_MENU_ENABLED || 'true') !== 'false',
      collection: process.env.NAV_PORTAL_MENU_COLLECTION || 'nav_menus',
      docId: process.env.NAV_PORTAL_MENU_DOC_ID || 'portal',
      ttlMs: parseInt(process.env.NAV_PORTAL_MENU_TTL_MS || '60000', 10),
    },
  },
  // Example:
  //   header_extras: [{text: "Some Page", url: "http://example.com/some/page", class: "subdued"}]

  recaptcha: {
    endpoint:
      process.env.RECAPTCHA_ENDPOINT ||
      'https://www.google.com/recaptcha/api/siteverify',
    disabled: {
      invite: true,
      login: true,
      passwordReset: true,
      register: true,
      addEmail: true,
    },
  },

  customisation: {},

  redirects: {
    '/templates/index': '/templates/',
  },

  reloadModuleViewsOnEachRequest: process.env.NODE_ENV === 'development',

  rateLimit: {
    autoCompile: {
      everyone: process.env.RATE_LIMIT_AUTO_COMPILE_EVERYONE || 100,
      standard: process.env.RATE_LIMIT_AUTO_COMPILE_STANDARD || 25,
    },
  },

  analytics: {
    enabled: false,
  },

  compileBodySizeLimitMb: process.env.COMPILE_BODY_SIZE_LIMIT_MB || 7,

  textExtensions: defaultTextExtensions.concat(
    parseTextExtensions(process.env.ADDITIONAL_TEXT_EXTENSIONS)
  ),

  // case-insensitive file names that is editable (doc) in the editor
  editableFilenames: ['latexmkrc', '.latexmkrc', 'makefile', 'gnumakefile'],

  fileIgnorePattern:
    process.env.FILE_IGNORE_PATTERN ||
    '**/{{__MACOSX,.git,.texpadtmp,.R}{,/**},.!(latexmkrc),*.{dvi,aux,log,toc,out,pdfsync,synctex,synctex(busy),fdb_latexmk,fls,nlo,ind,glo,gls,glg,bbl,blg,doc,docx,gz,swp}}',

  validRootDocExtensions: ['tex', 'Rtex', 'ltx', 'Rnw'],

  emailConfirmationDisabled:
    process.env.EMAIL_CONFIRMATION_DISABLED === 'true' || false,

  // FIXED: 2026-11-12 设置页「修改密码」默认下线，由该开关控制（默认关闭）。
  // 本站注册登录走 Google / 统一认证，邮件通道未开通，改密与重置邮件发不出去，
  // 留着入口只会让人点了没反应。代码没删，置 PASSWORD_CHANGE_ENABLED=1 即恢复。
  passwordChangeEnabled: envFlag('PASSWORD_CHANGE_ENABLED', false),

  emailAddressLimit: intFromEnv('EMAIL_ADDRESS_LIMIT', 10),

  enabledServices: (process.env.ENABLED_SERVICES || 'web,api')
    .split(',')
    .map(s => s.trim()),

  // module options
  // ----------
  modules: {
    sanitize: {
      options: {
        allowedTags: [
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'blockquote',
          'p',
          'a',
          'ul',
          'ol',
          'nl',
          'li',
          'b',
          'i',
          'strong',
          'em',
          'strike',
          'code',
          'hr',
          'br',
          'div',
          'table',
          'thead',
          'col',
          'caption',
          'tbody',
          'tr',
          'th',
          'td',
          'tfoot',
          'pre',
          'iframe',
          'img',
          'figure',
          'figcaption',
          'span',
          'source',
          'video',
          'del',
        ],
        allowedAttributes: {
          a: [
            'href',
            'name',
            'target',
            'class',
            'event-tracking',
            'event-tracking-ga',
            'event-tracking-label',
            'event-tracking-trigger',
          ],
          div: ['class', 'id', 'style'],
          h1: ['class', 'id'],
          h2: ['class', 'id'],
          h3: ['class', 'id'],
          h4: ['class', 'id'],
          h5: ['class', 'id'],
          h6: ['class', 'id'],
          col: ['width'],
          figure: ['class', 'id', 'style'],
          figcaption: ['class', 'id', 'style'],
          i: ['aria-hidden', 'aria-label', 'class', 'id'],
          iframe: [
            'allowfullscreen',
            'frameborder',
            'height',
            'src',
            'style',
            'width',
          ],
          img: ['alt', 'class', 'src', 'style'],
          source: ['src', 'type'],
          span: ['class', 'id', 'style'],
          strong: ['style'],
          table: ['border', 'class', 'id', 'style'],
          td: ['colspan', 'rowspan', 'headers', 'style'],
          th: [
            'abbr',
            'headers',
            'colspan',
            'rowspan',
            'scope',
            'sorted',
            'style',
          ],
          tr: ['class'],
          video: ['alt', 'class', 'controls', 'height', 'width'],
        },
      },
    },
  },

  overleafModuleImports: {
    // modules to import (an empty array for each set of modules)
    createFileModes: [],
    gitBridge: [],
    publishModal: [],
    tprFileViewInfo: [],
    tprFileViewRefreshError: [],
    tprFileViewRefreshButton: [],
    tprFileViewNotOriginalImporter: [],
    contactUsModal: [],
    editorToolbarButtons: [],
    sourceEditorExtensions: [],
    sourceEditorComponents: [],
    sourceEditorCompletionSources: [],
    sourceEditorSymbolPalette: [],
    integrationLinkingWidgets: [],
    referenceLinkingWidgets: [],
    importProjectFromGithubModalWrapper: [],
    importProjectFromGithubMenu: [],
    editorLeftMenuSync: [],
    editorLeftMenuManageTemplate: [],
    oauth2Server: [],
    managedGroupSubscriptionEnrollmentNotification: [],
    managedGroupEnrollmentInvite: [],
    ssoConfigurationModal: [],
    entryPointsIde,
    entryPointsMain,
  },

  moduleImportSequence: [
    'history-v1',
    'launchpad',
    'server-ce-scripts',
    'user-activate',
    // FIXED: 2026-11-13 审阅面板（行内批注）：加载即挂载 /project/:id/threads 等路由，
    // 并置 ProjectEditorHandler.trackChangesAvailable = true（工具栏的面板入口）。
    'review-panel',
  ],

  csp: {
    enabled: process.env.CSP_ENABLED === 'true',
    reportOnly: process.env.CSP_REPORT_ONLY === 'true',
    reportPercentage: parseFloat(process.env.CSP_REPORT_PERCENTAGE) || 0,
    reportUri: process.env.CSP_REPORT_URI,
    exclude: ['app/views/project/editor'],
  },

  unsupportedBrowsers: {
    ie: '<=11',
  },

  // ID of the IEEE brand in the rails app
  ieeeBrandId: intFromEnv('IEEE_BRAND_ID', 15),

  managedUsers: {
    enabled: false,
  },

  // FIXED: 2026-10-11 用户中心认证 V2 配置（实现见 commercial/ne-auth-v2/）
  // 说明：用户中心已停用 V1 密码登录（返回 client_upgrade_required），
  //       authV2 设为 false 仅为紧急回退用，不能长期依赖。
  ne: {
    authV2: process.env.NE_AUTH_V2 !== 'false',
    // FIXED: 2026-11-18 内部值统一收口到 config/internal-values.js（开源前可整体移出仓库）
    baseUrl: process.env.NE_BASE || INTERNAL.ne.baseUrl,
    clientId: process.env.NE_CLIENT_ID || INTERNAL.ne.clientId,
    clientSecret: process.env.NE_CLIENT_SECRET || INTERNAL.ne.clientSecret,
    // CARSI/授权码回调：必须与在用户中心登记的 redirect 逐字符一致。
    redirectUri: process.env.NE_REDIRECT_URI || INTERNAL.ne.redirectUri,
  },

  // FIXED: 2026-11-16 Zotero 集成（文献源，不是文件同步）。实现：app/src/Features/Zotero/
  //
  // 凭据与 NE 那套一样**直接给默认值**（env 可覆盖），部署时不需要额外配置：
  //   - clientKey / clientSecret：在 Zotero 申请的应用凭据（Application Type: Browser）
  //   - callbackUrl：必须与 Zotero 侧登记的回调逐字符一致
  // 改 env 需要重启进程；默认值直接改这里即可（改完重跑 webpack 不需要，只重启服务）。
  zotero: {
    apiUrl: process.env.ZOTERO_API_URL || INTERNAL.zotero.apiUrl,
    timeoutMs: Number(process.env.ZOTERO_TIMEOUT_MS) || 12000,
    maxBibtexItems: Number(process.env.ZOTERO_MAX_BIBTEX_ITEMS) || 20,
    oauth: {
      clientKey:
        process.env.ZOTERO_OAUTH_CLIENT_KEY || INTERNAL.zotero.oauthClientKey,
      clientSecret:
        process.env.ZOTERO_OAUTH_CLIENT_SECRET ||
        INTERNAL.zotero.oauthClientSecret,
      callbackUrl:
        process.env.ZOTERO_OAUTH_CALLBACK_URL ||
        INTERNAL.zotero.oauthCallbackUrl,
    },
  },

  // =========================================================================
  // FIXED: 2026-11-12 部署档位（见文件顶部的说明）
  // =========================================================================
  deployment: {
    profile: DEPLOYMENT_PROFILE,
    isGlobal: IS_GLOBAL_PROFILE,
    region: process.env.DEPLOYMENT_REGION || (IS_GLOBAL_PROFILE ? 'SG' : 'CN'),
  },

  // =========================================================================
  // FIXED: 2026-11-12 登录提供方注册表（登录页按此渲染，不再硬编码）
  //
  // 背景：`app/views/user/login.pug` 原来把 NE 密码 / 短信 / CARSI 三块写死，
  //       海外站要换成 Google 登录就必须改这个 pug —— 而 pug 是产品升级的
  //       高频改动点，一旦分叉，以后每次 merge 都会冲突。
  // 方案：pug 只负责「遍历并渲染」，能力有无由这里的数据决定。
  //       `kind` 对应 `Features/IdentityProviders/` 里的适配器。
  // =========================================================================
  loginProviders: {
    google: {
      kind: 'google',
      // 需要 clientId 才算真正可用；缺 clientId 时 registry 会自动跳过，
      // 避免登录页渲染出一个点了就 500 的按钮。
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      enabled: envFlag('LOGIN_GOOGLE', IS_GLOBAL_PROFILE),
      order: 5,
    },
    password: {
      kind: 'ne-password',
      // 海外站默认关闭：需求是「ne/carsi 登录在海外完全不需要」。
      // 迁移期需要临时放开时用 `LOGIN_PASSWORD=1`。
      enabled: envFlag('LOGIN_PASSWORD', !IS_GLOBAL_PROFILE),
      order: 10,
    },
    sms: {
      kind: 'ne-sms',
      enabled: envFlag('LOGIN_SMS', !IS_GLOBAL_PROFILE),
      order: 20,
    },
    carsi: {
      kind: 'carsi',
      // 海外站不需要高校用户；但机构能力（carsi-mgr / institutions 集合）
      // 原样保留，恢复只需把这一个开关打开。
      enabled: envFlag('LOGIN_CARSI', !IS_GLOBAL_PROFILE),
      order: 30,
    },
  },

  // =========================================================================
  // FIXED: 2026-11-20 FlyLaTeX SSO（生态统一身份）
  //
  // 设计：docs/sso-provider-design.md    实现：app/src/Features/Sso/
  //
  // 生态里的模板系统 / 运营系统 / 白板 / TikZ 库 / 桌面端 / MCP 只对接这里一次，
  // 不各自去接 NE account（master 站）或 Google account（sg 站）。
  // 身份锚点永远是本地 `User._id`，换上游 IdP 不会让下游的 `sub` 变。
  //
  // `clients` 为**空**时：`/sso/authorize|token|userinfo` 统一 404，
  // 且不连接 Redis —— 这就是开源版的形态，不需要删代码或写 holder stub。
  // `/sso/session`（同源 T0）不受影响，始终可用。
  //
  // SSO_CLIENTS 示例（数组或 {"clients":[...]} 都接受）：
  //   [{"client_id":"word2latex",
  //     "client_secret":"<随机长串>",
  //     "name":"Word 转 LaTeX",
  //     "redirect_uris":["http://localhost:3100/word2latex/api/auth/sso/callback"],
  //     "scopes":["openid","profile","email"],
  //     "trusted":true,
  //     "allow_loopback":false}]
  //
  // trusted=true 才会跳过同意页；M2 只支持 trusted 客户端，非 trusted 直接
  // 返回 access_denied（同意页 + 授权记录属 M3）。
  // =========================================================================
  sso: {
    // FIXED: 2026-11-22 客户端注册表收口到 internal-values（与 ne / zotero 一致）。
    // 私有点：`config/internal-values.js`；开源版被 example 覆盖成空数组，
    // 于是三条 T2 端点统一 404。环境变量 SSO_CLIENTS 永远优先（兼容容器化部署）。
    clients: process.env.SSO_CLIENTS || INTERNAL.sso?.clients || [],
    // 'redis'（默认）| 'memory'。memory 只适合单进程联调，重启即丢 code/token。
    store: (process.env.SSO_STORE || INTERNAL.sso?.store || 'redis')
      .trim()
      .toLowerCase(),
  },

  // =========================================================================
  // FIXED: 2026-11-12 计费配置
  //
  // 资金一律用整数「微单位」(1 微 = 1e-6 个货币单位) 记账，避免浮点误差：
  //   1 SGD = 1_000_000 micro
  // 单次 LLM 调用可能只值几十微（便宜模型 + 少量 token），用「分」会丢精度。
  // =========================================================================
  billing: {
    enabled: envFlag('BILLING_ENABLED', IS_GLOBAL_PROFILE),
    provider: (
      process.env.BILLING_PROVIDER || 'none'
    )
      .trim()
      .toLowerCase(),
    currency: process.env.BILLING_CURRENCY || (IS_GLOBAL_PROFILE ? 'SGD' : 'CNY'),
    // 新注册赠送额度（微单位）。0 = 不赠送，但赠送能力本身仍可用。
    // 新注册赠送额度（微单位）。
    // 100.00 个货币单位 = 100_000_000 微。
    // 与支付渠道解耦：赠送是账本操作，`billing.enabled` 只决定「要不要拦截额度」。
    // 社区版默认 0（不赠送）。赠送多少是运营决策，不是技术默认值。
    signupGrantMicros: envNumber('BILLING_SIGNUP_GRANT_MICROS', 0),
    // 充值页外链（支付渠道自己的收银台）。留空 = 设置页「充值」按钮为禁用态，
    // 只提示「开通中」，避免把用户送进一个还不存在的页面。
    topupUrl: process.env.BILLING_TOPUP_URL || null,
    // 是否写账本（赠送 / 扣费）。缺省跟随 enabled。
    // 典型用法：先把 ledgerEnabled 打开只看账，确认数字对了再开 enabled 真拦截。
    ledgerEnabled: envFlag('BILLING_LEDGER_ENABLED', IS_GLOBAL_PROFILE),
  },

  // =========================================================================
  // FIXED: 2026-11-12 LLM 上游配置（按「协议」而不是「厂商」绑定）
  //
  // 需求原文：「不要绑定具体，可以绑定 chat completions 和 response 协议」。
  // 因此这里描述的是**协议的接线方式**，换供应商只改 env：
  //   LLM_PROTOCOL=chat_completions  → POST {baseUrl}/chat/completions
  //   LLM_PROTOCOL=responses         → POST {baseUrl}/responses
  // 具体价格表在 Features/Billing/pricing.js，可用 Settings.llm.pricing 覆盖。
  // =========================================================================
  llm: {
    protocol: (process.env.LLM_PROTOCOL || 'chat_completions')
      .trim()
      .toLowerCase(),
    baseUrl: (
      process.env.LLM_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      // FIXED: 2026-11-19 默认上游收口到 internal-values（开源版是通用示例地址）
      INTERNAL.llm.baseUrl
    ).replace(/\/+$/, ''),
    // FIXED: 2026-11-26 apiKey / defaultModel 也可以只在 internal-values 里给：
    // 海外站默认上游是 DeepSeek 官方服务（测试 Key 在 internal-values，
    // 开源版为空串）。环境变量仍然优先，方便不改镜像换 Key / 换模型。
    apiKey:
      process.env.LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      (INTERNAL.llm && INTERNAL.llm.apiKey) ||
      '',
    defaultModel:
      process.env.LLM_DEFAULT_MODEL ||
      process.env.OPENAI_MODEL ||
      (INTERNAL.llm && INTERNAL.llm.defaultModel) ||
      '',
    // 服务端转发时允许的模型白名单（空 = 不限制，仅用于兜底防护）
    allowedModels: (process.env.LLM_ALLOWED_MODELS || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
    timeoutMs: envNumber('LLM_TIMEOUT_MS', 600000),
  },
}

module.exports.mergeWith = function (overrides) {
  return merge(overrides, module.exports)
}
