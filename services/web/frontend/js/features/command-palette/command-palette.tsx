import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import useScopeValue from '../../shared/hooks/use-scope-value'
import { useCodeMirrorViewContext } from '../source-editor/components/codemirror-editor'
import {
  PaletteItem,
  flattenFiles,
  focusInput,
  fuzzyScore,
  parseLineQuery,
} from './sources'
import {
  togglePalette,
  useClosePalette,
  usePaletteOpen,
} from '../palette-manager'

/**
 * FIXED: 2026-11-13 命令面板（Ctrl/Cmd+K）。
 *
 * 范围（第一版，刻意做小）：
 *   - 文件跳转（模糊匹配项目文件树）
 *   - 跳行（输入 :120 / 行 120）
 *   - 8 条常用命令（编译、AI 面板、批注面板、设置、历史、PDF 显隐/布局）
 *
 * 实现约束：
 *   1. 不碰老代码——只挂到 CodeMirror 的 React 树上（见 codemirror-editor.tsx），
 *      复用现有的 Angular scope 桥（useScopeValue）和全局事件。
 *   2. 打开文件走已有的 `editor:open-file` 事件，和 \include 提示框同一通路。
 *   3. 跳行直接操作 CodeMirror 的 view（本组件就在 CodeMirror context 内）。
 */

// 空查询时列出多少个文件。
// Pro 的做法是 flatFileTree.slice(0, 10)（固定 10 个）；这里按产品要求取 0：
// 没输入 = 用户还不知道要找什么，先把命令摆出来，文件一个都不显示。
// 想改成 Pro 那样，把这个值改成 10 即可。
const DEFAULT_FILE_COUNT = 0
const MAX_RESULTS = 50

export default function CommandPalette() {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()

  // 开关统一交给 palette-manager：互斥 + 「再点一次就关」都在那边保证
  const open = usePaletteOpen('command')
  const close = useClosePalette()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 项目文件树 / 布局状态都来自 Angular scope（已有桥，改完即时同步）
  const [rootFolder] = useScopeValue('rootFolder', true)
  // FileTreeManager.recalculateDocList() 已经把整棵树摊平成 [{ doc, path }]，
  // path 形如 'chapters/intro.tex'，正好是 editor:open-file 要的东西。
  // 优先用它，取不到再自己遍历 rootFolder（兜底）。
  const [scopeDocs] =
    useScopeValue<Array<{ doc: { name?: string }; path: string }>>('docs')
  const [reviewPanelOpen, setReviewPanelOpen] =
    useScopeValue<boolean>('ui.reviewPanelOpen')
  const [pdfOpen, setPdfOpen] = useScopeValue<boolean>('ui.pdfOpen')
  const [pdfLayout, setPdfLayout] = useScopeValue<string>('ui.pdfLayout')
  const [uiView, setUiView] = useScopeValue<string>('ui.view')

  const openFile = useCallback((path: string) => {
    window.dispatchEvent(
      new CustomEvent('editor:open-file', { detail: { name: path } })
    )
  }, [])

  const jumpToLine = useCallback(
    (lineNumber: number) => {
      if (!view) return
      const doc = view.state.doc
      const line = doc.line(Math.min(Math.max(lineNumber, 1), doc.lines))
      view.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true,
      })
      view.focus()
    },
    [view]
  )

  // ---- 命令表 -------------------------------------------------------------
  const commands = useMemo<PaletteItem[]>(
    () => [
      {
        id: 'cmd:compile',
        kind: 'command',
        label: t('command_palette_compile'),
        hint: t('recompile'),
        keywords: 'compile recompile build 编译 重新编译',
        run: () => {
          // 与工具栏「重新编译」同一个事件，走既有编译流程
          window.dispatchEvent(new Event('pdf:recompile'))
        },
      },
      {
        id: 'cmd:ai-panel',
        kind: 'command',
        label: t('ai_assistant'),
        hint: t('command_palette_toggle_ai'),
        keywords: 'ai chat 助手 对话',
        run: () => window.dispatchEvent(new Event('editor:toggle-ai-chat')),
      },
      {
        id: 'cmd:review-panel',
        kind: 'command',
        label: t('review'),
        hint: t('command_palette_toggle_review'),
        keywords: 'review comment 批注 审阅 评论',
        run: () => setReviewPanelOpen(!reviewPanelOpen),
      },
      {
        id: 'cmd:settings',
        kind: 'command',
        label: t('settings'),
        hint: t('command_palette_open_settings'),
        keywords: 'settings preferences 设置 偏好',
        run: () => document.dispatchEvent(new CustomEvent('fl:settings-modal')),
      },
      {
        id: 'cmd:history',
        kind: 'command',
        label: t('history'),
        hint: t('command_palette_toggle_history'),
        keywords: 'history versions 历史 版本',
        run: () => setUiView(uiView === 'history' ? 'editor' : 'history'),
      },
      {
        id: 'cmd:pdf-toggle',
        kind: 'command',
        label: t('command_palette_toggle_pdf'),
        hint: pdfOpen
          ? t('command_palette_hide_pdf')
          : t('command_palette_show_pdf'),
        keywords: 'pdf preview 预览',
        run: () => setPdfOpen(!pdfOpen),
      },
      {
        id: 'cmd:pdf-layout',
        kind: 'command',
        label: t('command_palette_toggle_pdf_layout'),
        hint:
          pdfLayout === 'sideBySide'
            ? t('command_palette_layout_flat')
            : t('command_palette_layout_side'),
        keywords: 'pdf layout 布局 并排',
        run: () =>
          setPdfLayout(pdfLayout === 'sideBySide' ? 'flat' : 'sideBySide'),
      },
    ],
    [
      t,
      reviewPanelOpen,
      setReviewPanelOpen,
      uiView,
      setUiView,
      pdfOpen,
      setPdfOpen,
      pdfLayout,
      setPdfLayout,
    ]
  )

  // ---- 结果计算 -----------------------------------------------------------
  // 语义对齐 Overleaf Pro 的 command-palette（它是 flat list，两个数据源）：
  //   - 空查询：命令 + 前 10 个文件。不做全量罗列 —— 几百个文件全倒出来，
  //     命令就被挤到看不见了，用户还得往下滚。
  //   - 有查询：命令和文件各自打分后混排（Pro 也是混排，不分段）。
  const pathToItem = useCallback(
    (path: string): PaletteItem => {
      const slash = path.lastIndexOf('/')
      return {
        id: `file:${path}`,
        kind: 'file',
        label: slash === -1 ? path : path.slice(slash + 1),
        hint: slash === -1 ? undefined : path.slice(0, slash),
        run: () => openFile(path),
      }
    },
    [openFile]
  )

  const results = useMemo<PaletteItem[]>(() => {
    const q = query.trim()

    // 跳行：输入纯数字时只给一条「跳到第 N 行」
    const lineNumber = parseLineQuery(q)
    if (lineNumber != null) {
      return [
        {
          id: `line:${lineNumber}`,
          kind: 'line',
          label: t('command_palette_jump_to_line', { n: lineNumber }),
          run: () => jumpToLine(lineNumber),
        },
      ]
    }

    const paths =
      Array.isArray(scopeDocs) && scopeDocs.length > 0
        ? scopeDocs.map(entry => entry.path).filter(Boolean)
        : flattenFiles(rootFolder)

    // 空查询：只给命令，不列文件
    if (!q) {
      return [
        ...commands,
        ...paths.slice(0, DEFAULT_FILE_COUNT).map(pathToItem),
      ]
    }

    // 有查询：混排打分
    const hits: Array<{ item: PaletteItem; score: number }> = []
    for (const item of commands) {
      const score = fuzzyScore(
        q,
        `${item.label} ${item.keywords ?? ''} ${item.hint ?? ''}`
      )
      if (score >= 0) hits.push({ item, score })
    }
    for (const path of paths) {
      const score = fuzzyScore(q, path)
      // 文件略微降权：同分时命令（用户主动意图）优先
      if (score >= 0) hits.push({ item: pathToItem(path), score: score - 10 })
    }

    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map(entry => entry.item)
  }, [query, commands, scopeDocs, rootFolder, t, jumpToLine, pathToItem])

  // 结果变了，选中项回到第一条
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // ---- 快捷键 -------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl/Cmd+K 打开/关闭。用 capture 阶段，避免被 CodeMirror 的
      // keymap 先吃掉（CodeMirror 默认没有 Mod-k 绑定，但留个保险）。
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        event.stopPropagation()
        togglePalette('command')
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // 每次打开都重置查询和选中项，不残留上一次的输入
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  // 打开后聚焦输入框
  useEffect(() => {
    if (open) {
      // 等 portal 挂载完成再聚焦
      const timer = window.setTimeout(() => focusInput(inputRef), 0)
      return () => window.clearTimeout(timer)
    }
  }, [open])

  // 选中项滚动到可视区
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const runActive = useCallback(() => {
    const item = results[activeIndex]
    if (!item) return
    close()
    // 延迟到下一帧执行：避免命令里打开弹窗/移动焦点时与本组件的卸载打架
    window.setTimeout(() => item.run(), 0)
  }, [results, activeIndex, close])

  const onInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(index =>
          results.length === 0 ? 0 : (index + 1) % results.length
        )
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(index =>
          results.length === 0
            ? 0
            : (index - 1 + results.length) % results.length
        )
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        runActive()
      }
    },
    [close, results.length, runActive]
  )

  if (!open) return null

  return createPortal(
    <div
      className="cm-command-palette-backdrop"
      // 点遮罩关闭（和搜索面板一致；命令面板不是模态，不该逼用户按 Esc）
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
      role="presentation"
    >
      <div
        className="cm-command-palette"
        role="dialog"
        aria-label={t('command_palette_placeholder')}
      >
        <input
          ref={inputRef}
          className="cm-command-palette-input"
          type="text"
          value={query}
          placeholder={t('command_palette_placeholder')}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="cm-command-palette-results" ref={listRef}>
          {results.length === 0 && (
            <div className="cm-command-palette-empty">
              {t('command_palette_no_results')}
            </div>
          )}
          {results.map((item, index) => (
            <div
              key={item.id}
              data-index={index}
              className={`cm-command-palette-item${
                index === activeIndex ? ' active' : ''
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={event => {
                // 阻止输入框失焦，否则遮罩的 mousedown 会先关掉面板
                event.preventDefault()
                close()
                window.setTimeout(() => item.run(), 0)
              }}
            >
              <span className="cm-command-palette-label">{item.label}</span>
              {item.hint && (
                <span className="cm-command-palette-hint">{item.hint}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
