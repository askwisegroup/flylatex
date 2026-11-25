/**
 * 给 AI 助手用的「主文件」解析。
 *
 * 现场（2026-11）：项目第一次提问，Agent 回了一段
 *   「项目编译目录不存在 … 请去编辑器里点 Recompile」
 * 而真因往往更靠前一步：**项目没选主文件**（`Project.rootDoc_id` 为空）。
 * 这时 ClsiManager._finaliseRequest 会直接抛 `no main file specified`，
 * 编译根本没开始，编译目录自然也不会出现——两件事被一句
 * 「请你去点一下编译」混在一起，用户既不知道点哪，也不知道点了会怎样。
 *
 * 这个模块负责：
 *   1. 找候选主文件（内容含 `\documentclass`，且扩展名允许当主文件）；
 *   2. 有明确赢家就写进项目设置并广播 rootDocUpdated（编辑器里的主文件下拉框同步），
 *      编译继续跑，Agent 在结论里说明「我顺手把 main.tex 设成主文件了」；
 *   3. 有歧义就不猜：把候选列表交回去，让助手问用户用哪个（再用 set_main_file 落定）。
 *
 * 为什么复用现有实现而不是另写一套识别：
 *   - `DocumentHelper.contentHasDocumentclass` 已经被 uploads / setRootDocAutomatically
 *     用过，正则专门防过「超长行 CPU 打满」；
 *   - `ProjectEntityUpdateHandler.isPathValidForRootDoc` 与 `setRootDoc` 是主文件设置
 *     的唯一入口，手写 Project.updateOne 会漏掉扩展名校验。
 *   差别只在于：`setRootDocAutomatically` 取「第一个」命中项、不报告歧义，
 *   而助手需要知道「这次是不是我猜的」，所以这里额外给出理由和候选列表。
 */
const logger = require('@overleaf/logger')

const ProjectGetter = require('../Project/ProjectGetter')
const ProjectEntityHandler = require('../Project/ProjectEntityHandler')
const ProjectEntityUpdateHandler = require('../Project/ProjectEntityUpdateHandler')
const DocumentHelper = require('../Documents/DocumentHelper')
const EditorRealTimeController = require('../Editor/EditorRealTimeController')
const {
  pickWinner,
  hasBeginDocument,
  summarize,
} = require('./AgentMainFileRanking')

/**
 * 取文档正文。
 * 文档在 Mongo/docupdater 里可能是 lines 数组，也可能是字符串；
 * DocumentHelper.contentHasDocumentclass 两种都能吃（见 _getLinesFromContent）。
 */
function docText(doc) {
  if (!doc) return ''
  if (Array.isArray(doc.lines)) return doc.lines.join('\n')
  if (typeof doc.lines === 'string') return doc.lines
  if (typeof doc.content === 'string') return doc.content
  return ''
}

/**
 * 解析（必要时设置）项目主文件。
 *
 * @param {string} projectId
 * @param {object} [options]
 * @param {boolean} [options.persist=true] 是否把判定结果写进项目设置
 * @returns {Promise<{status: 'ok'|'ambiguous'|'none', rootDocId: ?string,
 *   path: ?string, autoSelected: boolean, reason: string,
 *   candidates: Array<{path: string, hasBeginDocument: boolean}>,
 *   persisted: boolean}>}
 */
async function resolveMainFile(projectId, options = {}) {
  const persist = options.persist !== false
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootDoc_id: 1,
  })
  if (!project) throw new Error('project_not_found')

  // getAllDocs 返回 { path: doc }
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  const pathById = new Map()
  const candidates = []
  for (const [rawPath, doc] of Object.entries(docs || {})) {
    if (!doc || !doc._id) continue
    const docPath = String(rawPath).replace(/^\/+/, '')
    pathById.set(doc._id.toString(), docPath)
    if (!ProjectEntityUpdateHandler.isPathValidForRootDoc(docPath)) continue
    const text = docText(doc)
    if (!DocumentHelper.contentHasDocumentclass(text)) continue
    candidates.push({
      id: doc._id.toString(),
      path: docPath,
      hasBeginDocument: hasBeginDocument(text),
    })
  }

  const currentId = project.rootDoc_id ? project.rootDoc_id.toString() : null
  if (currentId && pathById.has(currentId)) {
    return {
      status: 'ok',
      rootDocId: currentId,
      path: pathById.get(currentId),
      autoSelected: false,
      reason: 'already_set',
      candidates: summarize(candidates),
      persisted: true,
    }
  }

  const { clear, winner, reason } = pickWinner(candidates)
  if (!clear) {
    return {
      status: reason === 'no_candidate' ? 'none' : 'ambiguous',
      rootDocId: null,
      path: null,
      autoSelected: false,
      reason,
      candidates: summarize(candidates.length ? candidates : []),
      persisted: false,
    }
  }

  let persisted = false
  if (persist) {
    try {
      await ProjectEntityUpdateHandler.promises.setRootDoc(projectId, winner.id)
      // 与 EditorController.setRootDoc 一致：让开着的编辑器同步主文件下拉框
      EditorRealTimeController.emitToRoom(
        projectId,
        'rootDocUpdated',
        winner.id
      )
      persisted = true
      logger.info(
        { projectId, rootDocId: winner.id, path: winner.path, reason },
        '[agent-compile] auto-selected main file'
      )
    } catch (err) {
      // 落库失败不算致命：调用方仍然可以用 rootDocId 做单次编译覆盖
      logger.warn(
        { projectId, rootDocId: winner.id, error: err.message },
        '[agent-compile] failed to persist main file'
      )
    }
  }

  return {
    status: 'ok',
    rootDocId: winner.id,
    path: winner.path,
    autoSelected: true,
    reason,
    candidates: summarize(candidates),
    persisted,
  }
}

module.exports = {
  resolveMainFile,
}
