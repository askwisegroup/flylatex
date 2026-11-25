import { memo, useCallback, useEffect } from 'react'
import { useCodeMirrorViewContext } from './codemirror-editor'
import useCodeMirrorScope from '../hooks/use-codemirror-scope'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import MarkdownPreview from './markdown-preview'
import { isMarkdownFile } from '../../../shared/utils/is-markdown-file'

function CodeMirrorView() {
  const view = useCodeMirrorViewContext()

  // FIXED: 2026-11-08 Markdown 的「可视化编辑器」＝只读渲染预览。
  //
  // 为什么挂在这里（CodeMirrorView）而不是编辑器外层的 EditorPane：
  //   1. 这个组件和工具栏（editor-switch）在同一个 chunk、同一棵 React 树里，
  //      工具栏读得到的 scope 值这里一定读得到 —— 不会再出现「开关亮了、
  //      预览不出现」这种两边状态不一致的问题。
  //   2. 只要有代码编辑器，它就一定被挂载，不依赖外层用的是哪套布局。
  //   3. 编辑器本身不卸载：预览只是绝对定位盖在上面（见 .markdown-preview），
  //      滚动位置、选区、协作光标、watchdog 状态全都原样保留；
  //      进入预览时把焦点从 CM6 拿走，避免用户敲键盘改到看不见的文档。
  const [showVisual] = useScopeValue<boolean>('editor.showVisual')
  const [openDocName] = useScopeValue<string | null>('editor.open_doc_name')
  const showPreview = !!showVisual && isMarkdownFile(openDocName)

  // FIXED: 2026-11-08 一次挂载/切换只打一行（不是每帧），下次排查不用再猜
  // 「是组件没挂上，还是条件不成立」。也方便在控制台直接确认部署到位。
  useEffect(() => {
    console.info('[markdown-preview] 状态', {
      showVisual,
      openDocName,
      showPreview,
    })
  }, [showVisual, openDocName, showPreview])

  // append the editor view dom to the container node when mounted
  const containerRef = useCallback(
    node => {
      if (node) {
        node.appendChild(view.dom)
      }
    },
    [view]
  )

  // destroy the editor when unmounted
  useEffect(() => {
    return () => {
      view.destroy()
    }
  }, [view])

  useCodeMirrorScope(view)

  return (
    <div
      className="cm-editor-view"
      style={{ position: 'relative', height: '100%' }}
    >
      <div ref={containerRef} style={{ height: '100%' }} />
      {showPreview && <MarkdownPreview />}
    </div>
  )
}

export default memo(CodeMirrorView)
