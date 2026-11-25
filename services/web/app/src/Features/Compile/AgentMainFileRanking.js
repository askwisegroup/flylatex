/**
 * 「主文件」候选的排序与选优（纯函数，可脱离 Mongo/Redis 单测）。
 *
 * 见 AgentMainFileResolver.js 的说明：没设主文件时 CLSI 会直接抛
 * no main file specified，编译根本没开始。这里决定「什么时候可以替用户
 * 定下来、什么时候必须先问」——所以单独成文件，便于钉回归测试。
 */

// 惯例名：人们给主文件起的名字。命中且唯一时可以直接定，不必问用户。
// 顺序即优先级（main.tex 最常见）。
const PREFERRED_NAMES = [
  'main.tex',
  'paper.tex',
  'thesis.tex',
  'dissertation.tex',
  'manuscript.tex',
  'document.tex',
  'report.tex',
  'article.tex',
  'book.tex',
  'proposal.tex',
]

// 候选列表回给模型时的上限（多了模型读不完，也没意义）
const MAX_CANDIDATES = 8

function basename(docPath) {
  return String(docPath || '')
    .split('/')
    .pop()
    .toLowerCase()
}

/** 是否含 \begin{document}（真正的正文起点；子文件/宏包不会有） */
function hasBeginDocument(text) {
  return /\\begin\s*\{\s*document\s*\}/.test(text)
}

/**
 * 候选排序（纯函数，便于单测）：
 *   1. 有 \begin{document} 的优先（含 documentclass 但没有正文的多半是样式文件）；
 *   2. 惯例名优先；
 *   3. 目录层级浅的优先（主文件通常在根目录）；
 *   4. 名字字典序，保证结果稳定。
 */
function rankCandidates(candidates) {
  const preferredIndex = item => {
    const index = PREFERRED_NAMES.indexOf(basename(item.path))
    return index < 0 ? PREFERRED_NAMES.length + 1 : index
  }
  return [...candidates].sort((a, b) => {
    if (a.hasBeginDocument !== b.hasBeginDocument) {
      return a.hasBeginDocument ? -1 : 1
    }
    const ai = preferredIndex(a)
    const bi = preferredIndex(b)
    if (ai !== bi) return ai - bi
    const ad = String(a.path).split('/').length
    const bd = String(b.path).split('/').length
    if (ad !== bd) return ad - bd
    return String(a.path).localeCompare(String(b.path))
  })
}

/**
 * 选出主文件（纯函数）。
 *
 * @returns {{clear: boolean, winner: object|null, reason: string, candidates: object[]}}
 *   reason: only_candidate | only_document_environment | conventional_name |
 *           ambiguous | no_candidate
 */
function pickWinner(rawCandidates) {
  const candidates = rankCandidates(rawCandidates || [])
  if (candidates.length === 0) {
    return { clear: false, winner: null, reason: 'no_candidate', candidates }
  }
  const top = candidates[0]
  if (candidates.length === 1) {
    return { clear: true, winner: top, reason: 'only_candidate', candidates }
  }
  const withBegin = candidates.filter(item => item.hasBeginDocument)
  if (top.hasBeginDocument && withBegin.length === 1) {
    return {
      clear: true,
      winner: top,
      reason: 'only_document_environment',
      candidates,
    }
  }
  const topName = basename(top.path)
  if (top.hasBeginDocument && PREFERRED_NAMES.includes(topName)) {
    const sameName = candidates.filter(item => basename(item.path) === topName)
    if (sameName.length === 1) {
      return { clear: true, winner: top, reason: 'conventional_name', candidates }
    }
  }
  return { clear: false, winner: null, reason: 'ambiguous', candidates }
}

function summarize(candidates) {
  return (candidates || []).slice(0, MAX_CANDIDATES).map(item => ({
    path: item.path,
    hasBeginDocument: item.hasBeginDocument === true,
  }))
}

module.exports = {
  PREFERRED_NAMES,
  MAX_CANDIDATES,
  basename,
  hasBeginDocument,
  rankCandidates,
  pickWinner,
  summarize,
}
