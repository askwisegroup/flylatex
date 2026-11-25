'use strict'

/**
 * SSO 模块的**开源边界**回归测试。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个测试
 * ---------------------------------------------------------------------------
 * 需求是「推送开源代码时把私有部分替换成 holder code」。SSO 之所以能做到
 * 「一行都不用改」，唯一原因是它只依赖 `req.session.user`，完全不碰 NE /
 * Google 的私有实现。但这个性质**极其容易被一次顺手的 require 破坏**：
 *
 *     // 「顺手」把 carsiEmail 也发出去
 *     const NE = require('../../../../commercial')
 *     ...
 *
 * 这种改动在 code review 里几乎看不出来（一行 require + 一行取值），
 * 但它会让开源版本直接跑不起来，或者把 NE 内部结构泄漏给下游。
 *
 * 所以用**源码级断言**把它钉死 —— 仓库里已有同类做法，见
 * `app/src/Features/IdentityProviders/login-providers.test.js`（断言
 * login.pug 必须遍历 loginProviders、不得写死按钮）。
 *
 * 运行：npm run test:sso   （或 node --test app/src/Features/Sso/）
 * 本测试不 require @overleaf/settings，因此不依赖完整运行时环境。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')

const SSO_DIR = __dirname

/** 被测源码：本目录下所有 .js，排除测试文件自己 */
function sourceFiles() {
  return fs
    .readdirSync(SSO_DIR)
    .filter(name => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map(name => ({
      name,
      text: fs.readFileSync(path.join(SSO_DIR, name), 'utf8'),
    }))
}

/**
 * 只保留**代码行**，去掉注释行。
 *
 * 本仓库的注释习惯是把真实字段名和真实 require 路径写进说明里（这正是好习惯），
 * 例如 Claims.js 里就有一句「不是 `{ ...sessionUser }`」。如果不剔除注释，
 * 这些反向说明会被当成违规命中 —— 把边界测试变成「不许在注释里提到它」，
 * 那么后续维护者只会把注释删掉，反而丢掉真正的设计理由。
 *
 * 只按行首判断（`*` / `//` / `/*`），不动行内字符串：本目录的代码里没有
 * 行尾注释，这个简化是安全的，也不会误伤 Session.js 里的 URL 正则。
 */
function codeLinesOnly(text) {
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return !(
        trimmed.startsWith('*') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*')
      )
    })
    .join('\n')
}

/** 抽出所有 require('...') 的模块名 */
function requiresOf(text) {
  const found = []
  const re = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
  let match
  while ((match = re.exec(codeLinesOnly(text))) !== null) {
    found.push(match[1])
  }
  return found
}

/**
 * 允许出现的**裸模块名**。
 *
 * 这是一份刻意很短的清单：每加一个都要问一句「开源版本装得出这个依赖吗」。
 * `@overleaf/*` 全部来自本仓库 `libraries/`，随代码一起开源。
 */
const ALLOWED_BARE_MODULES = [
  '@overleaf/settings',
  '@overleaf/logger',
  '@overleaf/metrics',
  '@overleaf/o-error',
  '@overleaf/promise-utils',
  'lodash',
]

const BUILTINS = new Set(builtinModules)

/**
 * 私有模块的识别特征。
 *
 * 用子串匹配而不是路径全匹配：它们可能被不同深度的相对路径引用
 * （`../../../../commercial` / `../IdentityProviders/GoogleAuthController`），
 * 只有子串是稳定的。
 */
const FORBIDDEN_SUBSTRINGS = [
  // NE 用户中心 SDK 与 V2 认证实现
  'commercial',
  'ne-auth-v2',
  // NE 专有逻辑
  'NeAccountSync',
  'Carsi',
  'carsi',
  // Google 登录适配器
  'IdentityProviders',
  // 私有配置（登录方式由 loginProviders 决定，SSO 不该关心是哪种）
  'loginProviders',
]

/**
 * 禁止把整个 session user spread 出去。
 *
 * `{ ...user }` / `{ ...sessionUser }` / `{ ...req.session.user }` 会把
 * `account_id` / `carsiEmail` / `isAdmin` / `staffAccess` 一起送出门 ——
 * 而 Claims.js 存在的全部意义就是不允许这件事发生。
 */
const SPREAD_PATTERN =
  /\.\.\.\s*(?:req\.session\.user|sessionUser|user|lightUser)\b/

const files = sourceFiles()

test('SSO 目录里确实有源码（防止 glob 写错导致空跑通过）', () => {
  assert.ok(files.length >= 3, `只找到 ${files.length} 个源文件`)
  assert.ok(
    files.some(f => f.name === 'Claims.js'),
    'Claims.js 必须存在'
  )
  assert.ok(
    files.some(f => f.name === 'Session.js'),
    'Session.js 必须存在'
  )
})

test('不得 require 任何私有模块（NE / CARSI / Google / 登录方式注册表）', () => {
  const violations = []
  for (const file of files) {
    for (const moduleName of requiresOf(file.text)) {
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        if (moduleName.toLowerCase().includes(needle.toLowerCase())) {
          violations.push(
            `${file.name}: require('${moduleName}') 命中 '${needle}'`
          )
        }
      }
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    'SSO 模块必须与上游 IdP 解耦，否则开源版本跑不起来：\n' +
      violations.join('\n')
  )
})

test('不得读取 NE_* / GOOGLE_* 等私有环境变量', () => {
  const violations = []
  for (const file of files) {
    const re = /process\.env\.((?:NE|GOOGLE|GCP)_[A-Z0-9_]+)/g
    let match
    while ((match = re.exec(codeLinesOnly(file.text))) !== null) {
      violations.push(`${file.name}: process.env.${match[1]}`)
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    'SSO 只读 session，不读上游 IdP 的凭据：\n' + violations.join('\n')
  )
})

test('只允许 require 相对路径、@overleaf/* 或白名单裸模块', () => {
  const violations = []
  for (const file of files) {
    for (const moduleName of requiresOf(file.text)) {
      if (moduleName.startsWith('.') || moduleName.startsWith('/')) continue
      if (moduleName.startsWith('node:')) continue
      if (BUILTINS.has(moduleName)) continue
      if (ALLOWED_BARE_MODULES.includes(moduleName)) continue
      violations.push(`${file.name}: require('${moduleName}')`)
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    '新增裸依赖前先确认开源版本装得出来，并把它加进 ALLOWED_BARE_MODULES：\n' +
      violations.join('\n')
  )
})

test('不得 spread session user（claims 只能逐字段白名单）', () => {
  const violations = []
  for (const file of files) {
    const match = SPREAD_PATTERN.exec(codeLinesOnly(file.text))
    if (match) {
      violations.push(`${file.name}: ${match[0]}`)
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    '透传 session user 会泄漏 account_id / carsiEmail / isAdmin / staffAccess：\n' +
      violations.join('\n')
  )
})

test('claims 白名单必须显式列举，且包含必需的 sub', () => {
  const claimsSource = fs.readFileSync(path.join(SSO_DIR, 'Claims.js'), 'utf8')
  assert.match(
    claimsSource,
    /sub:\s*String\(user\._id\)/,
    'sub 必须来自本地 User._id（换上游 IdP 后仍然稳定），不能是 account_id / Google sub / email'
  )
  assert.match(
    claimsSource,
    /claims\.email_verified\s*=\s*false/,
    'email_verified 必须恒为 false：FlyLaTeX 不校验邮箱归属，下游不得把 email 当主键'
  )
})
