/**
 * FIXED: 2026-11-18 AI 面板输入框的「/ 指定 MCP 服务」
 *
 * 用户自己接了远程 MCP（公司知识库、代码检索…），经常希望「这一轮就用某个服务」，
 * 而不是让模型在所有 MCP + 本地工具里自己挑。这里和 @ 文件同一套交互：
 * 在输入框敲 `/` → 列出**有效（启用中）**的服务 → 选中后插入 `/服务名 `，
 * 请求里带 focusMcpServers，后端只注入那个服务的工具。
 *
 * 这里只做纯逻辑（不碰 DOM、不碰网络，方便单测）。
 */

export type McpServerOption = {
  id: string
  name: string
}

/** `/` 后面的查询词最长多长就放弃提示（多半是在写路径/正常文本） */
const MAX_QUERY_CHARS = 60

/** 候选最多展示几条 */
export const MAX_MCP_CANDIDATES = 8

const isSpace = (ch: string) => ch === '' || /\s/.test(ch)

/**
 * 光标前是不是一个正在输入的 `/查询词`。
 *
 * 规则和 @ 一致：从光标往前扫到空白为止，途中遇到 `/` 且它前面是空白（或行首）才算。
 * 这样 `chapters/main.tex`、`\input{a/b}`、`http://x` 里的 `/` 都不会弹菜单。
 */
export function getSlashQuery(
  text: string,
  caret: number
): { start: number; query: string } | null {
  if (caret <= 0 || typeof text !== 'string') return null
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i])) {
    if (text[i] === '/') {
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
 * 过滤 MCP 服务候选：前缀优先，其次包含；同分时短名字优先。
 */
export function filterMcpServers(
  servers: McpServerOption[],
  query: string,
  limit: number = MAX_MCP_CANDIDATES
): McpServerOption[] {
  const q = (query || '').trim().toLowerCase()
  if (!q) return servers.slice(0, limit)

  const scored: Array<{ server: McpServerOption; score: number }> = []
  for (const server of servers) {
    const name = String(server.name || '').toLowerCase()
    const id = String(server.id || '').toLowerCase()
    let score = -1
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (id === q) score = 3
    else if (id.startsWith(q)) score = 4
    if (score >= 0) scored.push({ server, score })
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.server.name.length - b.server.name.length ||
      a.server.name.localeCompare(b.server.name)
  )
  return scored.slice(0, limit).map(item => item.server)
}

/**
 * 从文本里去掉某个 `/服务名`（点掉 chip 时同步清文本）。
 * 与 `@路径` 的处理一致：顺手收掉多余空格。
 */
export function removeSlashToken(text: string, name: string): string {
  const token = `/${name}`
  return text
    .split(token)
    .join(' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trimStart()
}
