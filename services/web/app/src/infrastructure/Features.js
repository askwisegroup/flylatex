const _ = require('lodash')
const Settings = require('@overleaf/settings')

const publicRegistrationModuleAvailable =
  Settings.moduleImportSequence.includes('public-registration')

const supportModuleAvailable = Settings.moduleImportSequence.includes('support')

const symbolPaletteModuleAvailable =
  Settings.moduleImportSequence.includes('symbol-palette')

const trackChangesModuleAvailable =
  Settings.moduleImportSequence.includes('track-changes')
// FIXED: 2026-11-13 我们自己的审阅面板模块（评论 + 修订）
const reviewPanelModuleAvailable =
  Settings.moduleImportSequence.includes('review-panel')

/**
 * @typedef {Object} Settings
 * @property {Object | undefined}  apis
 * @property {Object | undefined}  apis.linkedUrlProxy
 * @property {string | undefined}  apis.linkedUrlProxy.url
 * @property {Object | undefined}  apis.references
 * @property {string | undefined}  apis.references.url
 * @property {boolean | undefined} enableGithubSync
 * @property {boolean | undefined} enableGitBridge
 * @property {boolean | undefined} enableHomepage
 * @property {boolean | undefined} enableSaml
 * @property {boolean | undefined} ldap
 * @property {boolean | undefined} oauth
 * @property {Object | undefined} overleaf
 * @property {Object | undefined} overleaf.oauth
 * @property {boolean | undefined} saml
 */

const Features = {
  /**
   * FIXED: 2026-11-12 当前部署档位（'cn' | 'sg' | ...）。
   *
   * ⚠️ 仅供**诊断与日志**使用。业务代码不要拿它做分支判断 —— 需要差异化时
   *    请用 hasFeature(...) 或 Settings.loginProviders / billing / llm 的开关，
   *    否则以后新增第三个档位（如 'eu'）时要满仓库找 `=== 'sg'`。
   *
   * @returns {string}
   */
  deploymentProfile() {
    return _.get(Settings, ['deployment', 'profile']) || 'cn'
  },

  /**
   * 某个登录提供方是否可用。
   *
   * enabled 为 true 但缺少必备凭据（如 Google 没有 clientId）时视为不可用 ——
   * 一个点了就报错的按钮比没有按钮更糟。
   *
   * @param {string} id
   * @returns {boolean}
   */
  loginProviderEnabled(id) {
    const provider = _.get(Settings, ['loginProviders', id])
    if (!provider || provider.enabled !== true) return false
    if (provider.kind === 'google') {
      return typeof provider.clientId === 'string' && provider.clientId !== ''
    }
    return true
  },

  /**
   * 登录页要渲染的提供方，按 order 升序。
   *
   * 最后有一道**防砖锁**：如果一个提供方都不剩（例如海外站忘了配
   * GOOGLE_CLIENT_ID，同时 NE 类登录都已关闭），就强制放开密码登录并打
   * 一条 error 日志。宁可多一个不该有的登录入口，也不能让整站无人可登。
   * 这类“配置遗漏导致全站不可登录”的故障，排障成本远高于多一个入口。
   *
   * @returns {Array<object>}
   */
  enabledLoginProviders() {
    const providers = _.get(Settings, ['loginProviders'], {})
    const enabled = Object.entries(providers)
      .filter(([id]) => Features.loginProviderEnabled(id))
      .map(([id, provider]) => ({ id, ...provider }))
      .sort((a, b) => (a.order || 0) - (b.order || 0))

    if (enabled.length === 0 && providers.password) {
      require('@overleaf/logger').error(
        { profile: Features.deploymentProfile() },
        '[features] 没有任何可用登录方式，已强制放开密码登录（请检查 loginProviders / GOOGLE_CLIENT_ID）'
      )
      enabled.push({ id: 'password', ...providers.password })
    }

    return enabled
  },

  /**
   * @returns {boolean}
   */
  externalAuthenticationSystemUsed() {
    return (
      (Boolean(Settings.ldap) && Boolean(Settings.ldap.enable)) ||
      (Boolean(Settings.saml) && Boolean(Settings.saml.enable)) ||
      Boolean(_.get(Settings, ['overleaf', 'oauth']))
    )
  },

  /**
   * Whether a feature is enabled in the appliation's configuration
   *
   * @param {string} feature
   * @returns {boolean}
   */
  hasFeature(feature) {
    switch (feature) {
      case 'saas':
        return Boolean(Settings.overleaf)
      case 'homepage':
        return Boolean(Settings.enableHomepage)
      case 'registration-page':
        return (
          !Features.externalAuthenticationSystemUsed() ||
          Boolean(Settings.overleaf)
        )
      case 'registration':
        return publicRegistrationModuleAvailable || Boolean(Settings.overleaf)
      case 'github-sync':
        return Boolean(Settings.enableGithubSync)
      case 'git-bridge':
        return Boolean(Settings.enableGitBridge)
      case 'oauth':
        return Boolean(Settings.oauth)
      case 'templates-server-pro':
        return Boolean(Settings.templates)
      case 'affiliations':
      case 'analytics':
        return Boolean(_.get(Settings, ['apis', 'v1', 'url']))
      case 'overleaf-integration':
        return Boolean(Settings.overleaf)
      case 'references':
        return Boolean(_.get(Settings, ['apis', 'references', 'url']))
      case 'saml':
        return Boolean(Settings.enableSaml)
      case 'linked-project-file':
        return Boolean(Settings.enabledLinkedFileTypes.includes('project_file'))
      case 'linked-project-output-file':
        return Boolean(
          Settings.enabledLinkedFileTypes.includes('project_output_file')
        )
      case 'link-url':
        return Boolean(
          _.get(Settings, ['apis', 'linkedUrlProxy', 'url']) &&
          Settings.enabledLinkedFileTypes.includes('url')
        )
      case 'public-registration':
        return publicRegistrationModuleAvailable
      case 'support':
        return supportModuleAvailable
      case 'symbol-palette':
        return symbolPaletteModuleAvailable
      case 'track-changes':
        // FIXED: 2026-11-13 我们自己的模块叫 review-panel（评论 + 修订），
        // 修订后端（/track_changes 与 /doc/:id/changes/accept）就实现在它里面，
        // 所以要把它也算作 track-changes 的提供者；否则 panel 模板里
        // `project.features.trackChanges` 恒为 false，修订开关会被禁用。
        return trackChangesModuleAvailable || reviewPanelModuleAvailable
      // FIXED: 2026-11-13 审阅面板（行内批注 + 修订）。
      case 'review-panel':
        return reviewPanelModuleAvailable
      case 'ide-menu-bar':
        return true

      // =====================================================================
      // FIXED: 2026-11-12 部署差异化开关
      //
      // ⚠️ 这里用 `default: throw` 而不是返回 false —— 拼错 flag 名会直接报错，
      //    属于有意为之的快速失败。因此**新增 flag 必须提交到 master**，
      //    不能在 sg 分支上单独加：否则 sg → master 的 merge 会把一个
      //    master 不认识的 flag 带回去，一调就抛异常。
      // =====================================================================
      case 'google-login':
        return Features.loginProviderEnabled('google')
      case 'ne-password-login':
        return Features.loginProviderEnabled('password')
      case 'ne-sms-login':
        return Features.loginProviderEnabled('sms')
      case 'carsi-login':
        // 注意：只关「登录入口」；carsi-mgr / institutions 集合原样保留，
        // 开关打开即恢复，不需要重建任何数据。
        return Features.loginProviderEnabled('carsi')
      case 'billing':
        return Boolean(_.get(Settings, ['billing', 'enabled']))
      case 'llm-credit':
        // 额度制（按 token 计费）而不是 NE 余额制。
        return Boolean(_.get(Settings, ['billing', 'enabled']))
      case 'managed-users':
        return Boolean(_.get(Settings, ['managedUsers', 'enabled']))

      default:
        throw new Error(`unknown feature: ${feature}`)
    }
  },
}

module.exports = Features
