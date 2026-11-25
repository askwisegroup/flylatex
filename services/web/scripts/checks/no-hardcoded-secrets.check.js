#!/usr/bin/env node
'use strict'

/**
 * 禁止在代码里硬编码密钥/口令（开源前的护栏）
 *
 * FIXED: 2026-11-18 新增。
 *
 * 背景：为了快速上线，很多内部值（用户中心密钥、Zotero 应用凭据、服务端 API Key…）
 * 直接被写进业务代码。开源时这类字面量不能留在仓库里，靠人肉 review 又会漏。
 *
 * 三条规则（命中即失败）：
 *   R1  密钥类变量用「非空字面量」做默认值：`process.env.X_KEY || 'abc123'`
 *       —— 允许 `|| ''`（可选密钥），但使用处必须显式判断；
 *   R2  形如 `apiKey: 'xxxxxxxxxxxx'` / `clientSecret: '...'` 的直接赋值；
 *   R3  明显的密钥前缀字面量：`sk-…`、`ghp_…`、`AKIA…`、JWT 三段式。
 *
 * 例外（白名单，必须写理由）：
 *   - services/web/config/internal-values.js
 *       内部/私有默认值的**唯一**仓库位置；该文件后续会纳入 .gitignore，
 *       开源版只保留 internal-values.example.js（占位）。
 *   - 上游 Overleaf CE 自带的 dev 默认值（SESSION_SECRET / WEB_API_PASSWORD 等），
 *       属于上游行为，改造要单独评估，先放行但记 TODO。
 *
 * 用法：node scripts/checks/no-hardcoded-secrets.check.js
 *       npm run check:no-hardcoded-secrets
 */

const fs = require('fs')
const path = require('path')

// __dirname = services/web/scripts/checks → 上跳 4 层才是仓库根（flylatex-full）
const ROOT = path.join(__dirname, '..', '..', '..', '..')
const TARGET_ROOTS = [
  'services/web/config',
  'services/web/app',
  'services/web/commercial',
  'services/web/modules',
  'services/web/scripts',
  'services/clsi',
  'services/chat',
  'services/contacts',
  'services/docstore',
  'services/document-updater',
  'services/filestore',
  'services/history-v1',
  'services/notifications',
  'services/project-history',
  'services/real-time',
  'services/spelling',
  'libraries',
]

const SKIP_DIR = [
  'node_modules',
  '/public/',
  '/test/',
  '/frontend/js/vendor/',
  '/migrations/',
  '/locales/',
  '/dist/',
  '/build/',
]
const SKIP_FILE = /\.(test|spec|smoke)\.(js|ts|jsx|tsx)$|\.example\.js$|\.md$|\.lock$|package-lock\.json$/
const ALLOW_FILES = new Set([
  'services/web/config/internal-values.js',
])
// 上游 CE 自带的 dev 默认值：先放行，改造需要单独评估（别在这个脚本里悄悄扩大）
const ALLOW_RULES = [
  { name: 'SESSION_SECRET', reason: 'upstream CE dev default（启动靠 env 覆盖，改造需评估）' },
  { name: 'WEB_API_PASSWORD', reason: 'upstream CE dev default（服务间内网口令）' },
]
// 明确「不是密钥」的占位值（上游自助开通用；登录不走口令）
const ALLOW_VALUES = new Set(['password_here'])

const RULES = [
  {
    id: 'R1',
    desc: '密钥类变量用非空字面量当默认值',
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*\|\|\s*(['"])(.+?)\2/g,
    allowEmpty: true,
  },
  {
    id: 'R2',
    desc: '直接给密钥字段赋字面量',
    re: /\b(api[_-]?key|apiKey|client[_-]?secret|clientSecret|secret|password|token|auth[_-]?token)\s*[:=]\s*(['"])([^'"]{10,})\2/g,
  },
  {
    id: 'R3',
    desc: '明显的密钥前缀字面量',
    re: /(['"])((?:sk-[A-Za-z0-9_-]{12,})|(?:ghp_[A-Za-z0-9]{20,})|(?:AKIA[0-9A-Z]{12,})|(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}))\1/g,
  },
]

const findings = []

function scanFile(absPath, relPath) {
  let text
  try {
    text = fs.readFileSync(absPath, 'utf8')
  } catch (err) {
    return
  }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    // 注释行跳过（README/注释里写「例如 process.env.X_KEY || 'xxx'」不算）
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      return
    }
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let match
      while ((match = rule.re.exec(line)) !== null) {
        const name = match[1] || ''
        const value = match[3] || match[2] || ''
        if (rule.allowEmpty && value === '') continue
        if (ALLOW_RULES.some(allow => name.includes(allow.name))) continue
        if (ALLOW_VALUES.has(value)) continue
        // 纯占位符（replace-me / your-key / xxx）放行
        if (/^(replace[-_ ]?me|your[-_ ].*|xxx+|placeholder|<.*>|\$\{.*\})$/i.test(value)) {
          continue
        }
        findings.push({
          file: relPath,
          line: index + 1,
          rule: rule.id,
          desc: rule.desc,
          snippet: trimmed.slice(0, 120),
        })
      }
    }
  })
}

function walk(relRoot) {
  const absRoot = path.join(ROOT, relRoot)
  if (!fs.existsSync(absRoot)) return
  const stack = [absRoot]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(ROOT, abs)
      if (entry.isDirectory()) {
        if (SKIP_DIR.some(skip => (rel + '/').includes(skip))) continue
        stack.push(abs)
        continue
      }
      if (!/\.(js|ts|tsx|jsx|yml|yaml|conf|sh|py|pug)$/.test(entry.name)) continue
      if (SKIP_FILE.test(rel)) continue
      if (ALLOW_FILES.has(rel)) continue
      scanFile(abs, rel)
    }
  }
}

for (const root of TARGET_ROOTS) walk(root)

console.log('== 硬编码密钥检查（npm run check:no-hardcoded-secrets）')
if (findings.length === 0) {
  console.log('  ✓ 没有发现硬编码的密钥/口令')
  console.log('\n注意：内部/私有默认值只允许放在 services/web/config/internal-values.js')
  process.exit(0)
}

for (const f of findings) {
  console.error(`  ✗ [${f.rule}] ${f.file}:${f.line}  ${f.desc}`)
  console.error(`      ${f.snippet}`)
}
console.error(`\n共 ${findings.length} 处。处理方式：`)
console.error('  · 内部/私有默认值 → 挪到 services/web/config/internal-values.js（唯一出口）')
console.error('  · 业务逻辑需要必填 → 直接 fail-fast 报错（参考 ai-config.js 的 requireOpenAIModel）')
console.error('  · 确实是上游 dev 默认 → 在脚本的 ALLOW_RULES 里加白名单并写明理由')
process.exit(1)
