// 独立运行的冒烟测试：node app/src/Features/AIChat/conversation.test.js
// 只依赖纯函数模块，不连 Mongo/Redis。

const assert = require('assert')
const {
  DEFAULT_CONVERSATION_ID,
  CONVERSATION_ID_PATTERN,
  TITLE_MAX_LENGTH,
  normalizeConversationId,
  isDefaultConversationId,
  conversationMatch,
  deriveTitle,
  titleFromMessage,
  truncateTitle,
  toConversationSummary,
} = require('./conversation')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('AI chat conversation helpers')

check('默认会话 id 就是 default', () => {
  assert.strictEqual(DEFAULT_CONVERSATION_ID, 'default')
})

check('合法 id 原样保留（两端空白被 trim）', () => {
  assert.strictEqual(normalizeConversationId('c_abc-123'), 'c_abc-123')
  assert.strictEqual(normalizeConversationId('  c_abc-123  '), 'c_abc-123')
})

check('非法/缺失 id 一律落到默认会话', () => {
  const bad = [
    undefined,
    null,
    '',
    '   ',
    'has space',
    'a'.repeat(65),
    { $ne: null },
    42,
    0,
    '注入", $where: "1',
    '../../../etc/passwd',
  ]
  for (const value of bad) {
    assert.strictEqual(
      normalizeConversationId(value),
      DEFAULT_CONVERSATION_ID,
      'expected default for ' + JSON.stringify(value)
    )
  }
})

check('只有 default 被视为默认会话', () => {
  assert.strictEqual(isDefaultConversationId('default'), true)
  assert.strictEqual(isDefaultConversationId('c_x'), false)
  assert.strictEqual(isDefaultConversationId(undefined), true)
})

check('默认会话的查询条件兼容老文档（没有这个字段）', () => {
  const match = conversationMatch('default')
  const branches = match.$or
  assert.ok(Array.isArray(branches))
  assert.ok(branches.some(branch => branch.conversationId === 'default'))
  assert.ok(
    branches.some(
      branch => branch.conversationId && branch.conversationId.$exists === false
    )
  )
  // 不能出现 $ne 之类可被注入的操作符
  assert.strictEqual(JSON.stringify(match).includes('$ne'), false)
})

check('非默认会话的查询条件精确匹配', () => {
  assert.deepStrictEqual(conversationMatch('c_1'), { conversationId: 'c_1' })
})

check('标题取第一条用户消息', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: '把第三章的实验数据更新一下' },
    { role: 'user', content: '第二条不该用' },
  ]
  assert.strictEqual(deriveTitle(messages), '把第三章的实验数据更新一下')
})

check('标题压成一行并去掉 markdown 符号', () => {
  assert.strictEqual(
    titleFromMessage({
      role: 'user',
      content: '## 标题\n\n- 第一条\n- 第二条',
    }),
    '标题 第一条 第二条'
  )
})

check('标题超长截断并加省略号', () => {
  const long = '很'.repeat(80)
  const title = truncateTitle(long)
  assert.strictEqual(title.length, TITLE_MAX_LENGTH + 1)
  assert.ok(title.endsWith('…'))
})

check('没有用户消息时标题为空（前端再兜底显示"未命名"）', () => {
  assert.strictEqual(deriveTitle([]), '')
  assert.strictEqual(deriveTitle([{ role: 'assistant', content: 'x' }]), '')
  assert.strictEqual(deriveTitle(null), '')
  assert.strictEqual(titleFromMessage({ role: 'assistant', content: 'x' }), '')
})

check('列表输出不包含 messages', () => {
  const doc = {
    conversationId: 'c_1',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
    ],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
  }
  const summary = toConversationSummary(doc)
  assert.deepStrictEqual(Object.keys(summary).sort(), [
    'conversationId',
    'createdAt',
    'messageCount',
    'title',
    'updatedAt',
  ])
  assert.strictEqual(summary.messageCount, 2)
  assert.strictEqual(summary.title, '你好')
})

check('老文档（没有 conversationId）在列表里显示为默认会话', () => {
  const summary = toConversationSummary({
    messages: [{ role: 'user', content: '老对话' }],
    createdAt: new Date('2026-09-01T00:00:00Z'),
  })
  assert.strictEqual(summary.conversationId, DEFAULT_CONVERSATION_ID)
  assert.strictEqual(summary.title, '老对话')
})

check('已存的标题优先于派生标题', () => {
  const summary = toConversationSummary({
    conversationId: 'c_1',
    title: '手动标题',
    messages: [{ role: 'user', content: '原文' }],
  })
  assert.strictEqual(summary.title, '手动标题')
})

check('messageCount 优先用存下来的计数', () => {
  const summary = toConversationSummary({
    conversationId: 'c_1',
    messageCount: 99,
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.strictEqual(summary.messageCount, 99)
})

check('id 正则本身不接受空串/超长', () => {
  assert.strictEqual(CONVERSATION_ID_PATTERN.test(''), false)
  assert.strictEqual(CONVERSATION_ID_PATTERN.test('a'.repeat(64)), true)
  assert.strictEqual(CONVERSATION_ID_PATTERN.test('a'.repeat(65)), false)
})

console.log(`\n${passed}/${passed} checks passed`)
