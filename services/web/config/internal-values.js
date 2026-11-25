/**
 * 内部/私有默认值的**占位模板**（开源发布用）
 *
 * 用法：
 *   - 开源发布：用本文件的内容整体覆盖 `internal-values.js`（空值 + 注释）；
 *   - 私有部署：把需要的值填进 `internal-values.js`，或用环境变量覆盖（优先级更高）；
 *   - **不要在本文件里填真实值**：它会随仓库公开。
 *
 * 注意：
 *   - `internal-values.js` 必须始终存在（调用方是硬 require），不能删除；
 *   - 只放纯数据，不要写逻辑；
 *   - 新增字段时，两个文件都要加（这里写占位 + 说明）。
 *   - 密钥类字段留空字符串，不要写 `replace-me` 之类的非空假值：
 *     那种值会被当成真值发给上游，报错看起来像对方服务坏了。
 */

module.exports = {
  // 用户中心（NE）认证 V2
  // 环境变量：NE_BASE / NE_CLIENT_ID / NE_CLIENT_SECRET / NE_REDIRECT_URI
  ne: {
    baseUrl: 'https://uc.example.com',
    clientId: '',
    clientSecret: '',
    redirectUri: 'https://www.example.com/ne-auth-callback',
    // 运营排查用的特殊账号白名单；开源版留空
    specialUsers: [],
  },

  // FlyLaTeX SSO（生态统一身份）
  // 环境变量：SSO_CLIENTS（JSON 字符串，优先级更高）/ SSO_STORE
  // 开源版留空数组 → `/sso/authorize|token|userinfo` 统一 404，不连 Redis；
  // `/sso/session`（同源前端用）始终可用。
  sso: {
    store: 'redis', // 'redis' | 'memory'（memory 仅单进程联调，重启即丢 code/token）
    clients: [
      // {
      //   clientId: 'word2latex',
      //   clientSecret: '',            // 留空 = public client，强制 PKCE
      //   name: 'Word 转 LaTeX',
      //   redirectUris: ['https://www.example.com/api/auth/sso/callback'],
      //   scopes: ['openid', 'profile', 'email'],
      //   trusted: true,               // 跳过同意页；开源版建议 false
      //   allowLoopback: false,        // 桌面端本地回调才开
      // },
    ],
  },

  // LLM 网关（服务端 Key 直连用）
  // 环境变量：AI_GATEWAY_BASE_URL / AI_GATEWAY_SOURCE / OPENAI_API_KEY
  ai: {
    gatewayBaseUrl: 'https://gateway.example.com/v1',
    gatewaySource: '',
    serviceApiKey: '',
  },

  // Zotero 集成（Application Type: Browser）
  // 环境变量：ZOTERO_API_URL / ZOTERO_OAUTH_CLIENT_KEY / ZOTERO_OAUTH_CLIENT_SECRET
  zotero: {
    apiUrl: 'https://api.zotero.org',
    oauthClientKey: '',
    oauthClientSecret: '',
    oauthCallbackUrl: 'https://www.example.com/api/zotero/oauth/callback',
  },

  // AMiner 开放平台（只有基础地址；用户 key 存在 user.ace.aminerApiKey）
  // 环境变量：AMINER_API_URL
  aminer: {
    apiUrl: 'https://datacenter.aminer.cn',
  },

  // 文献检索用的 NE 服务端主机（crosrefsearch）；开源版不要指向内部服务
  crossref: {
    hubHost: 'hub.example.com',
    personalHost: 'personal.example.com',
  },

  // LLM 上游（非网关；Settings.llm 用）
  // 环境变量：LLM_BASE_URL / LLM_API_KEY / LLM_DEFAULT_MODEL（有则覆盖这里）
  // 开源版故意留空 apiKey：没有 Key 时 AI 功能不可用，但站点照常启动。
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    defaultModel: '',
  },

  // 站点自身地址（页面模板 / 语言 cookie 域 / 白板）
  // 环境变量：PUBLIC_URL / COOKIE_DOMAIN / WHITEBOARD_URL
  site: {
    url: 'http://localhost:3000',
    // 留空表示不在 cookie 上写 Domain（本地/单域部署）
    cookieDomain: '',
    whiteboardUrl: '',
  },

  // 其它第三方/文档地址、对外联系邮箱
  misc: {
    haveIBeenPwnedUrl: 'https://api.pwnedpasswords.com',
    wikiUrl: '',
    // 环境变量：ADMIN_EMAIL
    adminEmail: 'admin@example.com',
    contactEmail: 'support@example.com',
    contactUsUrl: 'https://example.com/contact',
    helpRepoUrl: 'https://github.com/example/flylatex',
  },

  // 邮件发送（内部版：外部 HTTP 服务，如 Brevo；开源版留空即可）
  // 环境变量：EMAIL_TRANSPORT / EMAIL_PROVIDER / EMAIL_GATEWAY_URL /
  //   EMAIL_GATEWAY_TOKEN / EMAIL_SENDER_NAME / EMAIL_SENDER_EMAIL
  email: {
    transport: '', // 'http' 时启用下面的配置；留空则走原有 SMTP/SES/日志逻辑
    provider: '', // 'brevo' 或留空（generic：Bearer + 自定义报文）
    gatewayUrl: '',
    gatewayToken: '',
    senderName: '',
    senderEmail: '',
  },
}
