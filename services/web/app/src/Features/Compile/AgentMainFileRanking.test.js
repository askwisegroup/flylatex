// 独立运行的冒烟测试：node app/src/Features/Compile/AgentMainFileResolver.test.js
// 只测纯函数（排序 / 选优），不连 Mongo / Redis / CLSI。
//
// 背景（2026-11）：项目没设主文件时 CLSI 直接抛 no main file specified，
// 编译根本没开始，Agent 却回「项目编译目录不存在，请你自己去点 Recompile」。
// 这里的规则决定「什么时候可以替用户定主文件、什么时候必须先问」。

const assert = require('assert')
const {
  rankCandidates,
  pickWinner,
  hasBeginDocument,
  PREFERRED_NAMES,
} = require('./AgentMainFileRanking')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const make = (path, hasBeginDocument) => ({ path, hasBeginDocument })

console.log('agent main file resolver')

check('\\begin{document} 能被识别（含空格/换行的写法）', () => {
  assert.equal(hasBeginDocument('\\begin{document}'), true)
  assert.equal(hasBeginDocument('\\begin { document }'), true)
  assert.equal(hasBeginDocument('% \\begin{document} 注释里的'), true) // 宁可多认
  assert.equal(hasBeginDocument('\\begin{abstract}'), false)
})

check('有 \\begin{document} 的排在只含 documentclass 的前面', () => {
  const ranked = rankCandidates([
    make('styles/template.cls.tex', false),
    make('chapters/intro.tex', true),
  ])
  assert.equal(ranked[0].path, 'chapters/intro.tex')
})

check('惯例名优先：main.tex 胜过 abc.tex', () => {
  const ranked = rankCandidates([make('abc.tex', true), make('main.tex', true)])
  assert.equal(ranked[0].path, 'main.tex')
  assert.equal(PREFERRED_NAMES[0], 'main.tex')
})

check('名字一样时，目录浅的优先', () => {
  const ranked = rankCandidates([
    make('old/main.tex', true),
    make('main.tex', true),
  ])
  assert.equal(ranked[0].path, 'main.tex')
})

check('只有一个候选：直接定下来', () => {
  const { clear, winner, reason } = pickWinner([make('paper.tex', true)])
  assert.equal(clear, true)
  assert.equal(winner.path, 'paper.tex')
  assert.equal(reason, 'only_candidate')
})

check('只有一个带 \\begin{document}：直接定下来', () => {
  // 另一份只是含 \documentclass 的样式/宏包文件
  const { clear, winner, reason } = pickWinner([
    make('macros.sty.tex', false),
    make('thesis.tex', true),
  ])
  assert.equal(clear, true)
  assert.equal(winner.path, 'thesis.tex')
  assert.equal(reason, 'only_document_environment')
})

check('唯一命中惯例名：直接定下来（不用麻烦用户）', () => {
  const { clear, winner, reason } = pickWinner([
    make('chapters/a.tex', true),
    make('main.tex', true),
  ])
  assert.equal(clear, true)
  assert.equal(winner.path, 'main.tex')
  assert.equal(reason, 'conventional_name')
})

check('多个非惯例候选：不猜，交给用户选', () => {
  const { clear, winner, reason, candidates } = pickWinner([
    make('chapters/intro.tex', true),
    make('chapters/method.tex', true),
  ])
  assert.equal(clear, false)
  assert.equal(winner, null)
  assert.equal(reason, 'ambiguous')
  assert.equal(candidates.length, 2)
})

check('没有候选：status 交给调用方当成 none', () => {
  const { clear, winner, reason } = pickWinner([])
  assert.equal(clear, false)
  assert.equal(winner, null)
  assert.equal(reason, 'no_candidate')
})

check('两个同名 main.tex（不同目录）：有歧义，不猜', () => {
  const { clear, reason } = pickWinner([
    make('main.tex', true),
    make('old/main.tex', true),
  ])
  // 目录浅的排前面，但「同名多份」不足以证明哪份是当前主文件
  assert.equal(clear, false)
  assert.equal(reason, 'ambiguous')
})

console.log(`\n${passed} checks passed`)
