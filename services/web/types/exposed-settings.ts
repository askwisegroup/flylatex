type TemplateLink = {
  name: string
  url: string
  trackingKey: string
}

export type ExposedSettings = {
  adminEmail: string
  // 部署档位：cn（NE 网关）/ sg|global|overseas（OpenAI 兼容上游）。
  // 前端只用于文案与默认行为，不得据此做权限/功能开关（那是后端的事）。
  deployment?: {
    profile: string
    isGlobal: boolean
    region: string | null
  }
  billing?: {
    enabled: boolean
    ledgerEnabled: boolean
    currency: string
    topupUrl: string | null
    // 站内收银台是否可用（支付渠道已配置）。为 false 时前端把按钮置灰。
    topupAvailable?: boolean
  }
  appName: string
  cookieDomain: string
  dropboxAppName: string
  emailConfirmationDisabled: boolean
  enableSubscriptions: boolean
  gaToken?: string
  gaTokenV4?: string
  hasAffiliationsFeature: boolean
  hasLinkUrlFeature: boolean
  hasLinkedProjectFileFeature: boolean
  hasLinkedProjectOutputFileFeature: boolean
  hasSamlBeta?: boolean
  hasSamlFeature: boolean
  isOverleaf: boolean
  maxEntitiesPerProject: number
  projectUploadTimeout: number
  maxUploadSize: number
  passwordChangeEnabled?: boolean
  recaptchaDisabled: {
    invite: boolean
    login: boolean
    passwordReset: boolean
    register: boolean
    addEmail: boolean
  }
  recaptchaSiteKeyV3?: string
  recaptchaSiteKey?: string
  samlInitPath?: string
  sentryAllowedOriginRegex: string
  sentryDsn?: string
  sentryEnvironment?: string
  sentryRelease?: string
  siteUrl: string
  // 关于弹窗版权行的持有方（默认值按部署档位给，见 config/settings.defaults.js）
  copyrightHolder?: string
  textExtensions: string[]
  editableFilenames: string[]
  validRootDocExtensions: string[]
  templateLinks?: TemplateLink[]
  labsEnabled: boolean
}
