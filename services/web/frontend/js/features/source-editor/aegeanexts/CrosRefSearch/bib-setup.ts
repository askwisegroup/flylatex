/**
 * FIXED: 2026-11-16 参考文献配置探测（从 CrosRefSearch 的组件里抽出来，可单测）。
 *
 * 原来只认 `\bibliography{}`，于是这些真实写法一律被判成「没有 bib」：
 *   · biblatex:            \addbibresource[opts]{./bib/thesis-ref.bib}
 *   · 高校模板 keyval:     \ecnuSetup{ style = { bibResource = {./bib/thesis-ref.bib} } }
 *   · 只写了 \printbibliography
 * 现在四种都认，并且返回**规范化路径**（`bib/thesis-ref.bib`），写盘时按路径定位。
 */

export type BibSetup = {
  /** 有任何一个 BibTeX 数据源就算（不再要求必须是 \bibliography{}） */
  hasBibliography: boolean
  hasBibliographyStyle: boolean
  hasPrintBibliography: boolean
  usesBibTeX: boolean
  /** 规范化路径，例如 ['bib/thesis-ref.bib'] */
  bibFiles: string[]
  /** 去掉目录与 .bib 的名字，例如 ['thesis-ref']（兼容旧调用） */
  bibNames: string[]
}

/** `./bib/x` → `bib/x.bib`；`refs` → `refs.bib`；`a.bib` 原样 */
export function normalizeBibPath(raw: string): string {
  let path = String(raw || '')
    .trim()
    .replace(/^["']|["']$/g, '')
  path = path.replace(/^(\.\/)+/, '')
  if (!/\.bib$/i.test(path)) {
    path = `${path}.bib`
  }
  return path
}

export function detectBibliographySetup(docText: string): BibSetup {
  const text = String(docText || '')
  const found: string[] = []

  // 1) \bibliography{a,b/c}（可多个、可带路径、可带 .bib）
  for (const match of text.matchAll(/\\bibliography\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const value = part.trim()
      if (value) {
        found.push(normalizeBibPath(value))
      }
    }
  }

  // 2) \addbibresource[opts]{path}
  for (const match of text.matchAll(
    /\\addbibresource(?:\[[^\]]*\])?\{([^}]+)\}/g
  )) {
    const value = match[1].trim()
    if (value) {
      found.push(normalizeBibPath(value))
    }
  }

  // 3) 模板 keyval：bibResource = {path}（ECNU / 学位论文模板常见）
  for (const match of text.matchAll(/bibResource\s*=\s*\{([^}]+)\}/g)) {
    const value = match[1].trim()
    if (value) {
      found.push(normalizeBibPath(value))
    }
  }

  const bibFiles = [...new Set(found)]
  const bibNames = [
    ...new Set(
      bibFiles.map(path => {
        const base = path.split('/').pop() || path
        return base.replace(/\.bib$/i, '')
      })
    ),
  ]

  const hasTheBibEnvironment = /\\begin\{thebibliography\}/.test(text)
  const hasPrintBibliography = /\\printbibliography/.test(text)
  const hasBibliographyStyle = /\\bibliographystyle\{/.test(text)

  return {
    hasBibliography:
      bibFiles.length > 0 || hasTheBibEnvironment || hasPrintBibliography,
    hasBibliographyStyle,
    hasPrintBibliography,
    usesBibTeX: bibFiles.length > 0 || hasPrintBibliography,
    bibFiles,
    bibNames: bibNames.length ? bibNames : bibFiles,
  }
}
