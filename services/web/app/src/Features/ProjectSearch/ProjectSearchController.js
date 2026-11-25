const { expressify } = require('@overleaf/promise-utils')
const logger = require('@overleaf/logger')
const ProjectEntityHandler = require('../Project/ProjectEntityHandler')

/**
 * FIXED: 2026-11-13 项目级全文检索（后端实现）。
 *
 * 为什么放在后端而不是照抄 Overleaf Pro：
 *   Pro 是「浏览器先把整个项目的历史快照下下来，再用 CodeMirror 的搜索游标
 *   逐个文件扫」。那套依赖 web 端所没有的 infrastructure/project-snapshot.ts
 *   和 overleaf-editor-core 的浏览器侧封装，还要把全部 blob 拉到前端。
 *   我们这边 ProjectEntityHandler.getAllDocs() 已经能把「路径 → 逐行内容」
 *   一次拿全（docstore 的 /project/:id/doc 是批量接口），在服务端扫一遍就行，
 *   前端只负责展示，大项目也不用传数据。
 *
 * 结果只带「行号 + 列号 + 长度 + 该行文本」，不返回整个文件内容。
 */

const MAX_FILE_HITS = 50 // 单个文件最多返回多少条命中
const MAX_TOTAL_HITS = 500 // 一次请求最多返回多少条命中
const MAX_LINE_CHARS = 400 // 每行最多回传多少字符（超出就截断并居中到命中处）
const MAX_QUERY_LENGTH = 500

/** 把用户输入编译成一个「逐行扫描」用的匹配器 */
function buildMatcher({ q, regexp, caseSensitive, wholeWord }) {
  let source = q
  if (!regexp) {
    // 字面量模式：把正则元字符转义掉
    source = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  if (wholeWord) {
    // 用 lookaround 表达全词匹配，这样不会吃掉分隔符、列号也不会偏
    source = `(?<![\\w])(?:${source})(?![\\w])`
  }
  const flags = caseSensitive ? 'g' : 'gi'
  try {
    return new RegExp(source, flags)
  } catch (error) {
    const err = new Error('无效的正则表达式')
    err.status = 400
    err.detail = error.message
    throw err
  }
}

/** 把过长的一行截断到命中处附近，返回 {text, column} */
function lineWindow(line, matchIndex, matchLength) {
  if (line.length <= MAX_LINE_CHARS) {
    return { text: line, column: matchIndex + 1 }
  }
  // 以命中为中心开一个窗口
  const half = Math.floor((MAX_LINE_CHARS - matchLength) / 2)
  const start = Math.max(0, matchIndex - Math.max(half, 0))
  const end = Math.min(line.length, start + MAX_LINE_CHARS)
  return {
    text: line.slice(start, end),
    column: matchIndex - start + 1,
  }
}

/**
 * 在 getAllDocs() 的结果上跑一遍。
 * 逐行扫描而不是整篇扫：多行正则（比如 \begin{x}[\s\S]*?\end{x}）不支持，
 * 但换来的是行号/列号天然准确、大文件也不会卡。
 */
function searchDocs(docs, { q, regexp, caseSensitive, wholeWord }) {
  const matcher = buildMatcher({ q, regexp, caseSensitive, wholeWord })
  const files = []
  let totalHits = 0
  let truncated = false

  // 按路径排序，保证结果稳定（getAllDocs 返回的是对象，键序不可依赖）
  const paths = Object.keys(docs).sort((a, b) => a.localeCompare(b))

  for (const path of paths) {
    const lines = docs[path].lines || []
    const hits = []

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]
      if (!line) continue

      // 每行单独编译 matchAll，避免 lastIndex 在行之间残留
      matcher.lastIndex = 0
      for (const match of line.matchAll(matcher)) {
        if (match[0].length === 0) continue // 防御：(?:) 之类的空匹配
        const { text, column } = lineWindow(line, match.index, match[0].length)
        hits.push({
          line: lineIndex + 1,
          column,
          length: match[0].length,
          text,
        })
        if (hits.length >= MAX_FILE_HITS) {
          truncated = true
          break
        }
      }
      if (hits.length >= MAX_FILE_HITS) break
    }

    if (hits.length > 0) {
      files.push({ path, count: hits.length, hits })
      totalHits += hits.length
      if (totalHits >= MAX_TOTAL_HITS) {
        truncated = true
        break
      }
    }
  }

  return { query: q, totalHits, truncated, files }
}

const ProjectSearchController = {
  search: expressify(async function search(req, res) {
    const projectId = req.params.Project_id || req.params.project_id
    const q = (req.query.q || '').toString().slice(0, MAX_QUERY_LENGTH)
    const regexp = req.query.regexp === '1' || req.query.regexp === 'true'
    const caseSensitive =
      req.query.caseSensitive === '1' || req.query.caseSensitive === 'true'
    const wholeWord =
      req.query.wholeWord === '1' || req.query.wholeWord === 'true'

    if (!q.trim()) {
      return res.json({ query: q, totalHits: 0, truncated: false, files: [] })
    }

    const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)

    let result
    try {
      result = searchDocs(docs, { q, regexp, caseSensitive, wholeWord })
    } catch (error) {
      // 无效正则：直接告诉前端，不要写 500
      if (error.status === 400) {
        return res.status(400).json({ error: error.message, detail: error.detail })
      }
      throw error
    }

    logger.debug(
      { projectId, q, totalHits: result.totalHits },
      'project search completed'
    )
    res.json(result)
  }),
}

module.exports = ProjectSearchController
module.exports.searchDocs = searchDocs // 导出给单测用
