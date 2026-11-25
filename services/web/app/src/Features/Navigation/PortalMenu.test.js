'use strict'

/**
 * 站点功能菜单（PortalMenu）读库契约测试
 *
 * 钉死的是「数据写坏了导航会怎样」这一组口径 —— 这些都是线上最难排查的
 * 静默故障：不报错，只是入口消失或位置漂移。覆盖：
 *
 *   1. 文档不存在（null）→ 内置三项兜底（与改造前写死的模板等价）
 *   2. 文档存在但 items=[] → 菜单为空（运营显式清空），**不**回退内置项
 *   3. items 不是数组（类型写错）→ 内置三项
 *   4. findOne 抛错 → 内置三项，不抛异常（有旧缓存则用旧缓存）
 *   5. 单条格式不对（缺 label / link 非法 / kind 未知）→ 只丢那一条
 *   6. kind 别名：sperator / divider / hr → separator；无 kind 有 children → group
 *   7. indexOf 按父级数组下标回填，children 递归归一
 *   8. 缓存：TTL 内只读一次库；reload() 立即重读
 *   9. label 取词：精确 → 同基础语言 → 站点默认语言 → en → 第一个非空
 *  10. visibility 拆分成 forGuest / forUser
 *
 * Run: node --test app/src/Features/Navigation/PortalMenu.test.js
 * 不连 Mongo、不连外网（数据源是内存里的假集合）。
 */

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const state = {
  doc: null,
  findShouldThrow: false,
  findCalls: 0,
  collectionCalls: 0,
}

const fakeCollection = {
  async findOne() {
    state.findCalls += 1
    if (state.findShouldThrow) {
      throw new Error('mongo down')
    }
    return state.doc
  },
}

const mongodbStub = {
  async getCollectionInternal() {
    state.collectionCalls += 1
    return fakeCollection
  },
}

// 模块内部是惰性 require（../../infrastructure/mongodb），这里在加载前替换掉，
// 避免真的去连库（mongodb.js 顶部有「单测期间连了就 throw」的守卫）。
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '../../infrastructure/mongodb') {
    return mongodbStub
  }
  return originalLoad.call(this, request, parent, isMain)
}

const PortalMenu = require(path.join(__dirname, 'PortalMenu.js'))

const BUILTIN_LINKS = ['/whiteboard/index.html', '/templates', '/opentikz/']

function reset(overrides = {}) {
  state.doc = overrides.doc === undefined ? null : overrides.doc
  state.findShouldThrow = overrides.findShouldThrow === true
  state.findCalls = 0
  state.collectionCalls = 0
  PortalMenu.resetForTests()
}

test('文档不存在 → 内置三项（与改造前的模板等价）', async () => {
  reset({ doc: null })
  const items = await PortalMenu.items()
  assert.deepStrictEqual(
    items.map(item => item.link),
    BUILTIN_LINKS
  )
  // 改造前这三项就是「只对登录用户显示 + 新开页」
  for (const item of items) {
    assert.strictEqual(item.kind, 'item')
    assert.strictEqual(item.target, '_blank')
    assert.strictEqual(item.visibility, 'logged-in')
  }
})

test('文档存在但 items 为空 → 菜单为空，不回退内置项', async () => {
  reset({ doc: { _id: 'portal', items: [] } })
  assert.deepStrictEqual(await PortalMenu.items(), [])
})

test('items 不是数组 → 内置三项', async () => {
  reset({ doc: { _id: 'portal', items: { kind: 'item' } } })
  const items = await PortalMenu.items()
  assert.deepStrictEqual(
    items.map(item => item.link),
    BUILTIN_LINKS
  )
})

test('读库抛错 → 内置三项且不抛异常；已有缓存时继续用缓存', async () => {
  reset({
    doc: {
      _id: 'portal',
      items: [{ kind: 'item', label: { en: 'A' }, link: '/a' }],
    },
  })
  assert.deepStrictEqual(
    (await PortalMenu.items()).map(item => item.link),
    ['/a']
  )

  // 冷却期内不再打库，即便库已经挂了也返回上次成功的配置
  state.findShouldThrow = true
  PortalMenu.resetForTests()
  const items = await PortalMenu.items()
  assert.deepStrictEqual(
    items.map(item => item.link),
    BUILTIN_LINKS
  )
})

test('单条格式不对只丢那一条，其余照常', async () => {
  reset({
    doc: {
      _id: 'portal',
      items: [
        { kind: 'item', label: { en: 'OK' }, link: '/ok' },
        { kind: 'item', label: { en: 'No link' } },
        { kind: 'item', link: '/no-label' },
        {
          kind: 'item',
          label: { en: 'Bad link' },
          link: 'javascript:alert(1)',
        },
        'not-an-object',
        { kind: 'separator' },
        { kind: 'item', label: { en: 'Tail' }, link: 'https://example.com/x' },
      ],
    },
  })
  const items = await PortalMenu.items()
  assert.deepStrictEqual(
    items.map(item => (item.kind === 'separator' ? 'separator' : item.link)),
    ['/ok', 'separator', 'https://example.com/x']
  )
})

test('kind 别名与 children 推断', () => {
  const items = PortalMenu.normalizeItems([
    { kind: 'sperator' },
    { kind: 'divider' },
    { kind: 'hr' },
    {
      label: { en: 'Group' },
      children: [{ kind: 'item', label: { en: 'A' }, link: '/a' }],
    },
  ])
  assert.deepStrictEqual(
    items.map(item => item.kind),
    ['separator', 'separator', 'separator', 'group']
  )
  assert.strictEqual(items[3].children[0].link, '/a')
})

test('indexOf 按父级下标回填（children 递归）', () => {
  const items = PortalMenu.normalizeItems([
    { kind: 'item', label: { en: 'A' }, link: '/a' },
    {
      kind: 'group',
      label: { en: 'G' },
      children: [
        { kind: 'item', label: { en: 'B' }, link: '/b' },
        { kind: 'item', label: { en: 'C' }, link: '/c' },
      ],
    },
    { kind: 'separator' },
  ])
  assert.deepStrictEqual(
    items.map(item => item.indexOf),
    [0, 1, 2]
  )
  assert.deepStrictEqual(
    items[1].children.map(item => item.indexOf),
    [0, 1]
  )
})

test('缓存：TTL 内只读一次库，reload() 立即重读', async () => {
  reset({
    doc: {
      _id: 'portal',
      items: [{ kind: 'item', label: { en: 'A' }, link: '/a' }],
    },
  })
  await PortalMenu.items()
  await PortalMenu.items()
  await PortalMenu.items()
  assert.strictEqual(state.findCalls, 1)
  assert.strictEqual(state.collectionCalls, 1)

  state.doc = {
    _id: 'portal',
    items: [{ kind: 'item', label: { en: 'B' }, link: '/b' }],
  }
  await PortalMenu.reload()
  assert.deepStrictEqual(
    (await PortalMenu.items()).map(item => item.link),
    ['/b']
  )
  assert.strictEqual(state.findCalls, 2)
})

test('label 取词顺序：精确 → 同基础语言 → 站点默认语言 → en → 第一个非空', () => {
  const label = { en: 'Whiteboard', 'zh-CN': '白板', 'zh-TW': '白板（繁）' }
  assert.strictEqual(PortalMenu.resolveLabel(label, 'zh-TW'), '白板（繁）')
  // 大小写不敏感
  assert.strictEqual(PortalMenu.resolveLabel(label, 'ZH-tw'), '白板（繁）')
  // 只写了基础语言时，zh-CN 请求能命中 'zh' 之外的键 → 落到默认语言
  assert.strictEqual(PortalMenu.resolveLabel(label, 'zh-CN'), '白板')
  // 请求语言没有对应文案 → 站点默认语言（zh-CN），不是英文
  assert.strictEqual(PortalMenu.resolveLabel(label, 'ja'), '白板')
  // 连默认语言都没有 → en
  assert.strictEqual(
    PortalMenu.resolveLabel({ en: 'Only EN' }, 'ja'),
    'Only EN'
  )
  // 只有未知语言 → 第一个非空值（不让导航出现空白项）
  assert.strictEqual(PortalMenu.resolveLabel({ ko: '한국어' }, 'ja'), '한국어')
  // 字符串写法（老格式）原样返回；空对象返回空串
  assert.strictEqual(PortalMenu.resolveLabel('Plain', 'en'), 'Plain')
  assert.strictEqual(PortalMenu.resolveLabel({}, 'en'), '')
  assert.strictEqual(PortalMenu.resolveLabel(null, 'en'), '')
})

test('visibility 拆成 forGuest / forUser，顺序不变', () => {
  const items = PortalMenu.normalizeItems([
    { kind: 'item', label: { en: 'Everywhere' }, link: '/any' },
    {
      kind: 'item',
      label: { en: 'Only guest' },
      link: '/guest',
      visibility: 'logged-out',
    },
    {
      kind: 'item',
      label: { en: 'Only user' },
      link: '/user',
      visibility: 'logged-in',
    },
    { kind: 'separator' },
  ])

  const { forGuest, forUser } = PortalMenu.splitByVisibility(items)
  const links = list => list.map(item => item.link || item.kind)
  assert.deepStrictEqual(links(forGuest), ['/any', '/guest', 'separator'])
  assert.deepStrictEqual(links(forUser), ['/any', '/user', 'separator'])
})

test('group / separator 忽略无关字段；item 只保留白名单字段', () => {
  const [group, separator, item] = PortalMenu.normalizeItems([
    {
      kind: 'group',
      label: { en: 'G' },
      link: '/should-be-ignored',
      target: '_blank',
      children: [],
      somethingElse: 1,
    },
    { kind: 'separator', label: { en: 'ignored' }, link: '/ignored' },
    {
      kind: 'item',
      label: { en: 'I' },
      link: '/i',
      target: '_SELF',
      junk: 'x',
      visibility: 'weird',
    },
  ])
  assert.strictEqual(group.link, undefined)
  assert.strictEqual(group.somethingElse, undefined)
  assert.deepStrictEqual(separator, {
    kind: 'separator',
    indexOf: 1,
    visibility: 'any',
  })
  assert.strictEqual(item.target, '_self') // 小写归一
  assert.strictEqual(item.junk, undefined)
  assert.strictEqual(item.visibility, 'any') // 不认识的 visibility 归 any
})
