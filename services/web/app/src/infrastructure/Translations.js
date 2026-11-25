const i18n = require('i18next')
const fsBackend = require('i18next-fs-backend')
const middleware = require('i18next-http-middleware')
const path = require('path')
const Settings = require('@overleaf/settings')
const { URL } = require('url')
const pug = require('pug-runtime')
const logger = require('@overleaf/logger')
const SafeHTMLSubstitution = require('../Features/Helpers/SafeHTMLSubstitution')

const fallbackLanguageCode = Settings.i18n.defaultLng || 'zh-CN' //'en'
// FIXED: 2026-11-10 新增西班牙语 / 日语 / 葡萄牙语界面（lngCode 与 locales/*.json 对应）
// OLD: 只有 en / zh-CN / zh-TW / ru 四种
// （保留旧列表的文字说明即可，别写成可被正则匹配的完整语句，
//   scripts/checks/translate-lang-sync.check.js 会按 availableLanguageCodes 抓取）
const availableLanguageCodes = [
  'en',
  'zh-CN',
  'zh-TW',
  'ru',
  'es',
  'ja',
  'pt',
  // FIXED: 2026-11-10 法语补进站内可选语言（locales/fr.json 已补到 100%）
  'fr',
]
const availableHosts = new Map()
const subdomainConfigs = new Map()
const I18N_HTML_INJECTIONS = new Set()

Object.values(Settings.i18n.subdomainLang || {}).forEach(function (spec) {
  availableLanguageCodes.push(spec.lngCode)
  // prebuild a host->lngCode mapping for the usage at runtime in the
  //  middleware
  availableHosts.set(new URL(spec.url).host, spec.lngCode)

  // prebuild a lngCode -> language config mapping; some subdomains should
  //  not appear in the language picker
  if (!spec.hide) {
    subdomainConfigs.set(spec.lngCode, spec)
  }
})
if (!availableLanguageCodes.includes(fallbackLanguageCode)) {
  // always load the fallback locale
  availableLanguageCodes.push(fallbackLanguageCode)
}

// FIXED: 2026-11-10 去重。settings.i18n.subdomainLang 里 www 的 lngCode 就是 zh-CN，
// 上面那圈 forEach 会把它再 push 一遍 → 语言选择器里出现两个「简体中文」，
// preload / supportedLngs 也重复加载同一门语言。
const uniqueLanguageCodes = [...new Set(availableLanguageCodes)]
availableLanguageCodes.length = 0
availableLanguageCodes.push(...uniqueLanguageCodes)

// FIXED: 2026-11-10 语言选择器的选项来源。
// OLD: 只遍历 settings.i18n.subdomainLang（本站只有一个 www 子域，
//      模板里 Object.keys(subdomainLang).length > 1 恒为 false → 选择器整块隐藏，
//      用户在站内切不到日本語 / Español / Português）。
// 新: 以"实际加载得到的语言"availableLanguageCodes 为准，标签取 settings.translatedLanguages。
const translatedLanguages = Settings.translatedLanguages || {}
const languageOptions = availableLanguageCodes
  .map(code => ({ code, label: translatedLanguages[code] || code }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en'))
const languageLabels = Object.fromEntries(
  languageOptions.map(option => [option.code, option.label])
)

// The "node --watch" flag is not easy to detect.
if (process.argv.includes('--watch-locales')) {
  // Dummy imports for setting up watching of locales files.
  for (const lngCode of availableLanguageCodes) {
    require(`../../../locales/${lngCode}.json`)
  }
}

i18n
  .use(fsBackend)
  .use(middleware.LanguageDetector)
  .init({
    backend: {
      loadPath: path.join(__dirname, '../../../locales/__lng__.json'),
    },

    // still using the v3 plural suffixes
    compatibilityJSON: 'v3',

    // Load translation files synchronously: https://www.i18next.com/overview/configuration-options#initimmediate
    initImmediate: false,

    // We use the legacy v1 JSON format, so configure interpolator to use
    // underscores instead of curly braces
    interpolation: {
      prefix: '__',
      suffix: '__',
      unescapeSuffix: 'HTML',
      // Disable escaping of interpolated values for backwards compatibility.
      // We escape the value after it's translated in web, so there's no
      // security risk
      escapeValue: Settings.i18n.escapeHTMLInVars,
      // Disable nesting in interpolated values, preventing user input
      // injection via another nested value
      skipOnVariables: true,

      defaultVariables: {
        appName: Settings.appName,
      },
    },

    detection: {
      order: ['cookie', 'localStorage'],
      lookupCookie: 'flylatex-lang',
      lookupLocalStorage: 'flylatexLang',
    },

    preload: availableLanguageCodes,
    supportedLngs: availableLanguageCodes,
    fallbackLng: 'zh-CN',
  })

// Make custom language detector for Accept-Language header
const headerLangDetector = new middleware.LanguageDetector(i18n.services, {
  order: ['header'],
})

function setLangBasedOnDomainMiddleware(req, res, next) {
  // FIXED: 2026-11-10 这三行调试日志原来是无条件执行的：
  //   - 每个请求都打一遍（线上日志被刷满）；
  //   - 单元测试里没有 cookie 中间件，req.cookies 为 undefined，直接 TypeError
  //     （test/unit/src/infrastructure/TranslationsTests.js 因此 5 条全红）。
  // 改成按开关打开，并且对 req.cookies 缺失做兜底。
  const cookies = req.cookies || {}
  if (process.env.DEBUG_I18N_LANG) {
    console.log('req.cookies', cookies)
    console.log('req.language', req.language)
    console.log(
      'flylatex-lang:',
      cookies['flylatex-lang'],
      'req.language:',
      req.language
    )
  }

  // 只有在没有 cookie 的情况下，才根据子域名设置语言
  if (!cookies['flylatex-lang']) {
    const lang = availableHosts.get(req.headers.host)
    if (lang) {
      req.i18n.changeLanguage(lang)
    }
  }

  // expose the language code to pug
  res.locals.currentLngCode = req.language
  // FIXED: 2026-11-10 供 language-picker.pug 渲染选项（code + 本地语言名）
  res.locals.i18nLanguages = languageOptions
  res.locals.i18nLanguageLabels = languageLabels

  // If the set language is different from the language detection (based on
  // the Accept-Language header), then set flag which will show a banner
  // offering to switch to the appropriate library
  const detectedLanguageCode = headerLangDetector.detect(req, res)
  if (req.language !== detectedLanguageCode) {
    res.locals.suggestedLanguageSubdomainConfig =
      subdomainConfigs.get(detectedLanguageCode)
  }

  // Decorate req.i18n with translate function alias for backwards
  // compatibility usage in requests
  req.i18n.translate = (key, vars, components) => {
    vars = vars || {}

    if (Settings.i18n.checkForHTMLInVars) {
      Object.entries(vars).forEach(([field, value]) => {
        if (pug.escape(value) !== value) {
          const violationsKey = key + field
          // do not flood the logs, log one sample per pod + key + field
          if (!I18N_HTML_INJECTIONS.has(violationsKey)) {
            logger.warn(
              { key, field, value },
              'html content in translations context vars'
            )
            I18N_HTML_INJECTIONS.add(violationsKey)
          }
        }
      })
    }

    const locale = req.i18n.t(key, vars)
    if (components) {
      return SafeHTMLSubstitution.render(locale, components)
    } else {
      return locale
    }
  }

  next()
}

// Decorate i18n with translate function alias for backwards compatibility
// in direct usage
i18n.translate = i18n.t

module.exports = {
  i18nMiddleware: middleware.handle(i18n),
  setLangBasedOnDomainMiddleware,
  i18n,
}
