import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorSelection } from '@codemirror/state'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-editor'
import { canAddComment } from '@/features/source-editor/extensions/toolbar/comments'
import {
  canCommentOnProject,
  canEditContent,
} from '@/features/ide-react/types/permissions-level'
import useScopeValue from '@/shared/hooks/use-scope-value'
import { useIdeContext } from '@/shared/context/ide-context'
import { useEditorContext } from '@/shared/context/editor-context'
import { useLayoutContext } from '@/shared/context/layout-context'
import useScopeEventEmitter from '@/shared/hooks/use-scope-event-emitter'
import withErrorBoundary from '@/infrastructure/error-boundary'
import Icon from '@/shared/components/icon'
// FIXED: 2026-11-16 浮条扩展：「插入引用」「问 AI」
import {
  AI_PREFILL_EVENT,
  setAiPrefill,
} from '@/features/ai-chat/utils/ai-prefill'

/**
 * FIXED: 2026-11-16 选中文本后的浮动「加批注」按钮（外挂式）。
 *
 * 为什么不做成 CodeMirror 的 showTooltip 扩展：
 *   那要往 extensions/index.ts 里注册，属于动编辑器核心；而这里只需要
 *   「读选区 + 调已有的批注入口」，用一次 body portal + position:fixed 就够，
 *   位置随选区和滚动实时算（coordsAtPos），不参与编辑器布局，出问题可以直接删。
 *
 * 复用而不是重写：
 *   动作序列与工具栏的「添加批注」完全一致（把空选区扩成整行 → 打开评审面板
 *   → 广播 comment:start_adding），只是把入口挪到了选区旁边。
 *
 * FIXED: 2026-11-16 补上「接受 / 拒绝修订」：
 *   评审面板（Angular 控制器）本来就把「与当前选区相交的修订 id」放在 scope 上
 *   （reviewPanel.selectedEntryIds / nVisibleSelectedChanges），并把动作挂在
 *   ide.$scope.acceptChanges / rejectChanges 上（内部会 POST changes/accept 并广播）。
 *   这里只读这两个 scope 值 + 调这两个函数，不自己算 ranges、不自己发请求。
 *   React IDE 树没有这两个 scope 值时按钮自动不出现（降级，不报错）。
 */
function CommentBar() {
  const state = useCodeMirrorStateContext()
  const view = useCodeMirrorViewContext()
  const { permissionsLevel } = useEditorContext()
  const { setReviewPanelOpen } = useLayoutContext()
  const addCommentEmitter = useScopeEventEmitter('comment:start_adding')
  // AI 面板的真实开关由它自己广播（与工具栏那颗 AI 按钮同一套协议）
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const ide = useIdeContext()
  // 与选区相交的修订 id（评审面板维护）
  const [selectedEntryIds] = useScopeValue<string[]>(
    'reviewPanel.selectedEntryIds'
  )
  const [nSelectedChanges] = useScopeValue<number>(
    'reviewPanel.nVisibleSelectedChanges'
  )
  // 滚动/缩放时选区在屏幕上的位置会变，靠它触发重算（每帧最多一次，避免滚动时抖）
  const [, setTick] = useState(0)
  // FIXED: 2026-11-16 反馈「点完还一直顶在上面」：每个动作点完就把当前这条选区标记为已处理，
  // 浮条立即消失；用户重新框选（选区变化）时才再次出现。
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const frameRef = useRef<number | null>(null)

  const reposition = useCallback(() => {
    if (frameRef.current !== null) {
      return
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setTick(tick => tick + 1)
    })
  }, [])

  // 面板开闭状态（它自己广播，见 ai-chat-toggle-button.tsx 的事件协议）
  useEffect(() => {
    const handler = (event: Event) => {
      const open = (event as CustomEvent<{ open?: boolean }>).detail?.open
      if (typeof open === 'boolean') {
        setAiChatOpen(open)
      }
    }
    window.addEventListener('editor:ai-chat-state', handler)
    return () => window.removeEventListener('editor:ai-chat-state', handler)
  }, [])

  useEffect(() => {
    const scroller = view.scrollDOM
    scroller.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('resize', reposition)
    return () => {
      scroller.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [view, reposition])

  const selection = state.selection.main
  const hasSelection = selection.from !== selection.to

  // 修订动作：选区里有修订 + 有写权限 + 宿主确实提供了这两个动作时才出现
  const changeIds = Array.isArray(selectedEntryIds) ? selectedEntryIds : []
  const canResolveChanges =
    canEditContent(permissionsLevel) &&
    nSelectedChanges > 0 &&
    changeIds.length > 0 &&
    typeof (ide.$scope as any)?.acceptChanges === 'function' &&
    typeof (ide.$scope as any)?.rejectChanges === 'function'

  const canAddCommentHere =
    hasSelection &&
    canCommentOnProject(permissionsLevel) &&
    canAddComment(state)

  // FIXED: 2026-11-16 「插入引用」「问 AI」是只读动作：只要选中了文本就给，
  // 不要求评论权限（只读协作者 / 匿名分享链接用户也可能需要）。
  const canQuoteSelection = hasSelection

  const selectionKey = `${selection.from}:${selection.to}:${changeIds.join(
    ','
  )}`

  const visible =
    (canResolveChanges || canAddCommentHere || canQuoteSelection) &&
    dismissedKey !== selectionKey

  // 任何动作点完都立刻收起（选区不变就不会再冒出来；重新框选才再出现）
  const dismiss = () => setDismissedKey(selectionKey)

  if (!visible) {
    return null
  }

  // 只有修订、没有选区时，锚在光标处
  const anchorPos = hasSelection ? selection.to : selection.head
  const coords = view.coordsAtPos(anchorPos)
  if (!coords) {
    return null
  }

  // 选区被滚出编辑器可视区（例如看 AI 面板/日志时）就别再钉在屏幕上
  const editorRect = view.scrollDOM.getBoundingClientRect()
  if (
    coords.bottom < editorRect.top + 4 ||
    coords.top > editorRect.bottom - 4
  ) {
    return null
  }

  const acceptChanges = () => {
    dismiss()
    ;(ide.$scope as any).acceptChanges(changeIds)
  }
  const rejectChanges = () => {
    dismiss()
    ;(ide.$scope as any).rejectChanges(changeIds)
  }

  const handleClick = () => {
    dismiss()
    const range = view.state.selection.main
    if (range.empty) {
      // 与工具栏一致：空选区时按整行加批注
      const line = view.state.doc.lineAt(range.head)
      view.dispatch({ selection: EditorSelection.range(line.from, line.to) })
    }
    setReviewPanelOpen(true)
    addCommentEmitter()
  }

  // 选中文本（用于「插入引用」的关键词 和「问 AI」的预填内容）
  const selectedText = hasSelection
    ? state.sliceDoc(selection.from, selection.to)
    : ''

  // 插入引用：交给已有的参考文献检索弹窗（references:search 事件），顺手带上选中的文字
  const insertCitation = () => {
    dismiss()
    window.dispatchEvent(
      new CustomEvent('references:search', { detail: { query: selectedText } })
    )
  }

  // 问 AI：先存一份待填内容（面板没挂载也不会丢），再打开面板并广播。
  // 面板开关沿用工具栏 AI 按钮的事件协议：editor:toggle-ai-chat / editor:ai-chat-state，
  // 不用 ui.chatOpen（那套在旧版编辑器里不驱动这个面板）。
  const askAi = () => {
    dismiss()
    const text = selectedText.slice(0, 4000).trim()
    if (!setAiPrefill(text)) {
      return
    }
    if (!aiChatOpen) {
      window.dispatchEvent(new CustomEvent('editor:toggle-ai-chat'))
    }
    window.dispatchEvent(
      new CustomEvent(AI_PREFILL_EVENT, { detail: { text } })
    )
  }

  const mid = (coords.left + coords.right) / 2
  const halfWidth = 44
  const left = Math.min(
    Math.max(mid, halfWidth + 8),
    window.innerWidth - halfWidth - 8
  )

  return createPortal(
    <div className="fl-comment-bar" style={{ top: coords.bottom + 6, left }}>
      {canAddCommentHere && (
        <button
          type="button"
          className="fl-comment-bar-button"
          title="加批注"
          // 关键：mousedown 上阻止默认行为，点按钮时编辑器的选区与焦点都不丢
          onMouseDown={event => event.preventDefault()}
          onClick={handleClick}
        >
          <span className="fl-comment-bar-icon" aria-hidden="true">
            ✎
          </span>
          加批注
        </button>
      )}
      {canQuoteSelection && (
        <>
          <span className="fl-comment-bar-divider" aria-hidden="true" />
          {/* FIXED: 2026-11-17 图标从「❝」换成放大镜：
              原来一个引号字形，单看只表示「引用选段」，用户会把「插入引用」
              读成「给这段加引号」，而它实际打开的是文献检索弹窗；
              另外引号是贴基线的 dingbat，13px 下和 ✎ / ✦ 的光学重心对不齐。
              放大镜 = 检索，语义和真实动作一致，配色也与「问 AI」同级。
              OLD: <button ... className="fl-comment-bar-icon-button">❝</button> */}
          <button
            type="button"
            className="fl-comment-bar-icon-button fl-comment-bar-cite"
            title="插入引用（用选中的文字检索文献）"
            aria-label="插入引用"
            onMouseDown={event => event.preventDefault()}
            onClick={insertCitation}
          >
            <Icon type="search" />
          </button>
          <button
            type="button"
            className="fl-comment-bar-button fl-comment-bar-ask-ai"
            title="就选中的内容问 AI"
            aria-label="问 AI"
            onMouseDown={event => event.preventDefault()}
            onClick={askAi}
          >
            <span className="fl-comment-bar-icon" aria-hidden="true">
              ✦
            </span>
            问 AI
          </button>
        </>
      )}
      {canResolveChanges && (
        <>
          <span className="fl-comment-bar-divider" aria-hidden="true" />
          <button
            type="button"
            className="fl-comment-bar-icon-button fl-comment-bar-accept"
            title="接受此处修订"
            aria-label="接受此处修订"
            onMouseDown={event => event.preventDefault()}
            onClick={acceptChanges}
          >
            ✓
          </button>
          <button
            type="button"
            className="fl-comment-bar-icon-button fl-comment-bar-reject"
            title="拒绝此处修订"
            aria-label="拒绝此处修订"
            onMouseDown={event => event.preventDefault()}
            onClick={rejectChanges}
          >
            ✕
          </button>
        </>
      )}
    </div>,
    document.body
  )
}

// FIXED: 2026-11-16 同上：浮动按钮出问题最多是不出现，不能连累编辑器。
export default withErrorBoundary(CommentBar)
