import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import getMeta from '../../utils/meta'
import {
  useClosePalette,
  usePaletteOpen,
  togglePalette,
} from '../palette-manager'

/**
 * FIXED: 2026-11-13 项目级全文检索（前端）。
 *
 * 后端：GET /project/:id/search?q=&regexp=&caseSensitive=&wholeWord=
 *       （app/src/Features/ProjectSearch/ProjectSearchController.js）
 * 返回：
 *   { query, totalHits, truncated, files: [{ path, count, hits: [{line, column, length, text}] }] }
 *
 * 和 Overleaf Pro 的差异：Pro 是浏览器下载整份历史快照在本地扫，我们是服务端扫
 * 完只回命中摘要 —— 大项目不用把正文传到前端。功能面（正则 / 大小写 / 全词 /
 * 按文件分组 / 点击跳行）保持一致，两边都不做替换。
 */

type Hit = { line: number; column: number; length: number; text: string }
type MatchedFile = { path: string; count: number; hits: Hit[] }
type SearchResponse = {
  query: string
  totalHits: number
  truncated: boolean
  files: MatchedFile[]
}

export default function ProjectSearch() {
  const { t } = useTranslation()
  const open = usePaletteOpen('search')
  const close = useClosePalette()

  const projectId = useMemo(() => getMeta('ol-project_id'), [])
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regexp, setRegexp] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q || !projectId) {
      setResults(null)
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ q })
      if (caseSensitive) params.set('caseSensitive', '1')
      if (regexp) params.set('regexp', '1')
      if (wholeWord) params.set('wholeWord', '1')

      const response = await fetch(
        `/project/${projectId}/search?${params.toString()}`,
        { signal: controller.signal }
      )
      const body = await response.json()
      if (!response.ok) {
        // 无效正则等 400 走这里，直接把后端文案显示出来
        setError(body?.error || t('project_search_failed'))
        setResults(null)
        return
      }
      setResults(body)
      setCollapsed(new Set())
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(t('project_search_failed'))
        setResults(null)
      }
    } finally {
      setLoading(false)
    }
  }, [query, projectId, caseSensitive, regexp, wholeWord, t])

  // 打开时聚焦并清空上一次的结果提示
  useEffect(() => {
    if (open) {
      setError(null)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } else {
      abortRef.current?.abort()
    }
  }, [open])

  // FIXED: 2026-11-13 Ctrl/Cmd+Shift+F 全项目搜索（菜单里也标了这个键位）。
  // 用 capture 阶段，避免 CodeMirror keymap 先吃掉；全项目里 Shift+F 未被占用。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault()
        event.stopPropagation()
        togglePalette('search')
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const openHit = useCallback(
    (hit: Hit, path: string) => {
      close()
      window.dispatchEvent(
        new CustomEvent('editor:open-file', {
          // EditorManager 收到后会打开文档并跳到 gotoLine
          detail: { name: path, gotoLine: hit.line },
        })
      )
    },
    [close]
  )

  if (!open) return null

  return createPortal(
    <div
      className="fl-project-search-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="fl-project-search"
        role="dialog"
        aria-label={t('menu_project_search')}
      >
        <form
          className="fl-project-search-header"
          onSubmit={event => {
            event.preventDefault()
            runSearch()
          }}
        >
          <input
            ref={inputRef}
            className="fl-project-search-input"
            type="text"
            value={query}
            placeholder={t('project_search_placeholder')}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="submit"
            className="fl-project-search-submit"
            disabled={loading || !query.trim()}
          >
            {t('project_search_search')}
          </button>
          <button
            type="button"
            className="fl-project-search-close"
            onClick={close}
            aria-label={t('close')}
          >
            ✕
          </button>
        </form>

        <div className="fl-project-search-options">
          <label className="fl-project-search-option">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={event => setCaseSensitive(event.target.checked)}
            />
            {t('project_search_case_sensitive')}
          </label>
          <label className="fl-project-search-option">
            <input
              type="checkbox"
              checked={regexp}
              onChange={event => setRegexp(event.target.checked)}
            />
            {t('project_search_regexp')}
          </label>
          <label className="fl-project-search-option">
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={event => setWholeWord(event.target.checked)}
            />
            {t('project_search_whole_word')}
          </label>
          {results && !loading && (
            <span className="fl-project-search-count">
              {results.truncated
                ? t('project_search_count_truncated', { n: results.totalHits })
                : t('project_search_count', { n: results.totalHits })}
            </span>
          )}
          {loading && (
            <span className="fl-project-search-count">
              {t('project_search_searching')}
            </span>
          )}
        </div>

        {error && <div className="fl-project-search-error">{error}</div>}

        <div className="fl-project-search-results">
          {!loading && results && results.files.length === 0 && !error && (
            <div className="fl-project-search-empty">
              {t('project_search_no_results')}
            </div>
          )}
          {results?.files.map(file => {
            const isCollapsed = collapsed.has(file.path)
            return (
              <div className="fl-project-search-file" key={file.path}>
                <button
                  type="button"
                  className="fl-project-search-file-header"
                  onClick={() =>
                    setCollapsed(prev => {
                      const next = new Set(prev)
                      if (next.has(file.path)) next.delete(file.path)
                      else next.add(file.path)
                      return next
                    })
                  }
                >
                  <span className="fl-project-search-caret">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="fl-project-search-path">{file.path}</span>
                  <span className="fl-project-search-file-count">
                    {file.count}
                  </span>
                </button>
                {!isCollapsed &&
                  file.hits.map((hit, index) => {
                    const before = hit.text.slice(0, hit.column - 1)
                    const matched = hit.text.slice(
                      hit.column - 1,
                      hit.column - 1 + hit.length
                    )
                    const after = hit.text.slice(hit.column - 1 + hit.length)
                    return (
                      <button
                        type="button"
                        className="fl-project-search-hit"
                        key={`${file.path}:${hit.line}:${hit.column}:${index}`}
                        onClick={() => openHit(hit, file.path)}
                      >
                        <span className="fl-project-search-line">
                          {hit.line}
                        </span>
                        <span className="fl-project-search-snippet">
                          {before}
                          <mark>{matched}</mark>
                          {after}
                        </span>
                      </button>
                    )
                  })}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
