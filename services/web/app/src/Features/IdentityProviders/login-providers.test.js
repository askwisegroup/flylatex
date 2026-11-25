/**
 * 登录提供方注册表的回归测试。
 *
 * 钉住 4 件事：
 *   1. 中国站行为**不变**：密码 / 短信 / CARSI 全开，Google 关。
 *   2. 海外站默认：只剩 Google（NE 密码 / 短信 / CARSI 全关）。
 *   3. Google 缺 clientId 时**不算可用**（否则登录页会出现点了就失败的按钮）。
 *   4. 防砖锁：一个提供方都不剩时强制放开密码登录（不能全站无人可登）。
 *
 * 另外做一次**源码级接线检查**：login.pug 必须按 `loginProviders` 渲染，
 * 且 CARSI / 短信块必须被条件包裹 —— 防止以后有人顺手把按钮写死回去，
 * 那种改动在代码评审时几乎看不出来，但会让 sg 分支的 merge 长期冲突。
 */
const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const Settings = require('@overleaf/settings')
const Features = require('../../infrastructure/Features')

const ORIGINAL_PROVIDERS = JSON.parse(JSON.stringify(Settings.loginProviders))

function setProviders(overrides) {
  Settings.loginProviders = JSON.parse(JSON.stringify(ORIGINAL_PROVIDERS))
  for (const [id, patch] of Object.entries(overrides)) {
    Settings.loginProviders[id] = Object.assign(
      {},
      Settings.loginProviders[id],
      patch
    )
  }
}

function enabledIds() {
  return Features.enabledLoginProviders().map(provider => provider.id)
}

test('中国站：密码 / 短信 / CARSI 全开，Google 关闭', () => {
  setProviders({
    password: { enabled: true },
    sms: { enabled: true },
    carsi: { enabled: true },
    google: { enabled: false, clientId: '' },
  })

  const ids = enabledIds()
  assert.ok(ids.includes('password'))
  assert.ok(ids.includes('sms'))
  assert.ok(ids.includes('carsi'))
  assert.ok(!ids.includes('google'))
})

test('海外站：只剩 Google（NE 密码 / 短信 / CARSI 全关）', () => {
  setProviders({
    password: { enabled: false },
    sms: { enabled: false },
    carsi: { enabled: false },
    google: { enabled: true, clientId: 'abc.apps.googleusercontent.com' },
  })

  assert.deepStrictEqual(enabledIds(), ['google'])
})

test('Google 开启但缺 clientId → 视为不可用', () => {
  setProviders({
    password: { enabled: true },
    sms: { enabled: false },
    carsi: { enabled: false },
    google: { enabled: true, clientId: '' },
  })

  assert.ok(!Features.loginProviderEnabled('google'))
  assert.ok(!enabledIds().includes('google'))
})

test('防砖锁：一个提供方都没有时强制放开密码登录', () => {
  setProviders({
    password: { enabled: false },
    sms: { enabled: false },
    carsi: { enabled: false },
    google: { enabled: true, clientId: '' },
  })

  const ids = enabledIds()
  assert.deepStrictEqual(ids, ['password'], '不能让整站无人可登')
})

test('提供方按 order 升序输出（Google 在密码之前）', () => {
  setProviders({
    password: { enabled: true },
    sms: { enabled: false },
    carsi: { enabled: false },
    google: { enabled: true, clientId: 'abc.apps.googleusercontent.com' },
  })

  assert.deepStrictEqual(enabledIds(), ['google', 'password'])
})

test('hasFeature 覆盖全部登录开关（拼错 flag 会抛错）', () => {
  assert.doesNotThrow(() => Features.hasFeature('google-login'))
  assert.doesNotThrow(() => Features.hasFeature('ne-password-login'))
  assert.doesNotThrow(() => Features.hasFeature('ne-sms-login'))
  assert.doesNotThrow(() => Features.hasFeature('carsi-login'))
  assert.doesNotThrow(() => Features.hasFeature('billing'))
  assert.doesNotThrow(() => Features.hasFeature('llm-credit'))
})

test('login.pug 按注册表渲染，且 CARSI / 短信块被条件包裹', () => {
  const file = path.join(__dirname, '../../../views/user/login.pug')
  const source = fs.readFileSync(file, 'utf8')

  assert.ok(
    source.includes('loginProviders'),
    'login.pug 必须遍历 loginProviders，不能把登录方式写死'
  )

  for (const guard of ['hasGoogle', 'hasPassword', 'hasSms', 'hasCarsi']) {
    assert.ok(
      source.includes(`if ${guard}`),
      `login.pug 缺少条件包裹：if ${guard}`
    )
  }

  // CARSI 链接与短信表单必须出现在条件之后。
  // FIXED: 2026-11-15 不能用 'btn-carsi' 定位：旧实现的标记被按规范保留在
  // `//- OLD:` 注释里（那是允许的），它出现在 if hasCarsi 之前，会让这条断言误判。
  // 改成找真正生效的 href="/carsi"。
  // 注意：两个标记都从守卫之后开始找。文件头的「钩子清单」注释里也写了
  // `#ne-login-form-sms`，用 indexOf 全局找会命中注释，误判成「在守卫之外」。
  const carsiGuard = source.indexOf('if hasCarsi')
  const carsiLink = source.indexOf('href="/carsi"', carsiGuard)
  assert.ok(carsiGuard > -1 && carsiLink > carsiGuard, 'CARSI 链接必须在 if hasCarsi 之内')

  const smsGuard = source.indexOf('if hasSms')
  const smsForm = source.indexOf('ne-login-form-sms', smsGuard)
  assert.ok(smsGuard > -1 && smsForm > smsGuard, '短信表单必须在 if hasSms 之内')
})

test('login.pug 里不存在未注释的硬编码 CARSI 供应商地址', () => {
  const file = path.join(__dirname, '../../../views/user/login.pug')
  const source = fs.readFileSync(file, 'utf8')

  // 历史地址按"保留原逻辑"的规范留在 pug 注释里（见 CLAUDE.md），
  // 这是允许的；不允许的是它们重新变成**生效的**链接。
  const offenders = source.split('\n').filter(line => {
    const isComment = line.trim().startsWith('//-')
    const hasProviderUrl = /idp\.example\.edu\.cn|idp2\.example\.edu\.cn/.test(
      line
    )
    return hasProviderUrl && !isComment
  })

  assert.deepStrictEqual(offenders, [], 'CARSI 供应商地址只能出现在注释里')
})

after(() => {
  Settings.loginProviders = ORIGINAL_PROVIDERS
})
