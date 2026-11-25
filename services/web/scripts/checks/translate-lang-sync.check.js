/**
 * 翻译目标语言：前端下拉列表 与 后端提示词白名单 必须一致。
 *
 * 两处分别是：
 *   frontend/js/shared/utils/translate-lang.ts  —— 下拉框里能看到哪些语言
 *   commercial/translate-lang.js        —— 真正拼进提示词的语言名
 *
 * 任何一边加了语言、另一边忘了加，都会表现成“选了某个语言，模型却按原文/英文翻”，
 * 而且不报错 —— 所以用一个纯文本比对钉住。
 *
 * Run: cd services/web && node scripts/checks/translate-lang-sync.check.js
 */

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '../..')
const tsPath = path.join(root, 'frontend/js/shared/utils/translate-lang.ts')
const jsPath = path.join(root, 'commercial/translate-lang.js')

const tsSrc = fs.readFileSync(tsPath, 'utf8')
const jsSrc = fs.readFileSync(jsPath, 'utf8')

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${err.message}`)
  }
}

// 前端：TARGET_LANGS 数组里的字符串
const frontendCodes = (() => {
  const m = tsSrc.match(/export const TARGET_LANGS[^=]*=\s*\[([\s\S]*?)\]/)
  if (!m) throw new Error('TARGET_LANGS 没找到')
  return [...m[1].matchAll(/'([a-z]{2})'/g)].map(x => x[1]).sort()
})()

// 前端：label key 映射必须覆盖每一个 code
const labelKeys = (() => {
  const m = tsSrc.match(
    /export const TARGET_LANG_LABEL_KEY[^=]*=\s*\{([\s\S]*?)\}/
  )
  if (!m) throw new Error('TARGET_LANG_LABEL_KEY 没找到')
  const map = {}
  for (const [, code, key] of m[1].matchAll(/([a-z]{2}):\s*'([a-z_]+)'/g)) {
    map[code] = key
  }
  return map
})()

// 后端：白名单对象里的 key
const backendCodes = (() => {
  const m = jsSrc.match(/const TRANSLATE_TARGET_LANGS\s*=\s*\{([\s\S]*?)\n\}/)
  if (!m) throw new Error('TRANSLATE_TARGET_LANGS 没找到')
  return [...m[1].matchAll(/^\s*([a-z]{2}):/gm)].map(x => x[1]).sort()
})()

// 语言包：每种 UI 语言都必须给出 lang_* 文案
// FIXED: 2026-11-09 支持哪些 UI 语言不由这里拍脑袋决定：
// 直接从服务端实际加载的语言列表推导（app/src/infrastructure/Translations.js 的
// availableLanguageCodes + settings 里 subdomainLang 的 lngCode）。
// 之前只查了 en/zh-CN/zh-TW，漏掉了系统同样支持的 ru（俄语界面下会显示原始 key）。
const supportedLocales = (() => {
  const codes = new Set()
  const translationsSrc = fs.readFileSync(
    path.join(root, 'app/src/infrastructure/Translations.js'),
    'utf8'
  )
  const m = translationsSrc.match(/availableLanguageCodes\s*=\s*\[([^\]]*)\]/)
  if (!m) throw new Error('availableLanguageCodes 没找到')
  for (const [, code] of m[1].matchAll(/'([A-Za-z-]+)'/g)) codes.add(code)

  const settingsSrc = fs.readFileSync(
    path.join(root, 'config/settings.defaults.js'),
    'utf8'
  )
  for (const [, code] of settingsSrc.matchAll(/lngCode:\s*'([A-Za-z-]+)'/g)) {
    codes.add(code)
  }
  return [...codes].sort()
})()

const localeFiles = supportedLocales.map(code => `locales/${code}.json`)

// FIXED: 2026-11-09 前端 locale 只打包「extracted-translations.json 里列出的 key」
// （见 frontend/translations-loader.js）。漏进这个清单的文案会被整条丢掉，
// 界面上就直接显示原始 key（lang_japanese）—— 必须一起检查。
const extractedKeys = Object.keys(
  JSON.parse(
    fs.readFileSync(
      path.join(root, 'frontend/extracted-translations.json'),
      'utf8'
    )
  )
)

console.log('translate language sync')

check('前后端语言列表一致', () => {
  const a = JSON.stringify(frontendCodes)
  const b = JSON.stringify(backendCodes)
  if (a !== b) {
    throw new Error(`前端 ${a} != 后端 ${b}`)
  }
})

check('每个语言都有 label key', () => {
  for (const code of frontendCodes) {
    if (!labelKeys[code]) throw new Error(`${code} 缺 TARGET_LANG_LABEL_KEY`)
  }
})

check(`每种 UI 语言的语言包都有对应文案（${localeFiles.join(', ')}）`, () => {
  for (const file of localeFiles) {
    const json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    for (const code of frontendCodes) {
      const key = labelKeys[code]
      if (!json[key]) throw new Error(`${file} 缺 ${key}`)
    }
  }
})

check(
  'label key 都在 extracted-translations.json 里（漏了前端会显示原始 key）',
  () => {
    const missing = []
    for (const code of frontendCodes) {
      const key = labelKeys[code]
      if (!extractedKeys.includes(key)) missing.push(key)
    }
    if (missing.length) {
      throw new Error(`extracted-translations.json 缺 ${missing.join(', ')}`)
    }
  }
)

check('日文 / 西班牙文都在', () => {
  for (const code of ['ja', 'es']) {
    if (!frontendCodes.includes(code)) throw new Error(`前端缺 ${code}`)
    if (!backendCodes.includes(code)) throw new Error(`后端缺 ${code}`)
  }
})

if (failures.length) {
  console.error(`translate language sync: FAILED (${failures.length})`)
  process.exit(1)
}
console.log('translate language sync: OK')
