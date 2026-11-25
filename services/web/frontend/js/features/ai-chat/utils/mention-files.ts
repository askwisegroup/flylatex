/**
 * FIXED: 2026-11-17 AI 面板输入框的「@ 指定文件」
 *
 * 用户反馈：修某个具体文件时，希望只让 Agent 看那一个文件，不要遍历整个项目。
 * 这里负责三件纯事（不碰 DOM、不碰网络，方便单测）：
 *   1. collectMentionFiles —— 从文件树里收集可提及的文件路径
 *   2. getMentionQuery     —— 判断光标前是不是刚敲了 `@`
 *   3. filterMentionFiles  —— 按输入过滤 + 排序候选
 *
 * 为什么用「纯路径字符串」而不是富文本 token：
 *   输入框是普通 <textarea>，插入 `@chapters/intro.tex ` 后用户还能继续编辑；
 *   真正的文件清单另存一份 state（发送时用），所以即使用户手改文本也不会漏文件。
 */

export type MentionFile = {
  /** 相对路径，例如 chapters/intro.tex */
  path: string
  /** 文件名，例如 intro.tex */
  name: string
  /**
   * doc  = 项目里的文档（可编译、可在编辑器里改）
   * file = 上传的文件（fileRef：只读，Agent 首次访问时会自动转成 doc）
   *
   * FIXED: 2026-11-18 以前 fileRef 一律不进 @ 候选，导致项目里既有的 .md/.txt
   * （2026-11-08 之前上传的，被内容嗅探误判成二进制）永远 @ 不到。
   */
  source?: 'doc' | 'file'
}

/** 单条消息最多 @ 多少个文件（后端同一口径，见 editor-context.js） */
export const MAX_MENTION_FILES = 8

/** 候选列表最多展示几条 */
export const MAX_MENTION_CANDIDATES = 8

/**
 * FIXED: 2026-11-18 @ 可选的文件类型（白名单，小写、带点）。
 *
 * 需求给的列表：tex, sty, cls, def, cfg, clo, fd, dtx, ins, ltx,
 *               bib, bst, bbx, cbx, lbx, ist, ldf, md, txt, rst
 *
 * 为什么用白名单：文件树里的 doc 可以取任意名字（用户能在网页里新建任何文件），
 * 以前是「所有 doc 都进候选」，@ 出来的列表里混着图片、日志、编译产物。
 * AI 只该被指向「能读、且读来有意义」的文本源文件。
 *
 * 注意：这份列表只控制「@ 能选什么」，不等于「Agent 能写什么」——
 * 可写范围另有 PROJECT_SOURCE_EXTS（见 overleaf-ne-login/ai-agent.js），两者别混用。
 */
export const MENTION_FILE_EXTS = [
  // LaTeX 主文档 / 宏包 / 类文件
  '.tex',
  '.sty',
  '.cls',
  '.def',
  '.cfg',
  '.clo',
  '.fd',
  '.dtx',
  '.ins',
  '.ltx',
  // 参考文献与排版样式（BibTeX / BibLaTeX / makeindex）
  '.bib',
  '.bst',
  '.bbx',
  '.cbx',
  '.lbx',
  '.ist',
  '.ldf',
  // 纯文本类文档
  '.md',
  '.txt',
  '.rst',
]

const MENTION_FILE_EXT_SET = new Set(MENTION_FILE_EXTS)

/** 取扩展名（小写、带点）；没有扩展名或以点开头的隐藏文件返回空串 */
export function fileExtOf(name: string): string {
  const text = String(name || '')
  const dot = text.lastIndexOf('.')
  return dot > 0 ? text.slice(dot).toLowerCase() : ''
}

/** 这个文件名是否在 @ 白名单里（大小写不敏感） */
export function isMentionableFile(name: string): boolean {
  return MENTION_FILE_EXT_SET.has(fileExtOf(name))
}

/** `@` 后面这个查询词最长多长就放弃提示（多半是在写邮箱/正常文本） */
const MAX_QUERY_CHARS = 80

type TreeDoc = { name?: string }
type TreeFolder = {
  name?: string
  docs?: TreeDoc[]
  fileRefs?: TreeDoc[]
  folders?: TreeFolder[]
}

/**
 * 收集文件树里可提及的文件（只收 doc，且必须命中 MENTION_FILE_EXTS 白名单）。
 * 上传的二进制（fileRefs：图片 / PDF / 压缩包）不给 @：模型读不了它们的内容，
 * 提了等于噪声；doc 里扩展名不在白名单里的（.png/.log/.aux 等）同样排除。
 */
export function collectMentionFiles(fileTreeData: unknown): MentionFile[] {
  const out: MentionFile[] = []
  const walk = (folder: TreeFolder | undefined | null, prefix: string) => {
    if (!folder || typeof folder !== 'object') return
    for (const doc of folder.docs || []) {
      const name = doc?.name
      if (!name) continue
      // FIXED: 2026-11-18 只列白名单内的文本源文件
      if (!isMentionableFile(name)) continue
      out.push({ path: prefix ? `${prefix}/${name}` : name, name, source: 'doc' })
    }
    // FIXED: 2026-11-18 上传文件（fileRef）里属于文本源文件的也列出来。
    // 后端会在 Agent 第一次访问时把它原地转成 doc（读 filestore → 建 doc → 删 fileRef），
    // 所以 @ 了就能读、能改；二进制（pdf/png/...）仍然不列。
    for (const file of folder.fileRefs || []) {
      const name = file?.name
      if (!name) continue
      if (!isMentionableFile(name)) continue
      out.push({
        path: prefix ? `${prefix}/${name}` : name,
        name,
        source: 'file',
      })
    }
    for (const child of folder.folders || []) {
      const name = child?.name
      if (!name) continue
      walk(child, prefix ? `${prefix}/${name}` : name)
    }
  }
  walk(fileTreeData as TreeFolder, '')
  // 同一路径 doc 与 file 同时出现（fileRef→doc 转换的一瞬间）时只保留 doc
  const byPath = new Map()
  for (const item of out) {
    const existing = byPath.get(item.path)
    if (!existing || (existing.source === 'file' && item.source === 'doc')) {
      byPath.set(item.path, item)
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

const isSpace = (ch: string) => ch === '' || /\s/.test(ch)

/**
 * 光标前是不是一个正在输入的 `@查询词`。
 * 返回 `@` 的位置与查询词；不在 mention 上下文里返回 null。
 *
 * 规则：从光标往前扫到空白为止，途中遇到 `@` 且 `@` 前面是空白（或行首）才算。
 * 这样 `a@b.com` 这类邮箱不会弹出文件列表。
 */
export function getMentionQuery(
  text: string,
  caret: number
): { start: number; query: string } | null {
  if (caret <= 0 || typeof text !== 'string') return null
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i])) {
    if (text[i] === '@') {
      const before = i > 0 ? text[i - 1] : ''
      if (!isSpace(before)) return null
      if (caret - i - 1 > MAX_QUERY_CHARS) return null
      return { start: i, query: text.slice(i + 1, caret) }
    }
    i--
  }
  return null
}

/**
 * 过滤候选。打分思路（分数越小越靠前）：
 *   完全等于路径/文件名 → 前缀匹配路径 → 前缀匹配文件名 → 文件名包含 → 路径包含
 * 同分时短路径优先（`main.tex` 比 `sections/main.tex` 更可能是目标）。
 */
export function filterMentionFiles(
  files: MentionFile[],
  query: string,
  limit: number = MAX_MENTION_CANDIDATES
): MentionFile[] {
  const q = (query || '').trim().toLowerCase()
  if (!q) return files.slice(0, limit)

  const scored: Array<{ file: MentionFile; score: number }> = []
  for (const file of files) {
    const path = file.path.toLowerCase()
    const name = file.name.toLowerCase()
    let score = -1
    if (path === q) score = 0
    else if (name === q) score = 1
    else if (path.startsWith(q)) score = 2
    else if (name.startsWith(q)) score = 3
    else if (name.includes(q)) score = 4
    else if (path.includes(q)) score = 5
    if (score >= 0) scored.push({ file, score })
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.file.path.length - b.file.path.length ||
      a.file.path.localeCompare(b.file.path)
  )
  return scored.slice(0, limit).map(item => item.file)
}

/**
 * 从文本里去掉某个 `@路径`（用户点掉 chip 时同步清文本）。
 * 顺手收掉多余空格，免得留下 "，  " 这种。
 */
export function removeMentionToken(text: string, path: string): string {
  const token = `@${path}`
  return text
    .split(token)
    .join(' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\n/g, '\n')
}
