/**
 * 登录页渲染回归（真渲染，不是字符串包含）。
 *
 * 做法：把 `extends ../layout-marketing` 换成一个空的 `formMessages` mixin，
 * 这样 `block content` 会就地渲染 —— 不必为了测试去构造一整套 layout 局部变量。
 * 覆盖的正是「分支写错了但语法合法」这类最容易溜过评审的错误。
 *
 * 钉住：
 *   - 中国站渲染结果与改造前等价（密码 + 短信 + CARSI 都在）
 *   - 海外站只渲染 Google，且**完全不出现** NE 相关的 DOM
 *     （否则 NE 的验证码/密码加密脚本仍会挂上去，白跑一遍初始化）
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const pug = require('pug')

const TEMPLATE = path.join(__dirname, '../../../views/user/login.pug')

function compile() {
  const source = fs
    .readFileSync(TEMPLATE, 'utf8')
    .replace(
      'extends ../layout-marketing',
      'mixin formMessages()\n        .form-messages-slot'
    )
  return pug.compile(source, { filename: TEMPLATE })
}

const translate = key => `[${key}]`

function render(loginProviders) {
  return compile()({
    translate,
    csrfToken: 'csrf-token-for-test',
    loginProviders,
    googleClientId: 'client-id.apps.googleusercontent.com',
  })
}

const CN_PROVIDERS = [
  { id: 'password', kind: 'ne-password', enabled: true, order: 10 },
  { id: 'sms', kind: 'ne-sms', enabled: true, order: 20 },
  { id: 'carsi', kind: 'carsi', enabled: true, order: 30 },
]

const SG_PROVIDERS = [{ id: 'google', kind: 'google', enabled: true, order: 5 }]

test('中国站：密码 / 短信 / CARSI 全部渲染，不出现 Google', () => {
  const html = render(CN_PROVIDERS)

  assert.ok(html.includes('id="ne-login-form-pw"'), '密码表单')
  assert.ok(html.includes('id="ne-login-form-sms"'), '短信表单')
  assert.ok(html.includes('href="/carsi"'), 'CARSI 入口')
  assert.ok(html.includes('fl-login__subtitle'), '账号副标题')
  assert.ok(!html.includes('data-google-client-id'), '不应有 Google 按钮')
})

test('海外站：只渲染 Google，不出现任何 NE 组件', () => {
  const html = render(SG_PROVIDERS)

  assert.ok(html.includes('id="google-login"'), 'Google 容器')
  assert.ok(html.includes('id="google-login-button"'), 'Google 按钮槽')
  assert.ok(
    html.includes('client-id.apps.googleusercontent.com'),
    'client id 要传到前端'
  )

  // NE 相关的 DOM 一个都不能出现 —— 出现就意味着海外用户会看到一个
  // 用不了的登录框，或者前端脚本白跑一遍初始化。
  assert.ok(!html.includes('id="ne-login-form-pw"'), '不应有密码表单')
  assert.ok(!html.includes('id="ne-login-form-sms"'), '不应有短信表单')
  assert.ok(!html.includes('href="/carsi"'), '不应有 CARSI 入口')
  assert.ok(!html.includes('data-ol-ne-captcha'), '不应有阿里云验证码挂载点')
  assert.ok(!html.includes('fl-login__subtitle'), '不应有账号副标题')
})

// FIXED: 2026-11-15 登录页改版（方案 B）后结构变了，这里改成按新结构的口径钉住：
//   分段器只装「原地换表单」的登录方式；CARSI 是跨站跳转，永远单独一块。
const DIVIDER = 'fl-login__divider-text'
const countOf = (html, needle) => html.split(needle).length - 1

test('两种登录方式并存时出现 or 分隔线，只有一种时没有', () => {
  const both = render([
    { id: 'google', kind: 'google', enabled: true, order: 5 },
    { id: 'password', kind: 'ne-password', enabled: true, order: 10 },
  ])
  assert.ok(both.includes('id="google-login"'))
  assert.ok(both.includes('id="ne-login-form-pw"'))
  assert.strictEqual(countOf(both, DIVIDER), 1, '并存时应有一条 or 分隔线')

  // 只有 Google 时不该有分隔线
  assert.strictEqual(countOf(render(SG_PROVIDERS), DIVIDER), 0, '只有一种登录方式时不应出现分隔线')
})

test('分段器只装密码 / 短信，CARSI 不在分段器里', () => {
  const html = render(CN_PROVIDERS)
  assert.strictEqual(countOf(html, 'data-ol-ne-tab='), 2, '密码 + 短信两个分段')
  assert.ok(html.includes('role="tablist"'), '分段器应声明 tablist')
  assert.ok(
    html.indexOf('data-ol-ne-tab="pw"') < html.indexOf('id="ne-login-form-pw"'),
    '分段器在表单之前'
  )
  // CARSI 是跳转，不能变成页签
  assert.ok(!/data-ol-ne-tab="carsi"/.test(html), 'CARSI 不应是页签')
  assert.ok(html.includes('href="/carsi"'), 'CARSI 仍是链接')
  assert.ok(html.includes('fl-login__sso-hint'), '跳转类登录要提示会离开本页')
})

test('CARSI 只在是唯一登录方式时才当主按钮', () => {
  // 有 NE 账号登录时：CARSI 是描边按钮，不能带 btn-primary
  const withNe = render(CN_PROVIDERS)
  const anchor = withNe.match(/<a[^>]*href="\/carsi"[^>]*>/)[0]
  assert.ok(!anchor.includes('btn-primary'), 'CARSI 不能和「登录」抢主色')

  // 纯机构部署（只有 CARSI）：它必须是唯一主动作
  const onlyCarsi = render([{ id: 'carsi', kind: 'carsi', enabled: true, order: 30 }])
  const onlyCarsiAnchor = onlyCarsi.match(/<a[^>]*href="\/carsi"[^>]*>/)[0]
  assert.ok(onlyCarsiAnchor.includes('btn-primary'), '只有 CARSI 时要升为主按钮')
  assert.strictEqual(countOf(onlyCarsi, DIVIDER), 0, '没有别的登录方式时不需要分隔线')
  assert.ok(!onlyCarsi.includes('id="ne-login-form-pw"'))
})

test('只有密码（无短信）时不出分段器', () => {
  const html = render([
    { id: 'password', kind: 'ne-password', enabled: true, order: 10 },
    { id: 'carsi', kind: 'carsi', enabled: true, order: 30 },
  ])
  assert.strictEqual(countOf(html, 'data-ol-ne-tab='), 0, '只有一种表单就不该有页签')
  assert.ok(html.includes('id="ne-login-form-pw"'))
  assert.strictEqual(countOf(html, DIVIDER), 1, '密码 + CARSI 之间要有一条分隔线')
})
