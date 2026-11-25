#!/usr/bin/env node
/*
 * langHack 会覆盖 locales/*.json —— 改了翻译却「完全没变」就是这么来的。
 *
 * frontend/js/i18n.js 里：
 *     const newLang = { ...lang, ...langHack[LANG] }
 * 所以 langHack 优先。只改 locales/zh-CN.json（以及白名单），界面上仍然是
 * langHack 里那句老文案 —— 这次「请先登录后再搜索参考文献」改了三次都没生效，
 * 原因就在这儿：同一句话在三个地方各存一份
 *   locales/*.json  →  extracted-translations.json（决定打不打包）  →  langHack（运行时覆盖）
 *
 * 这个脚本只查 crossref_ 这一族（这块已经因为文案反复翻车），
 * 要求 langHack 与 locales 的值逐字一致。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const LANGS = ['en', 'zh-CN', 'zh-TW', 'ru']

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ✗ ${name}\n    ${error.message}`)
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message)
}

function extractLangHack() {
  const file = path.join(ROOT, 'frontend/js/i18n.js')
  const src = fs.readFileSync(file, 'utf8')
  const start = src.indexOf('const langHack = {')
  assert(start !== -1, 'i18n.js 里找不到 langHack')
  let depth = 0
  let quote = null
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    const prev = src[i - 1]
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const literal = src.slice(start + 'const langHack = '.length, i + 1)
        // eslint-disable-next-line no-new-func
        return new Function(`return (${literal})`)()
      }
    }
  }
  throw new Error('langHack 对象没有闭合')
}

const langHack = extractLangHack()

check('langHack 能被解析出四种语言', () => {
  for (const lang of LANGS) {
    assert(langHack[lang], `langHack 里没有 ${lang}`)
  }
})

// 只管「会误导用户的那类文案」：错误提示与 NE 授权状态。
// 其余 crossref_ 键存在历史口径差异（例如 placeholder 措辞两种都通），
// 不在这条断言的管辖范围里 —— 否则它会变成噪音，进而被无视。
const FAMILY = /^crossref_(error_|ne_)/

check('langHack 里的错误/授权文案与 locales/*.json 逐字一致', () => {
  const drift = []
  for (const lang of LANGS) {
    // zh-TW 单独看：locales/zh-TW.json 里这一族仍是简体字，
    // 运行时靠 langHack 纠正，所以它的差异是「已知且有意」的
    if (lang === 'zh-TW') continue
    const locale = JSON.parse(
      fs.readFileSync(path.join(ROOT, `locales/${lang}.json`), 'utf8')
    )
    const hack = langHack[lang] || {}
    for (const key of Object.keys(hack)) {
      if (!FAMILY.test(key)) continue
      if (!(key in locale)) continue
      if (locale[key] !== hack[key]) {
        drift.push(
          `    ${lang} ${key}\n      langHack: ${hack[key]}\n      locales: ${locale[key]}`
        )
      }
    }
  }
  assert(
    drift.length === 0,
    `langHack 会覆盖 locales，这些键改 locales 不会生效：\n${drift.join('\n')}`
  )
})

check('不再出现「请先登录」式错话', () => {
  const banned = [
    '请先登录后再搜索参考文献',
    '請先登錄後再搜索參考文獻',
    'Please login first to search references',
    'Сначала войдите в систему для поиска ссылок',
  ]
  for (const lang of LANGS) {
    const value = (langHack[lang] || {}).crossref_error_login_required || ''
    for (const phrase of banned) {
      assert(
        !value.includes(phrase),
        `${lang} 里还是那句：「${phrase}」—— 用户是用 NE 账号登录的`
      )
    }
    assert(
      value && !value.includes('require right now'),
      `${lang} 缺少 crossref_error_login_required`
    )
  }
})

if (failures) {
  console.error(`\ni18n shadow: ${failures} 项失败`)
  process.exit(1)
}
console.log('\ni18n shadow: OK')
