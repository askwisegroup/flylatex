/**
 * DesktopSyncLiterature - Bearer Key 侧的文献检索入口
 *
 * FIXED: 2026-11-11 新增文件。
 *
 * 为什么需要它：
 *   search_literature 这个工具只存在于 Web-Agent（commercial/ai-agent.js），
 *   走的是浏览器 session。用 Bearer Key 的 skill / CLI 完全拿不到检索能力，
 *   于是「搜文献 → 写引用」这条链路在 Agent 侧是断的：
 *   没有检索就没法拿到 references，也就没法喂给 DesktopSyncCitations。
 *
 * 这里把 literature-search/index.js 的 searchLiterature 直接暴露出来。
 * 它本身已经是多 Provider 门面（CrossRef 全球库 + NE 个人库），
 * 不需要重写合并/去重规则 —— 那套逻辑已经在里面了。
 *
 * 注意：个人库（region=person）依赖 session 里的 carsiEmail/email，
 * DesktopSyncAuth 注入的 light user 带这两个字段，所以也能用。
 */

const { expressify } = require('@overleaf/promise-utils')
const SessionManager = require('../Authentication/SessionManager')

// literature-search 依赖 ai-agent 一侧的约定，懒加载避免循环依赖
// （与 KnowledgeBaseRouter 里 require('../../../../commercial/personal-kb') 同一思路）
let searchLiteratureModule = null
function getSearchLiterature() {
  if (!searchLiteratureModule) {
    searchLiteratureModule = require('../../../../commercial/literature-search')
  }
  return searchLiteratureModule.searchLiterature
}

/**
 * GET /api/sync/literature/search?query=...&field=title&region=global&page=1&page_size=10
 * 也支持 POST（body 里参数更长的关键词更安全）
 */
const search = expressify(async function search(req, res) {
  const params = req.method === 'POST' ? req.body || {} : req.query || {}

  const query = typeof params.query === 'string' ? params.query.trim() : ''
  if (!query) {
    return res.status(400).json({ error: 'query is required' })
  }

  const searchLiterature = getSearchLiterature()
  const result = await searchLiterature(
    {
      session: req.session,
      userId: SessionManager.getLoggedInUserId(req.session),
    },
    {
      query,
      field: params.field,
      region: params.region,
      yearFrom: params.year_from ?? params.yearFrom,
      yearTo: params.year_to ?? params.yearTo,
      page: params.page,
      pageSize: params.page_size ?? params.pageSize,
      docType: params.doc_type ?? params.docType,
    }
  )

  // 提示 Agent 下一步能直接干什么 —— 否则它拿到 results 也不知道怎么落地
  result.nextSteps = [
    'pass results straight into POST /api/sync/project/:project_id/cite {"references": results}',
    'use dryRun:true first if you want to preview the .bib / \\cite before writing',
  ]

  res.json(result)
})

module.exports = { search }
