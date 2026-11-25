import { useCallback, useEffect } from 'react'
import useEventListener from '../../../shared/hooks/use-event-listener'
import useDetachAction from '../../../shared/hooks/use-detach-action'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import { isMarkdownFile } from '../../../shared/utils/is-markdown-file'

export const startCompileKeypress = event => {
  if (event.shiftKey || event.altKey) {
    return false
  }

  if (event.ctrlKey) {
    // Ctrl+s / Ctrl+Enter / Ctrl+.
    if (event.key === 's' || event.key === 'Enter' || event.key === '.') {
      return true
    }

    // Ctrl+s with Caps-Lock on
    if (event.key === 'S' && !event.shiftKey) {
      return true
    }
  } else if (event.metaKey) {
    // Cmd+s / Cmd+Enter
    if (event.key === 's' || event.key === 'Enter') {
      return true
    }

    // Cmd+s with Caps-Lock on
    if (event.key === 'S' && !event.shiftKey) {
      return true
    }
  }
}

export default function useCompileTriggers(
  startCompile,
  setChangedAt,
  setSavedAt
) {
  // FIXED: 2026-11-08 Markdown 没有「编译」这回事。
  // 原来 Ctrl+S / Cmd+S 是 body 上的全局监听，在 .md 文档里照样触发一次 LaTeX 编译
  // （纯 Markdown 的项目会直接编译失败，右侧弹一堆错误）。
  // 现在：markdown 文档里只吞掉快捷键（不弹浏览器「另存为」），不发编译。
  const [openDocName] = useScopeValue('editor.open_doc_name')
  const editingMarkdown = isMarkdownFile(openDocName)

  const handleKeyDown = useCallback(
    event => {
      if (!startCompileKeypress(event)) {
        return
      }
      event.preventDefault()
      if (editingMarkdown) {
        return
      }
      startCompile()
    },
    [startCompile, editingMarkdown]
  )

  const handleStartCompile = useCallback(() => {
    startCompile()
  }, [startCompile])
  useEventListener('pdf:recompile', handleStartCompile)

  useEffect(() => {
    document.body.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleKeyDown])

  // record doc changes when notified by the editor
  const setOrTriggerChangedAt = useDetachAction(
    'set-changed-at',
    setChangedAt,
    'detacher',
    'detached'
  )
  const setChangedAtHandler = useCallback(() => {
    setOrTriggerChangedAt(Date.now())
  }, [setOrTriggerChangedAt])
  useEventListener('doc:changed', setChangedAtHandler)

  // record when the server acknowledges saving changes
  const setOrTriggerSavedAt = useDetachAction(
    'set-saved-at',
    setSavedAt,
    'detacher',
    'detached'
  )
  const setSavedAtHandler = useCallback(() => {
    setOrTriggerSavedAt(Date.now())
  }, [setOrTriggerSavedAt])
  useEventListener('doc:saved', setSavedAtHandler)
}
