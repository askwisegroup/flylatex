import {
  createContext,
  ElementType,
  memo,
  useContext,
  useRef,
  useState,
} from 'react'
import useIsMounted from '../../../shared/hooks/use-is-mounted'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import CodeMirrorView from './codemirror-view'
import CodeMirrorSearch from './codemirror-search'
import { CodeMirrorToolbar } from './codemirror-toolbar'
import { CodemirrorOutline } from './codemirror-outline'
import { CodeMirrorCommandTooltip } from './codemirror-command-tooltip'
import { dispatchTimer } from '../../../infrastructure/cm6-performance'
import CodeMirrorAIChat from './codemirror-ai-chat'

import importOverleafModules from '../../../../macros/import-overleaf-module.macro'
import { FigureModal } from './figure-modal/figure-modal'
import ReviewPanel from './review-panel/review-panel'
import CommandPalette from '../../command-palette/command-palette'
import SymbolPalette from '../../symbol-palette/symbol-palette'
import ProjectSearch from '../../project-search/project-search'
// FIXED: 2026-11-16 多文件页签（portal 到 CM 的 top panel）+ 选区旁的浮动「加批注」
import EditorTabsBar from '../../editor-tabs/editor-tabs-bar'
import CommentBar from '../../comment-bar/comment-bar'
import getMeta from '../../../utils/meta'
import { useIdeContext } from '@/shared/context/ide-context'

const sourceEditorComponents = importOverleafModules(
  'sourceEditorComponents'
) as { import: { default: ElementType }; path: string }[]

function CodeMirrorEditor() {
  // create the initial state
  const [state, setState] = useState(() => {
    return EditorState.create()
  })

  const isMounted = useIsMounted()
  const isReviewPanelReact = getMeta('ol-isReviewPanelReact')
  const { isReactIde } = useIdeContext()

  // create the view using the initial state and intercept transactions
  const viewRef = useRef<EditorView | null>(null)
  if (viewRef.current === null) {
    const timer = dispatchTimer()

    const view = new EditorView({
      state,
      dispatchTransactions: trs => {
        timer.start(trs)
        view.update(trs)
        if (isMounted.current) {
          setState(view.state)
        }
        timer.end(trs, view)
      },
    })
    viewRef.current = view
  }

  return (
    <CodeMirrorStateContext.Provider value={state}>
      <CodeMirrorViewContextProvider value={viewRef.current}>
        <CodemirrorOutline />
        <CodeMirrorView />
        <FigureModal />
        <CodeMirrorSearch />
        <CodeMirrorAIChat />
        <CodeMirrorToolbar />
        <CodeMirrorCommandTooltip />
        {(isReviewPanelReact || isReactIde) && <ReviewPanel />}
        {/* FIXED: 2026-11-13 命令面板（Ctrl/Cmd+K），挂在这里可以拿到 CodeMirror view 做跳行 */}
        <CommandPalette />
        {/* FIXED: 2026-11-13 符号面板（Ω 按钮 / Ctrl+Shift+K 打开，插入走 editor:insert-symbol） */}
        <SymbolPalette />
        {/* FIXED: 2026-11-13 项目级全文检索（编辑菜单 → 全项目搜索） */}
        <ProjectSearch />
        {/* FIXED: 2026-11-16 多文件页签：只有 ≥ 2 个文件时出现，切换走 editorManager.openDocId */}
        <EditorTabsBar />
        {/* FIXED: 2026-11-16 选中文本后浮出「加批注」（复用工具栏同一套 comment:start_adding） */}
        <CommentBar />
        {sourceEditorComponents.map(
          ({ import: { default: Component }, path }) => (
            <Component key={path} />
          )
        )}
      </CodeMirrorViewContextProvider>
    </CodeMirrorStateContext.Provider>
  )
}

export default memo(CodeMirrorEditor)

const CodeMirrorStateContext = createContext<EditorState | undefined>(undefined)

export const useCodeMirrorStateContext = (): EditorState => {
  const context = useContext(CodeMirrorStateContext)

  if (!context) {
    throw new Error(
      'useCodeMirrorStateContext is only available inside CodeMirrorEditor'
    )
  }

  return context
}

const CodeMirrorViewContext = createContext<EditorView | undefined>(undefined)

export const CodeMirrorViewContextProvider = CodeMirrorViewContext.Provider

export const useCodeMirrorViewContext = (): EditorView => {
  const context = useContext(CodeMirrorViewContext)

  if (!context) {
    throw new Error(
      'useCodeMirrorViewContext is only available inside CodeMirrorViewContextProvider'
    )
  }

  return context
}
