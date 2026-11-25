/**
 * DesktopSyncCitations - 给 Agent 用的「检索 → 写入引用」闭环
 *
 * FIXED: 2026-11-11 新增文件。
 *
 * 背景（这也是 Agent 长期最弱的一环）：
 *   1. 能搜到文献（search_literature），但**搜完就没法落地**：
 *      没有工具能生成 .bib、也没法往正文里插 \cite{} / \bibitem。
 *   2. 前端其实早就有完整实现（CrosRefSearch/index.tsx），
 *      但它绑死在浏览器（Web session + CSRF + CodeMirror view），
 *      Agent 用 Bearer Key 完全够不到。
 *   3. updateBibFile（crosrefsearch.js:974）是 Web 登录态 + CSRF 才能调，
 *      而且要 userEmail，Agent 手上没有 session 里的这些东西。
 *
 * 本文件把「前端那套规则」搬到服务端，供 Agent 直接调用：
 *   POST /api/sync/project/:id/cite
 *
 * 两种模式（与前端行为保持一致，不是新发明的规则）：
 *   - bibtex 模式：项目里有 \bibliography{xxx} → 生成 .bib 条目，
 *     并按作者+年份生成 cite key（同名同年加 hash 后缀去重）
 *   - bibitem 模式：项目里没有 \bibliography → 直接往 tex 里写
 *     \begin{thebibliography} ... \bibitem{key} ... \end{thebibliography}
 *
 * 设计约束（照抄前端，因为这是被用户验证过的行为）：
 *   - 只要出现 \bibliography，**绝不**降级成 bibitem（否则编译报重复定义）
 *   - .bib 里已存在的 key 不重复写，返回 duplicateCount 让 Agent 知道
 *   - 正文里插 \cite 时，key 用的是真实写进 bib 的那个 key（可能带 hash 后缀）
 */

const path = require('path')
const { expressify } = require('@overleaf/promise-utils')
const logger = require('@overleaf/logger')

const SessionManager = require('../Authentication/SessionManager')
const ProjectGetter = require('../Project/ProjectGetter')
const ProjectEntityHandler = require('../Project/ProjectEntityHandler')
const EditorController = require('../Editor/EditorController')
const Errors = require('../Errors/Errors')

const SOURCE = 'ai-agent-cite'

// \bibliography{a,b,c} / \bibliography{refs}；也认 biblatex 的 \addbibresource
const BIBLIOGRAPHY_RE = /\\bibliography\s*\{([^}]*)\}/
const ADDBIBRESOURCE_RE = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/
// 已有的 \cite{a,b} / \citep{a} / \citet{a} / \cite[...]{a}
const CITE_RE = /\\cite[a-zA-Z]*\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/
const BIBITEM_RE = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/

/**
 * 从项目所有文本文件里找 \bibliography / \addbibresource。
 * 返回 { hasBibliography, bibFileNames[], sourceFile } —— sourceFile 是命中的那个 tex。
 */
function detectBibliographySetup(docsByPath) {
  for (const [docPath, doc] of docsByPath) {
    const text = doc.text || (doc.lines || []).join('\n')
    const bibMatch = text.match(BIBLIOGRAPHY_RE)
    if (bibMatch) {
      return {
        hasBibliography: true,
        bibFileNames: bibMatch[1]
          .split(',')
          .map(name => name.trim())
          .filter(Boolean)
          .map(name => (name.endsWith('.bib') ? name : `${name}.bib`)),
        sourceFile: docPath,
        directive: 'bibliography',
      }
    }
    const addMatch = text.match(ADDBIBRESOURCE_RE)
    if (addMatch) {
      return {
        hasBibliography: true,
        bibFileNames: addMatch[1]
          .split(',')
          .map(name => name.trim())
          .filter(Boolean)
          .map(name => (name.endsWith('.bib') ? name : `${name}.bib`)),
        sourceFile: docPath,
        directive: 'addbibresource',
      }
    }
  }
  return {
    hasBibliography: false,
    bibFileNames: [],
    sourceFile: null,
    directive: null,
  }
}

/** 把作者数组格式化成 BibTeX 的 "A and B and C" */
function formatBibAuthors(authors) {
  if (!Array.isArray(authors)) {
    return typeof authors === 'string' ? authors : ''
  }
  return authors
    .map(author =>
      typeof author === 'string' ? author : author && author.name
    )
    .filter(Boolean)
    .join(' and ')
}

/** 把作者数组格式化成正文里的人类可读形式："A, B, C" */
function formatHumanAuthors(authors) {
  if (!Array.isArray(authors)) {
    return typeof authors === 'string' ? authors : ''
  }
  return authors
    .map(author =>
      typeof author === 'string' ? author : author && author.name
    )
    .filter(Boolean)
    .join(', ')
}

/**
 * 生成 cite key：作者姓 + 年份（前端同款规则，见 CrosRefSearch/index.tsx:770-790）。
 *
 * 为什么不用 DOI / hash 当 key：用户是要把 \cite{key} 写进正文的，
 * `zhang2024` 比 `a3f9c2e1` 可读也可推断。
 *
 * 同名同年撞 key 时用 BibTeX 界的通行写法加字母后缀（he2016a / he2016b），
 * 而不是前端那种截 hash 尾部 3 位 —— 后者会得到 `he2016_arB` 这种
 * 大小写混杂、无法从 key 反推次序的东西。
 */
function makeCiteKey(item, siblings) {
  const authorText = formatHumanAuthors(item.authors)
  const firstAuthor = authorText.split(',')[0].trim()
  const lastName = firstAuthor.split(' ').pop() || ''
  const cleanLastName = lastName.replace(/[^a-zA-Z]/g, '').toLowerCase()
  const year = item.year || ''

  if (!cleanLastName) {
    // 没有可用作者名：退回上游 id 或标题首词，保证 key 合法且非空
    const fallback =
      (item.providerId &&
        String(item.providerId).replace(/[^a-zA-Z0-9]/g, '')) ||
      String(item.title || 'ref')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 12)
        .toLowerCase() ||
      'ref'
    return `${fallback}${year}`
  }

  const base = `${cleanLastName}${year}`
  const sameNameYear = siblings.filter(other => {
    const otherAuthor = formatHumanAuthors(other.authors)
    const otherFirst = otherAuthor.split(',')[0].trim()
    const otherLast = (otherFirst.split(' ').pop() || '')
      .replace(/[^a-zA-Z]/g, '')
      .toLowerCase()
    return otherLast === cleanLastName && other.year === year
  })
  if (sameNameYear.length > 1) {
    // 用本条在这组里的位次换算成 a/b/c...（超过 26 条退化为 a1/a2）
    const index = sameNameYear.indexOf(item)
    const position = index === -1 ? 0 : index
    const letter =
      position < 26 ? String.fromCharCode(97 + position) : `a${position - 25}`
    return `${base}${letter}`
  }
  return base
}

/**
 * 生成单条 BibTeX。类型按 item.type 猜，字段只写有值的 ——
 * 空字段在 BibTeX 里不是错误，但会让用户以为信息缺失，能省就省。
 */
function makeBibtexEntry(item, citeKey) {
  const type = /journal/i.test(item.type || '')
    ? 'article'
    : /conference|proceedings/i.test(item.type || '')
    ? 'inproceedings'
    : 'misc'

  const fields = []
  const authors = formatBibAuthors(item.authors)
  if (authors) fields.push(`  author = {${authors}}`)
  if (item.title) fields.push(`  title = {${item.title}}`)
  if (item.venue) {
    fields.push(
      type === 'inproceedings'
        ? `  booktitle = {${item.venue}}`
        : `  journal = {${item.venue}}`
    )
  }
  if (item.year) fields.push(`  year = {${item.year}}`)
  if (item.doi) fields.push(`  doi = {${item.doi}}`)
  if (item.url) fields.push(`  url = {${item.url}}`)

  return `@${type}{${citeKey},\n${fields.join(',\n')}\n}`
}

/** 生成 \bibitem 条目（thebibliography 环境里的形态） */
function makeBibitem(item, citeKey) {
  const authors = formatHumanAuthors(item.authors)
  const title = item.title || ''
  const venue = item.venue ? `\\textit{${item.venue}}` : ''
  const year = item.year || ''
  const tail = [venue, year].filter(Boolean).join(', ')
  const head = [authors, title].filter(Boolean).join('. ')
  return `\\bibitem{${citeKey}}\n${head}${tail ? `. ${tail}` : ''}.`
}

/** 从已有 .bib 内容里抽出所有已存在的 key */
function extractBibKeys(bibContent) {
  const keys = new Set()
  const re = /@\w+\s*\{\s*([^,\s}]+)\s*,/g
  let match
  while ((match = re.exec(bibContent)) !== null) {
    keys.add(match[1])
  }
  return keys
}

/** 从 tex 里抽出已在 thebibliography 里定义过的 \bibitem key */
function extractBibitemKeys(texText) {
  const keys = new Set()
  const re = new RegExp(BIBITEM_RE.source, 'g')
  let match
  while ((match = re.exec(texText)) !== null) {
    keys.add(match[1].trim())
  }
  return keys
}

/** 从 tex 里抽出已经 \cite 过的 key，避免同一批重复插入命令 */
function extractCitedKeys(texText) {
  const keys = new Set()
  const re = new RegExp(CITE_RE.source, 'g')
  let match
  while ((match = re.exec(texText)) !== null) {
    for (const key of match[1].split(',')) {
      keys.add(key.trim())
    }
  }
  return keys
}

/**
 * 在 tex 里插入 \cite{...}。
 *
 * 不指定位置时插到 \end{document} 之前（比插到文件最末尾安全：
 * 末尾之后的内容不会被排版，用户会以为没生效）。
 */
function insertCiteCommand(texText, citeKeys, anchor) {
  const citeCommand = `\\cite{${citeKeys.join(',')}}`

  if (anchor && texText.includes(anchor)) {
    // 有锚点：插在锚点所在行之后，方便用户马上看到
    const index = texText.indexOf(anchor)
    const lineEnd = texText.indexOf('\n', index)
    const insertAt = lineEnd === -1 ? texText.length : lineEnd + 1
    return {
      text:
        texText.slice(0, insertAt) +
        `${citeCommand}\n` +
        texText.slice(insertAt),
      insertedAt: insertAt,
      citeCommand,
    }
  }

  const endDoc = texText.lastIndexOf('\\end{document}')
  const insertAt = endDoc === -1 ? texText.length : endDoc
  const needsNewline =
    insertAt > 0 && !texText.slice(0, insertAt).endsWith('\n')
  return {
    text:
      texText.slice(0, insertAt) +
      `${needsNewline ? '\n' : ''}${citeCommand}\n\n` +
      texText.slice(insertAt),
    insertedAt: insertAt,
    citeCommand,
  }
}

/**
 * 往 thebibliography 里追加 \bibitem 条目。
 * 已有环境就插在 \end{thebibliography} 前；没有就在 \end{document} 前建一个。
 */
function insertBibitems(texText, bibitemText) {
  const endBib = texText.lastIndexOf('\\end{thebibliography}')

  if (endBib !== -1) {
    const before = texText.slice(0, endBib)
    const needsNewline = before.length > 0 && !before.endsWith('\n')
    return (
      texText.slice(0, endBib) +
      `${needsNewline ? '\n' : ''}${bibitemText}\n\n` +
      texText.slice(endBib)
    )
  }

  const endDoc = texText.lastIndexOf('\\end{document}')
  const block = `\n% Bibliography\n\\begin{thebibliography}{99}\n${bibitemText}\n\\end{thebibliography}\n`
  if (endDoc === -1) {
    return `${texText}\n${block}`
  }
  return texText.slice(0, endDoc) + block + texText.slice(endDoc)
}

/**
 * 读出项目里的**源文件**文本。
 *
 * 只读 .tex/.bib/.txt/.md/.cls/.sty 这类纯文本 doc：docstore 里图片等
 * 二进制内容是 fileRefs 不是 docs，但用户也可能把大文件塞成 doc，
 * 全量读会把一次引用写入拖成 N 次 docstore 往返。
 */
const TEXT_DOC_EXTS = new Set([
  '.tex',
  '.bib',
  '.bst',
  '.txt',
  '.md',
  '.cls',
  '.sty',
])

async function readProjectDocs(projectId) {
  const { docs } = await ProjectEntityHandler.promises.getAllEntities(projectId)
  const target = docs.filter(entity =>
    TEXT_DOC_EXTS.has(path.extname(entity.path).toLowerCase())
  )

  const byPath = new Map()
  // 并发读，但要限流：一个项目可能有几十个 tex，全并发打 docstore 不合适
  const CONCURRENCY = 5
  for (let i = 0; i < target.length; i += CONCURRENCY) {
    const batch = target.slice(i, i + CONCURRENCY)
    const loaded = await Promise.all(
      batch.map(async entity => {
        const content = await ProjectEntityHandler.promises.getDoc(
          projectId,
          entity.doc._id
        )
        const lines = (content && content.lines) || []
        return {
          path: entity.path,
          _id: entity.doc._id,
          lines,
          text: lines.join('\n'),
        }
      })
    )
    for (const doc of loaded) {
      byPath.set(doc.path, doc)
    }
  }
  return byPath
}

/**
 * POST /api/sync/project/:project_id/cite
 *
 * body:
 *   {
 *     references: [LiteratureItem...],   // search_literature 的 results 直接塞进来
 *     texFile: "main.tex",               // 可选，插 \cite 的目标；缺省用根文档
 *     anchor: "\\section{Intro}",        // 可选，插在含该锚点的行之后
 *     mode: "auto" | "bib" | "bibitem",  // 默认 auto（按项目现状判断）
 *     bibFile: "refs.bib",               // 可选，bib 模式下指定写入哪个 .bib
 *     dryRun: true                       // 可选，只看会写什么，不落盘
 *   }
 */
const cite = expressify(async function cite(req, res) {
  const projectId = req.params.project_id
  const userId = SessionManager.getLoggedInUserId(req.session)
  const body = req.body || {}

  const references = Array.isArray(body.references) ? body.references : []
  if (references.length === 0) {
    return res.status(400).json({
      error:
        'references is required (pass the results from search_literature directly)',
    })
  }
  if (references.length > 50) {
    return res.status(400).json({ error: 'at most 50 references per call' })
  }

  const project = await ProjectGetter.promises.getProject(projectId, {
    name: 1,
    rootDoc_id: 1,
  })
  if (!project) {
    throw new Errors.NotFoundError('project not found')
  }

  const docsByPath = await readProjectDocs(projectId)
  const detected = detectBibliographySetup(docsByPath)

  // 模式判定：auto 时跟随项目现状（这是前端写过注释强调的设计规则）
  let mode = body.mode === 'bib' || body.mode === 'bibitem' ? body.mode : 'auto'
  if (mode === 'auto') {
    mode = detected.hasBibliography ? 'bib' : 'bibitem'
  }
  if (mode === 'bibitem' && detected.hasBibliography) {
    // 强制保护：有 \bibliography 还写 bibitem 会编译报重复定义
    return res.status(400).json({
      error:
        'project uses \\bibliography, so bibitem mode would produce duplicate references; use mode="bib"',
      detected,
    })
  }

  // --- 决定要写哪个 tex（插 \cite 的位置）---
  let texPath = body.texFile
  if (!texPath && project.rootDoc_id) {
    for (const [docPath, doc] of docsByPath) {
      if (String(doc._id) === String(project.rootDoc_id)) {
        texPath = docPath
        break
      }
    }
  }
  if (!texPath && detected.sourceFile) {
    texPath = detected.sourceFile
  }
  if (!texPath) {
    // 没根文档也没 \bibliography：挑第一个 .tex，至少保证能插进去
    texPath = [...docsByPath.keys()].find(p => p.endsWith('.tex')) || null
  }
  if (!texPath) {
    return res.status(400).json({
      error: 'no .tex file found in project; specify texFile explicitly',
    })
  }
  const texDoc = docsByPath.get(texPath)
  if (!texDoc) {
    return res.status(404).json({
      error: `tex file not found: ${texPath}`,
      availableFiles: [...docsByPath.keys()],
    })
  }

  // --- 生成 cite key（同一批里同名同年要带后缀，所以整批一起算）---
  const citeKeys = []
  const seenKeys = new Set()
  for (const item of references) {
    let key = makeCiteKey(item, references)
    // 极端情况下两条完全同源会撞 key，兜底加序号，不能生成重复 \bibitem
    let suffix = 2
    while (seenKeys.has(key)) {
      key = `${makeCiteKey(item, references)}_${suffix++}`
    }
    seenKeys.add(key)
    citeKeys.push(key)
  }

  const result = {
    mode,
    texFile: texPath,
    citeKeys,
    detected,
    wrote: {},
  }

  if (mode === 'bib') {
    // 选 .bib 文件：显式指定 > \bibliography 里的第一个 > refs.bib
    const bibFileName =
      body.bibFile || detected.bibFileNames[0] || 'references.bib'
    const bibPath = bibFileName.startsWith('/')
      ? bibFileName
      : `/${bibFileName}`
    const existingBib = docsByPath.get(bibPath)

    const existingKeys = existingBib
      ? extractBibKeys(existingBib.text)
      : new Set()

    const newEntries = []
    const skipped = []
    references.forEach((item, index) => {
      const key = citeKeys[index]
      if (existingKeys.has(key)) {
        skipped.push(key)
        return
      }
      newEntries.push(makeBibtexEntry(item, key))
      existingKeys.add(key)
    })

    const existingText = existingBib ? existingBib.text : ''
    const mergedText = newEntries.length
      ? existingText.trim()
        ? `${existingText.trim()}\n\n${newEntries.join('\n\n')}\n`
        : `${newEntries.join('\n\n')}\n`
      : existingText

    result.bibFile = bibPath
    result.wrote.bib = {
      path: bibPath,
      created: !existingBib,
      addedCount: newEntries.length,
      duplicateCount: skipped.length,
      skippedKeys: skipped,
    }

    if (!body.dryRun && newEntries.length > 0) {
      const bibLines = mergedText.split('\n')
      const saved = await EditorController.promises.upsertDocWithPath(
        projectId,
        bibPath,
        bibLines,
        SOURCE,
        userId
      )
      result.wrote.bib.docId = String(saved.doc._id)
    }

    // .bib 有了，正文只需插 \cite
    const { text: newTexText, citeCommand } = insertCiteCommand(
      texDoc.text,
      citeKeys,
      body.anchor
    )
    result.citeCommand = citeCommand
    result.wrote.tex = { path: texPath, inserted: citeCommand }

    if (!body.dryRun) {
      const texLines = newTexText.split('\n')
      const savedTex = await EditorController.promises.upsertDocWithPath(
        projectId,
        texPath,
        texLines,
        SOURCE,
        userId
      )
      result.wrote.tex.docId = String(savedTex.doc._id)
      // 编译器要知道 bib 存在，否则第一次编译不会跑 bibtex
      result.nextSteps = [
        'run compile; if citations show as [?] run compile twice (bibtex pass)',
      ]
    }
  } else {
    // bibitem 模式：参考文献直接写进 tex
    // 已存在的 \bibitem 不再重复写（否则 thebibliography 里出现两条一模一样的条目）
    const existingBibitemKeys = extractBibitemKeys(texDoc.text)
    const freshRefs = references.filter(
      (item, index) => !existingBibitemKeys.has(citeKeys[index])
    )
    const freshKeys = citeKeys.filter(key => !existingBibitemKeys.has(key))

    const bibitemText = freshRefs
      .map((item, index) => makeBibitem(item, freshKeys[index]))
      .join('\n\n')

    const withBibitems = bibitemText
      ? insertBibitems(texDoc.text, bibitemText)
      : texDoc.text

    // 已 \cite 过的 key 不再插命令（否则正文里出现两遍同样的引用）
    const alreadyCited = extractCitedKeys(texDoc.text)
    const keysToCite = citeKeys.filter(key => !alreadyCited.has(key))
    const { text: newTexText, citeCommand } = keysToCite.length
      ? insertCiteCommand(withBibitems, keysToCite, body.anchor)
      : { text: withBibitems, citeCommand: null }

    result.citeCommand = citeCommand
    result.wrote.tex = {
      path: texPath,
      inserted: citeCommand,
      bibitems: freshRefs.length,
      duplicateCount: citeKeys.length - freshKeys.length,
      alreadyCited: citeKeys.length - keysToCite.length,
    }

    if (!body.dryRun) {
      const texLines = newTexText.split('\n')
      const savedTex = await EditorController.promises.upsertDocWithPath(
        projectId,
        texPath,
        texLines,
        SOURCE,
        userId
      )
      result.wrote.tex.docId = String(savedTex.doc._id)
      result.nextSteps = [
        'run compile to verify thebibliography renders without errors',
      ]
    }
  }

  logger.info(
    { projectId, userId, mode, texPath, count: citeKeys.length },
    'agent wrote citations into project'
  )

  if (body.dryRun) {
    result.dryRun = true
    result.note = 'dryRun: nothing was written'
  }

  res.json(result)
})

module.exports = {
  cite,
  // 导出给单测
  _internals: {
    detectBibliographySetup,
    makeCiteKey,
    makeBibtexEntry,
    makeBibitem,
    extractBibKeys,
    extractBibitemKeys,
    extractCitedKeys,
    insertCiteCommand,
    insertBibitems,
    formatBibAuthors,
    formatHumanAuthors,
  },
}
