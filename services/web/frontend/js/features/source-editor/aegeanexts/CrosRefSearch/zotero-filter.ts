/**
 * FIXED: 2026-11-17 Zotero 条目的「内存过滤」。
 *
 * 为什么放前端做：Zotero 的 metadata 一条只有几百字节，选中分类后一次拉 200 条
 * （上限见 ZoteroApiClient.LIST_MAX_ITEMS）在本地筛，比每敲一个字就向
 * api.zotero.org 发一次请求快得多，也让「改一个字母」不再产生网络依赖。
 *
 * 为什么抽成纯函数：这段逻辑要能单测（见 test/frontend/.../zotero-filter.test.ts），
 * 组件里（CrosRefSearch/index.tsx）只留一行 useMemo 调用。
 */

/**
 * 归一化：大小写、全角半角、连续空白。
 * 中文没有分词问题（子串匹配即可），英文把全角「ＡＢＣ」与半角「ABC」当同一个。
 */
export function normalizeFilter(value: any): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, ch =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/\s+/g, ' ')
    .trim()
}

/** 一条 Zotero 条目参与匹配的文本（与结果表里展示的字段一致） */
export function itemHaystack(item: any): string {
  if (!item) {
    return ''
  }
  return normalizeFilter(
    [
      (item.title_text && item.title_text[0]) || item.title || '',
      (item.authors || []).join(' '),
      item.year || '',
      (item.container_title_text && item.container_title_text[0]) || '',
      item.abstract_text || item.abstract || '',
    ].join(' ')
  )
}

/**
 * 多词按空格拆，**每个词都要命中**（与 AND 一致）。
 * 空查询 = 不过滤（返回原数组，保持引用相等，避免无谓的重渲染）。
 */
export function filterZoteroItems(items: any[], query: string): any[] {
  const list = Array.isArray(items) ? items : []
  const tokens = normalizeFilter(query).split(' ').filter(Boolean)
  if (!tokens.length) {
    return list
  }
  return list.filter(item => {
    const haystack = itemHaystack(item)
    return tokens.every(token => haystack.includes(token))
  })
}
