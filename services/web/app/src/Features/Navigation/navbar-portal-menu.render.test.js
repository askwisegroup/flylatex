/**
 * 顶部导航「站点功能菜单」渲染回归（真渲染，不是字符串包含）
 *
 * 改造前这三项写死在 navbar-marketing.pug 里；现在数据结构由运营后台
 * （carsi-mgr 的「导航菜单」页）决定，模板必须把三种 kind 都画对：
 *
 *   item      → <li><a href=...>文案</a></li>
 *   group     → <li class="dropdown">…<ul class="dropdown-menu">…子项…</ul>
 *   separator → <li class="divider">
 *
 * 钉住的口径：
 *   - 文案按当前语言取（label 是 { 语言码: 文案 }，不是 i18next key）
 *   - target=_blank 时必须带 rel="noopener noreferrer"（2026-11-08 的老口径）
 *   - group 不渲染 link/target；separator 不渲染文案
 *   - 第 2 层起的 group 退化成 dropdown-header + 平铺子项（Bootstrap 2 没有多级菜单）
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const pug = require('pug')

const PortalMenu = require('./PortalMenu')

const TEMPLATE = path.join(
  __dirname,
  '../../../views/layout/navbar-marketing.pug'
)

function render(items, { loggedIn = true, lng = 'zh-CN' } = {}) {
  const html = pug.renderFile(TEMPLATE, {
    filename: TEMPLATE,
    compileDebug: false,
    // ---- navbar-marketing.pug 用到的局部变量（只给最小可渲染集合） ----
    translate: key => `[${key}]`,
    settings: { appName: 'FlyLaTeX', nav: {} },
    nav: { title: 'FlyLaTeX', header_extras: [], showSubscriptionLink: false },
    csrfToken: 'csrf-token-for-test',
    scriptNonce: 'nonce',
    hasAdminAccess: () => false,
    canRedirectToAdminDomain: () => false,
    hasFeature: () => false,
    getSessionUser: () => (loggedIn ? { email: 'someone@example.com' } : null),
    currentUrl: '/project',
    // ---- 被测数据 ----
    portalMenu: PortalMenu.splitByVisibility(PortalMenu.normalizeItems(items)),
    portalMenuLabel: label => PortalMenu.resolveLabel(label, lng),
  })
  // 只看右侧导航，避免和 brand / 其它块混在一起断言
  return html
}

const WHITEBOARD = {
  kind: 'item',
  label: { en: 'Whiteboard', 'zh-CN': '白板' },
  link: '/whiteboard/index.html',
  target: '_blank',
  visibility: 'logged-in',
}

test('item：渲染链接、新开页带 noopener、文案按当前语言', () => {
  const html = render([WHITEBOARD], { lng: 'zh-CN' })
  assert.ok(html.includes('href="/whiteboard/index.html"'))
  assert.ok(html.includes('target="_blank"'))
  assert.ok(html.includes('rel="noopener noreferrer"'))
  // 断言到「标签内容」这一级：页面里有 id="openWhiteboard" 这类同名片段
  assert.ok(html.includes('>白板</a>'))
  assert.ok(!html.includes('>Whiteboard</a>'))

  const enHtml = render([WHITEBOARD], { lng: 'en' })
  assert.ok(enHtml.includes('>Whiteboard</a>'))
})

test('item：target=_self 时不加 rel，同页签打开', () => {
  const html = render([
    {
      kind: 'item',
      label: { en: 'Inner' },
      link: '/project/tmp',
      target: '_self',
    },
  ])
  assert.ok(html.includes('href="/project/tmp"'))
  assert.ok(html.includes('target="_self"'))
  assert.ok(!html.includes('rel="noopener'))
})

test('group：渲染下拉菜单和子项，忽略 link/target', () => {
  const html = render([
    {
      kind: 'group',
      label: { 'zh-CN': '更多工具' },
      link: '/ignored',
      children: [
        { kind: 'item', label: { 'zh-CN': '子项A' }, link: '/a' },
        { kind: 'separator' },
        { kind: 'item', label: { 'zh-CN': '子项B' }, link: '/b' },
      ],
    },
  ])
  assert.ok(html.includes('class="dropdown"'))
  assert.ok(html.includes('data-toggle="dropdown"'))
  assert.ok(html.includes('更多工具'))
  assert.ok(html.includes('href="/a"'))
  assert.ok(html.includes('href="/b"'))
  assert.ok(html.includes('class="divider"'), '子项里的分割线')
  assert.ok(!html.includes('/ignored'), 'group 的 link 必须被忽略')
})

test('separator：只画分割线，不画文案', () => {
  const html = render([
    { kind: 'item', label: { 'zh-CN': 'A' }, link: '/a' },
    { kind: 'separator', label: { 'zh-CN': '不该出现' } },
  ])
  assert.ok(html.includes('class="divider"'))
  assert.ok(!html.includes('不该出现'))
})

test('更深层的 group 退化成 dropdown-header + 平铺子项（不丢信息）', () => {
  const html = render([
    {
      kind: 'group',
      label: { 'zh-CN': '一级' },
      children: [
        {
          kind: 'group',
          label: { 'zh-CN': '二级' },
          children: [
            { kind: 'item', label: { 'zh-CN': '深层项' }, link: '/deep' },
          ],
        },
      ],
    },
  ])
  assert.ok(html.includes('dropdown-header'))
  assert.ok(html.includes('二级'))
  assert.ok(html.includes('href="/deep"'))
})

test('visibility：未登录用户看不到 logged-in 项，但看得到 any / logged-out 项', () => {
  const items = [
    WHITEBOARD,
    { kind: 'item', label: { 'zh-CN': '活动页' }, link: '/event' }, // 默认 any
    {
      kind: 'item',
      label: { 'zh-CN': '注册引导' },
      link: '/welcome',
      visibility: 'logged-out',
    },
  ]

  const guest = render(items, { loggedIn: false })
  assert.ok(!guest.includes('/whiteboard/index.html'), '登录项不该出现')
  assert.ok(guest.includes('href="/event"'), 'any 项访客可见')
  assert.ok(guest.includes('href="/welcome"'), 'logged-out 项访客可见')

  const user = render(items, { loggedIn: true })
  assert.ok(user.includes('/whiteboard/index.html'))
  assert.ok(user.includes('href="/event"'))
  assert.ok(!user.includes('href="/welcome"'), 'logged-out 项不该给登录用户')
})

test('菜单为空时导航栏其余部分照常渲染（不报错、不留空 li）', () => {
  const html = render([], { loggedIn: true })
  assert.ok(html.includes('href="/project"'), '项目入口还在')
  assert.ok(html.includes('[Account]'), '账户菜单还在')
  assert.ok(!html.includes('class="divider"'))
})
