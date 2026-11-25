import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import symbols from './data/symbols.json'
import {
  togglePalette,
  useClosePalette,
  usePaletteOpen,
} from '../palette-manager'

/**
 * FIXED: 2026-11-13 符号面板（参考 Overleaf Pro 的 modules/symbol-palette）。
 *
 * Pro 那套是「侧边抽屉 + 分类标签 + 搜索 + **手写识别**」，手写识别带 43MB 的
 * 模型和精灵图（recognition/），跟我们要解决的问题（插一个 \alpha）不成比例，
 * 所以这里只移植**面板本体**：分类、搜索、网格、点击插入。
 *
 * 数据直接沿用 Pro 的 symbols.json（117 条，19KB），字段：
 *   { category, command, codepoint, description, aliases: [], notes }
 *
 * 插入走的是项目里既有的通路：window 上派发 `editor:insert-symbol`，
 * 由 source-editor/extensions/symbol-palette.ts 接收并插入到光标处 ——
 * 也就是说 CodeMirror 那侧一行都不用改。
 */

type SymbolEntry = {
  category: string
  command: string
  codepoint: string
  description?: string
  aliases?: string[]
  notes?: string
}

const SYMBOLS = symbols as SymbolEntry[]

/** 分类顺序按 Pro 的 categories.js：Greek → Arrows → Operators → Relations → Misc */
const CATEGORY_ORDER = ['Greek', 'Arrows', 'Operators', 'Relations', 'Misc']

/**
 * 展示用的字形。
 *
 * codepoint 大多是 Mathematical Alphanumeric Symbols（U+1D6xx），部分字体没有
 * 这些字形，fallback 到 aliases 里的单字符别名（通常就是 α、→ 这种常规码位）。
 */
function glyphOf(entry: SymbolEntry): string {
  const alias = (entry.aliases || []).find(a => [...a].length === 1)
  if (alias) return alias
  try {
    return String.fromCodePoint(parseInt(entry.codepoint.replace('U+', ''), 16))
  } catch {
    return entry.command
  }
}

export default function SymbolPalette() {
  const { t } = useTranslation()
  // 开关统一交给 palette-manager（互斥 + 再点关闭）
  const open = usePaletteOpen('symbol')
  const close = useClosePalette()
  const [category, setCategory] = useState<string>('Greek')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const insert = useCallback((command: string) => {
    window.dispatchEvent(
      new CustomEvent('editor:insert-symbol', { detail: { command } })
    )
  }, [])

  // 打开/关闭：菜单栏的 Ω 按钮和 Ctrl/Cmd+Shift+K 都走同一个事件
  useEffect(() => {
    const onToggle = () => togglePalette('symbol')
    window.addEventListener('fl:toggle-symbol-palette', onToggle)
    return () =>
      window.removeEventListener('fl:toggle-symbol-palette', onToggle)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        event.stopPropagation()
        togglePalette('symbol')
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const categories = useMemo(() => {
    const present = new Set(SYMBOLS.map(s => s.category))
    return CATEGORY_ORDER.filter(c => present.has(c))
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      // 搜索跨全部分类：输入 `sum`、`→`、`mathbb` 都能命中
      return SYMBOLS.filter(entry => {
        const haystack = [
          entry.command,
          entry.description || '',
          ...(entry.aliases || []),
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
    }
    return SYMBOLS.filter(entry => entry.category === category)
  }, [query, category])

  if (!open) return null

  return createPortal(
    <div
      className="fl-symbol-palette-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="fl-symbol-palette"
        role="dialog"
        aria-label={t('symbol_palette_title')}
      >
        <div className="fl-symbol-palette-header">
          <span className="fl-symbol-palette-title">
            {t('symbol_palette_title')}
          </span>
          <input
            ref={inputRef}
            className="fl-symbol-palette-search"
            type="text"
            value={query}
            placeholder={t('symbol_palette_search_placeholder')}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              } else if (event.key === 'Enter' && visible.length > 0) {
                event.preventDefault()
                insert(visible[0].command)
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="fl-symbol-palette-close"
            onClick={close}
            aria-label={t('close')}
          >
            ✕
          </button>
        </div>

        {!query && (
          <div className="fl-symbol-palette-tabs">
            {categories.map(id => (
              <button
                key={id}
                type="button"
                className={`fl-symbol-palette-tab${
                  id === category ? ' active' : ''
                }`}
                onClick={() => setCategory(id)}
              >
                {t(`category_${id.toLowerCase()}`, { defaultValue: id })}
              </button>
            ))}
          </div>
        )}

        <div className="fl-symbol-palette-grid">
          {visible.length === 0 && (
            <div className="fl-symbol-palette-empty">
              {t('symbol_palette_no_results')}
            </div>
          )}
          {visible.map(entry => (
            <button
              key={entry.command + entry.codepoint}
              type="button"
              className="fl-symbol-palette-item"
              title={`${entry.command} — ${entry.description || ''}`}
              onClick={() => insert(entry.command)}
            >
              <span className="fl-symbol-palette-glyph">{glyphOf(entry)}</span>
              <span className="fl-symbol-palette-command">
                {entry.command.replace(/^\\/, '')}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
