/**
 * FIXED: 2026-11-13 命令面板（Ctrl/Cmd+K）的数据与匹配逻辑。
 *
 * 为什么自建而不是移植 Overleaf Pro 的 command-palette：
 *   Pro 那套（673 行）依赖 React IDE 的 context（ide-react/context/*、
 *   layout-context、file-tree-data-context），我们这套是 Angular IDE + 局部
 *   React，直接搬要拖一堆适配层。这里只保留它的**交互模型**：
 *   一个输入框 + 分组结果（文件 / 命令 / 跳行）+ 键盘导航。
 *
 * 刻意保持无依赖：不引入 minisearch（Pro 用的），用二三十行的打分函数，
 * 项目文件量级（几百个）完全够。以后真需要再换。
 */

export type PaletteItemKind = 'file' | 'command' | 'line'

export type PaletteItem = {
  /** 全局唯一，用作 React key */
  id: string
  kind: PaletteItemKind
  /** 列表主文案 */
  label: string
  /** 右侧灰字：文件显示路径，命令显示说明 */
  hint?: string
  /** 额外参与匹配的文本（例如文件路径、拼音缩写） */
  keywords?: string
  run: () => void
}

/**
 * 打分：>0 命中，越大越靠前；-1 未命中。
 *
 * 优先级：前缀命中 > 词边界命中（/ . - 空格之后）> 中间命中 > 子序列命中。
 * 子序列命中是「打缩写」的场景（如 main 匹配 main.tex 里的 m-t）。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()

  const index = t.indexOf(q)
  if (index === 0) {
    // 完全前缀：短名字优先（避免 a.tex 排在 appendix-long-name.tex 后面）
    return 1000 - Math.min(text.length, 200)
  }
  if (index > 0) {
    const prev = t[index - 1]
    const onBoundary =
      prev === '/' || prev === '.' || prev === '-' || prev === ' '
    return (onBoundary ? 700 : 500) - Math.min(index, 200)
  }

  // 子序列：query 的字符按顺序出现即可
  let cursor = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, cursor)
    if (found === -1) return -1
    gaps += found - cursor
    cursor = found + 1
  }
  return 200 - Math.min(gaps, 200)
}

/**
 * 把项目文件树拍平成「完整路径」列表。
 *
 * 项目里有**两种**树结构，这里都要吃：
 *
 * 1) Angular 侧 $scope.rootFolder（FileTreeManager._parseFolder 产出）：
 *      { name, id, type: 'folder' | 'doc' | 'file', children: [...] }
 * 2) React 侧 / socket 原始结构：
 *      { _id, name, docs: [], folders: [], fileRefs: [] }
 *
 * 第一版只处理了第 2 种，结果在 Angular 编辑器里永远拿到空数组，
 * 命令面板搜文件一个都搜不出来。
 */
export function flattenFiles(folder: any, prefix = ''): string[] {
  if (!folder) return []
  const out: string[] = []

  // 1) Angular 结构：children + type
  if (Array.isArray(folder.children)) {
    for (const child of folder.children) {
      if (!child?.name) continue
      if (child.type === 'folder') {
        out.push(...flattenFiles(child, `${prefix}${child.name}/`))
      } else if (!child.deleted) {
        out.push(prefix + child.name)
      }
    }
    return out
  }

  // 2) React / socket 结构
  for (const doc of folder.docs || []) {
    if (doc?.name) out.push(prefix + doc.name)
  }
  for (const fileRef of folder.fileRefs || []) {
    if (fileRef?.name) out.push(prefix + fileRef.name)
  }
  for (const sub of folder.folders || []) {
    if (sub?.name) out.push(...flattenFiles(sub, `${prefix}${sub.name}/`))
  }

  return out
}

/**
 * 识别「跳到第 N 行」的输入。
 * 支持：`:120`、`120`、`行 120`、`l120`、`line 120`。
 * 只在纯数字/带前缀的数字时生效，避免和文件名冲突（如 2024.tex）。
 */
export function parseLineQuery(query: string): number | null {
  const q = query.trim()
  const match = q.match(/^(?::|l|line|行)?\s*(\d{1,6})$/i)
  if (!match) return null
  const line = parseInt(match[1], 10)
  return line > 0 ? line : null
}

/** 输入框自动聚焦并把光标放到末尾 */
export function focusInput(inputRef: { current: HTMLInputElement | null }) {
  const el = inputRef.current
  if (!el) return
  el.focus()
  const end = el.value.length
  el.setSelectionRange(end, end)
}
