/**
 * 个人知识库接口层检查
 *
 * FIXED: 2026-11-10 新增文件。
 *
 * 这个脚本钉死的是「四套消费者共用一份能力」这件事本身。
 * 最容易悄悄坏掉的方式是：有人在 http 层里顺手加了一段检索逻辑，
 * 于是 Agent 能搜到、MCP 搜不到 —— 线上表现为「同一个知识库，两种结果」。
 *
 * Run: cd services/web && node scripts/checks/personal-kb.check.js
 */
'use strict'

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '../..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log('  \u2713 ' + name)
  } catch (err) {
    failures.push(name)
    console.error('  \u2717 ' + name + '\n    ' + err.message)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const KB = 'commercial/personal-kb'
const facadeSrc = read(KB + '/index.js')
const mcpSrc = read(KB + '/mcp.js')
const skillsSrc = read(KB + '/skills.js')
const routerSrc = read('app/src/Features/KnowledgeBase/KnowledgeBaseRouter.js')

// 门面层必须提供的五个能力 + 状态 + 写路径钩子
const CAPABILITIES = [
  'refreshKnowledgeBase',
  'listKnowledge',
  'searchKnowledge',
  'readKnowledge',
  'citeKnowledge',
  'getKnowledgeStats',
  'markKnowledgeDirty',
]

console.log('\n=== 个人知识库 ===')

check('门面层导出五个能力 + 状态 + 写路径钩子', () => {
  for (const name of CAPABILITIES) {
    assert(facadeSrc.indexOf(name) !== -1, '门面层缺少 ' + name)
  }
})

check('门面层永不抛异常：统一返回 { ok, data, error }', () => {
  assert(/return \{ ok: true, data: data, error: null \}/.test(facadeSrc), '缺少 ok() 构造器')
  assert(/ok: false,/.test(facadeSrc), '缺少 fail() 构造器')
  // 每个对外能力都应包 try/catch（否则 knows 库挂了会带崩 Agent 对话）
  const fnCount = (facadeSrc.match(/^async function /gm) || []).length
  const tryCount = (facadeSrc.match(/\} catch \(e\) \{/g) || []).length
  assert(tryCount >= fnCount - 2, 'catch 块太少（' + tryCount + ' vs ' + fnCount + ' 个函数），可能有能力没兜异常')
})

check('门面层不直接碰 HTTP：没有 req/res/next 参数', () => {
  assert(!/\b(req|res)\b\s*[,)\.]/.test(facadeSrc), '门面层出现 req/res，说明 http 关注点泄漏进来了')
  assert(!/require\('express'\)/.test(facadeSrc), '门面层不应依赖 express')
})

check('索引存储失败时有降级路径（不是直接报错）', () => {
  assert(/degraded/.test(facadeSrc), '缺少 degraded 降级标记')
  assert(/try \{\s*index = await store\.loadIndex/.test(facadeSrc), 'loadIndex 未被 try/catch 保护')
})

check('MCP 适配层：6 个工具，全部带 kb_ 前缀且 schema 完整', () => {
  const names = (mcpSrc.match(/name: TOOL_PREFIX \+ '(\w+)'/g) || []).map(s => s.replace(/.*'(\w+)'.*/, '$1'))
  assert(names.length >= 6, 'MCP 工具数不足：' + names.length)
  for (const n of ['list', 'search', 'read', 'cite', 'refresh', 'stats']) {
    assert(names.indexOf(n) !== -1, 'MCP 缺少 kb_' + n)
  }
  assert(/inputSchema/.test(mcpSrc), 'MCP 工具缺少 inputSchema')
})

check('MCP / SKILLS 都复用门面，不自己实现检索', () => {
  for (const [label, src] of [['mcp.js', mcpSrc], ['skills.js', skillsSrc]]) {
    assert(/require\('\.\/index'\)/.test(src), label + ' 没有 require 门面层')
    assert(!/searchIndex|buildIndex|bm25|BM25/i.test(src), label + ' 里出现了检索实现，应当只做转发')
  }
})

check('SKILLS 的 action 与 MCP 工具一一对应', () => {
  const skillActions = (skillsSrc.match(/^      name: '(\w+)',/gm) || []).map(s => s.replace(/.*'(\w+)'.*/, '$1'))
  const mcpNames = (mcpSrc.match(/name: TOOL_PREFIX \+ '(\w+)'/g) || []).map(s => s.replace(/.*'(\w+)'.*/, '$1'))
  for (const n of mcpNames) {
    assert(skillActions.indexOf(n) !== -1, 'SKILLS 缺少与 kb_' + n + ' 对应的 action')
  }
})

check('两种认证复用同一套 KEY（desktop_sync_keys），不新造密钥', () => {
  assert(/DesktopSyncAuth\.requireApiKey/.test(routerSrc), 'HTTP 层没有复用 DesktopSyncAuth.requireApiKey')
  assert(!/KnowledgeKey|kb_keys|knowledge_keys/.test(routerSrc), '出现了新的密钥体系，应当复用 desktop_sync_keys')
})

check('HTTP 层只是适配器：没有检索/索引实现', () => {
  assert(!/searchIndex|buildIndex|markDirty|bm25/i.test(routerSrc), 'HTTP 层出现了业务逻辑，应只转发门面层')
  assert(/loadKb\(\)/.test(routerSrc), 'HTTP 层没有调用门面层')
})

check('HTTP 路由已挂载进 router.js', () => {
  const routerJs = read('app/src/router.js')
  assert(/KnowledgeBaseRouter\.apply/.test(routerJs), 'router.js 没有挂载 KnowledgeBaseRouter')
})

check('写路径钩子存在且被 try/catch 保护', () => {
  const handler = read('app/src/Features/Project/ProjectEntityUpdateHandler.js')
  assert(/markKnowledgeDirty/.test(handler), 'ProjectEntityUpdateHandler 没有标记脏')
  const idx = handler.indexOf('markKnowledgeDirty')
  assert(/try\s*\{/.test(handler.slice(Math.max(0, idx - 700), idx)), 'markKnowledgeDirty 没有被 try/catch 保护')
})

check('知识库各层测试文件齐全', () => {
  for (const f of ['structure', 'indexer', 'store', 'search', 'index', 'dirty']) {
    assert(fs.existsSync(path.join(root, KB, f + '.test.js')), '缺少 ' + f + '.test.js')
  }
})

console.log('')
if (failures.length > 0) {
  console.error('FAILED (' + failures.length + '): ' + failures.join(' | '))
  process.exit(1)
}
console.log('ALL PASS')

