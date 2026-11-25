const Settings = require('@overleaf/settings')
const mongoose = require('../infrastructure/Mongoose')
const TokenGenerator = require('../Features/TokenGenerator/TokenGenerator')
const { Schema } = mongoose
const { ObjectId } = Schema

// See https://stackoverflow.com/questions/386294/what-is-the-maximum-length-of-a-valid-email-address/574698#574698
const MAX_EMAIL_LENGTH = 254

const UserSchema = new Schema(
  {
    carsiEmail: { type: String, default: '', maxlength: MAX_EMAIL_LENGTH },
    email: { type: String, default: '', maxlength: MAX_EMAIL_LENGTH },
    account_id: { type: String, default: '' },
    // FIXED: 2026-11-12 Google 登录绑定（海外站主登录方式）
    //
    // `googleSub` 是 Google ID Token 里的 `sub`：它在同一个 Client ID 下
    // **永久不变**，即使 Gmail 账号改邮箱也不变。用它做主键比用 email 稳。
    //
    // 不建索引：这个集合已有多个索引，且按 sub 查询只在登录时发生一次；
    // 待海外用户量起来后再补唯一部分索引（见 docs/sg-deployment-notes.md）。
    googleSub: { type: String, default: '' },
    googleEmail: { type: String, default: '' },
    googleLinkedAt: { type: Date },
    // FIXED: 2026-05-15 添加VIP相关字段
    vipEndDate: { type: Date }, // VIP到期时间
    vipExpired: { type: Boolean, default: false }, // VIP是否已过期
    emails: [
      {
        email: { type: String, default: '', maxlength: MAX_EMAIL_LENGTH },
        reversedHostname: { type: String, default: '' },
        createdAt: {
          type: Date,
          default() {
            return new Date()
          },
        },
        confirmedAt: { type: Date },
        samlProviderId: { type: String },
        affiliationUnchecked: { type: Boolean },
        reconfirmedAt: { type: Date },
      },
    ],
    first_name: { type: String, default: '' },
    last_name: { type: String, default: '' },
    role: { type: String, default: '' },
    institution: { type: String, default: '' },
    // FIXED: 2026-10-23 机构来源标记，避免自动同步覆盖人工修正
    // ''      = 未标注（历史数据）
    // 'ne'    = 统一认证自动同步
    // 'manual'= 人工确认，登录不再覆盖
    institutionSource: { type: String, default: '' },
    institutionUpdatedAt: { type: Date },
    // FIXED: 2026-10-23 是否在 Mongo institutions 集合（已开通机构名单）中；缺省=未校验
    institutionVerified: { type: Boolean },
    hashedPassword: String,
    enrollment: {
      sso: [
        {
          groupId: {
            type: ObjectId,
            ref: 'Subscription',
          },
          linkedAt: Date,
          primary: { type: Boolean, default: false },
        },
      ],
      managedBy: {
        type: ObjectId,
        ref: 'Subscription',
      },
      enrolledAt: { type: Date },
    },
    isAdmin: { type: Boolean, default: false },
    staffAccess: {
      publisherMetrics: { type: Boolean, default: false },
      publisherManagement: { type: Boolean, default: false },
      institutionMetrics: { type: Boolean, default: false },
      institutionManagement: { type: Boolean, default: false },
      groupMetrics: { type: Boolean, default: false },
      groupManagement: { type: Boolean, default: false },
      adminMetrics: { type: Boolean, default: false },
      splitTestMetrics: { type: Boolean, default: false },
      splitTestManagement: { type: Boolean, default: false },
    },
    signUpDate: {
      type: Date,
      default() {
        return new Date()
      },
    },
    loginEpoch: { type: Number },
    lastActive: { type: Date },
    lastFailedLogin: { type: Date },
    lastLoggedIn: { type: Date },
    lastLoginIp: { type: String, default: '' },
    lastPrimaryEmailCheck: { type: Date },
    loginCount: { type: Number, default: 0 },
    holdingAccount: { type: Boolean, default: false },
    ace: {
      mode: { type: String, default: 'none' },
      theme: { type: String, default: 'textmate' },
      overallTheme: { type: String, default: '' },
      fontSize: { type: Number, default: '12' },
      autoComplete: { type: Boolean, default: true },
      autoPairDelimiters: { type: Boolean, default: true },
      spellCheckLanguage: { type: String, default: 'en' },
      pdfViewer: { type: String, default: 'pdfjs' },
      syntaxValidation: { type: Boolean },
      fontFamily: { type: String },
      lineHeight: { type: String },
      // FIXED: 2026-10-30 AI 面板展示位置：'side'（右侧，现状）| 'bottom'（底部停靠）
      aiPanelLayout: { type: String, default: 'side' },
      // FIXED: 2026-11-13 用户是否**显式**选过 AI 面板位置。
      // 用途：启用批注后默认把 AI 面板设为弹窗（modal），但不能覆盖
      // 用户自己选过的值 —— 而有默认值的字段无法区分「没选过」和
      // 「选的就是 side」，所以单独记一个布尔。
      aiPanelLayoutExplicit: { type: Boolean, default: false },
      // FIXED: 2026-11-01 设置的显示方式：'modal'（居中弹窗，默认）| 'left'（左侧面板展开）
      settingsPanelMode: { type: String, default: 'modal' },
      // FIXED: 2026-11-01 搜索/替换面板的位置：'bottom'（编辑器底部，默认，现状）| 'top'（顶部）
      searchPanelPosition: { type: String, default: 'bottom' },
      // FIXED: 2026-11-02 自动探测编译器：编译失败时读日志判断该用 XeLaTeX / LuaLaTeX，
      // 命中就把项目的编译器切过去并重编译一次。默认关闭（保持现状）。
      // FIXED: 2026-11 默认开启。
      // 用户反馈「自动探测编译器毫无作用」——排查后发现默认是关的，
      // 而它只在「编译失败且日志明确说需要 XeTeX/LuaTeX」时才介入，
      // 本来就是安全的兜底动作，默认开着更符合「自动」二字的预期。
      autoDetectCompiler: { type: Boolean, default: true },
      // FIXED: 2026-11-06 导航栏是否显示项目/文章标题。默认 false（保持现状）
      navbarShowTitle: { type: Boolean, default: false },
      // FIXED: 2026-11-08 AI 助手默认 LLM 模型（设置 → AI 助手 → 默认 LLM 模型）。
      // 空串 = 跟随系统默认（环境变量 OPENAI_MODEL，其次网关清单里挑一个）。
      // 存的是网关模型 id，真实可用性由网关 /models 判断，用户选错只会回落一次。
      aiModel: { type: String, default: '' },
      // FIXED: 2026-11-01 AI 工具「互联网论文检索」的 AMiner token（设置 → AI 助手 → AMiner 搜索）。
      // 空串 = 未启用：工具不会下发给模型（不浪费 token，也不会报错）。
      // 只在服务端读写，**从不回传给浏览器明文**，设置页只拿到是否已配置 + 掩码。
      aminerApiKey: { type: String, default: '' },
      // FIXED: 2026-11 「Agent 耐心程度」（设置 → AI 助手 → Agent 耐心程度）。
      // 'strict' | 'standard' | 'patient'，默认 standard，等价于原来写死的
      // 50 步 / 2 次编译 / 10 分钟。服务端按档位 clamp，上限见 ai-agent.js 的
      // AGENT_EFFORT_LIMITS（这里只存档位名，不存数字 —— 免得改了规则还要迁数据）。
      aiAgentEffort: { type: String, default: 'standard' },
      // FIXED: 2026-11-13 用户自己配置的远程 MCP 服务（设置 → AI 助手 → MCP 服务）。
      // FIXED: 2026-11-18 列表不限数量（可导入任意多，软保护 500 条），
      // 但「同时启用」最多 10 个（见 mcp-routes.js 的 MAX_ENABLED_SERVERS）；
      // 每项形如
      //   { id, name, url, headers, enabled, lastStatus, lastCheckedAt }
      // headers 里通常是用户自己的第三方 key，所以**从不回传明文**，
      // 设置页只拿到掩码（见 mcp-routes.js 的 publicView）。
      // 工具清单本身不存库：5 分钟内存缓存，见 mcp-tools.js。
      mcpServers: {
        type: [
          {
            id: String,
            name: String,
            url: String,
            headers: Object,
            enabled: Boolean,
            lastStatus: String,
            lastCheckedAt: Date,
          },
        ],
        default: [],
      },
    },
    features: {
      collaborators: {
        type: Number,
        default: Settings.defaultFeatures.collaborators,
      },
      versioning: {
        type: Boolean,
        default: Settings.defaultFeatures.versioning,
      },
      dropbox: { type: Boolean, default: Settings.defaultFeatures.dropbox },
      github: { type: Boolean, default: Settings.defaultFeatures.github },
      gitBridge: { type: Boolean, default: Settings.defaultFeatures.gitBridge },
      compileTimeout: {
        type: Number,
        default: Settings.defaultFeatures.compileTimeout,
      },
      compileGroup: {
        type: String,
        default: Settings.defaultFeatures.compileGroup,
      },
      templates: { type: Boolean, default: Settings.defaultFeatures.templates },
      references: {
        type: Boolean,
        default: Settings.defaultFeatures.references,
      },
      trackChanges: {
        type: Boolean,
        default: Settings.defaultFeatures.trackChanges,
      },
      mendeley: { type: Boolean, default: Settings.defaultFeatures.mendeley },
      zotero: { type: Boolean, default: Settings.defaultFeatures.zotero },
      referencesSearch: {
        type: Boolean,
        default: Settings.defaultFeatures.referencesSearch,
      },
      symbolPalette: {
        type: Boolean,
        default: Settings.defaultFeatures.symbolPalette,
      },
    },
    featuresOverrides: [
      {
        createdAt: {
          type: Date,
          default() {
            return new Date()
          },
        },
        expiresAt: { type: Date },
        note: { type: String },
        features: {
          collaborators: { type: Number },
          versioning: { type: Boolean },
          dropbox: { type: Boolean },
          github: { type: Boolean },
          gitBridge: { type: Boolean },
          compileTimeout: { type: Number },
          compileGroup: { type: String },
          templates: { type: Boolean },
          trackChanges: { type: Boolean },
          mendeley: { type: Boolean },
          zotero: { type: Boolean },
          referencesSearch: { type: Boolean },
          symbolPalette: { type: Boolean },
        },
      },
    ],
    featuresUpdatedAt: { type: Date },
    featuresEpoch: {
      type: String,
    },
    // when auto-merged from SL and must-reconfirm is set, we may end up using
    // `sharelatexHashedPassword` to recover accounts...
    sharelatexHashedPassword: String,
    must_reconfirm: { type: Boolean, default: false },
    referal_id: {
      type: String,
      default() {
        return TokenGenerator.generateReferralId()
      },
    },
    refered_users: [{ type: ObjectId, ref: 'User' }],
    refered_user_count: { type: Number, default: 0 },
    refProviders: {
      // The actual values are managed by third-party-references.
      mendeley: Schema.Types.Mixed,
      zotero: Schema.Types.Mixed,
    },
    alphaProgram: { type: Boolean, default: false }, // experimental features
    betaProgram: { type: Boolean, default: false },
    labsProgram: { type: Boolean, default: false },
    overleaf: {
      id: { type: Number },
      accessToken: { type: String },
      refreshToken: { type: String },
    },
    awareOfV2: { type: Boolean, default: false },
    samlIdentifiers: { type: Array, default: [] },
    thirdPartyIdentifiers: { type: Array, default: [] },
    migratedAt: { type: Date },
    twoFactorAuthentication: {
      createdAt: { type: Date },
      enrolledAt: { type: Date },
      secretEncrypted: { type: String },
    },
    onboardingEmailSentAt: { type: Date },
    splitTests: Schema.Types.Mixed,
    analyticsId: { type: String },
    surveyResponses: Schema.Types.Mixed,
    completedTutorials: Schema.Types.Mixed,
  },
  { minimize: false }
)

function formatSplitTestsSchema(next) {
  if (this.splitTests) {
    for (const splitTestKey of Object.keys(this.splitTests)) {
      for (const variantIndex in this.splitTests[splitTestKey]) {
        this.splitTests[splitTestKey][variantIndex].assignedAt = new Date(
          this.splitTests[splitTestKey][variantIndex].assignedAt
        )
      }
    }
  }
  next()
}
UserSchema.pre('save', formatSplitTestsSchema)

exports.User = mongoose.model('User', UserSchema)
exports.UserSchema = UserSchema
