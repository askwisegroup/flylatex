import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from 'react-bootstrap'
import Icon from '../../../shared/components/icon'
import getMeta from '../../../utils/meta'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import { useEditorContext } from '../../../shared/context/editor-context'
import { collectErrors } from '@/features/compile-error-fix/collect-errors'
import {
  getAiFixState,
  requestAiFix,
  subscribeAiFix,
} from '@/features/compile-error-fix/ai-fix-store'

/**
 * FIXED: 2026-11-16 「AI 修复」的**入口按钮**（日志面板底部动作行）。
 *
 * 面板本体见 compile-error-fix/pdf-ai-fix-panel.tsx：它作为日志内容区的整宽区块
 * 单独渲染（原来跟按钮挤在 .logs-pane-actions 里，宽了就向左溢出被裁掉）。
 * 两者通过模块级 store 共享状态，日志面板不需要加 Provider。
 *
 * 链路：结构化编译错误 → POST /ft-ai/error-fix → 模型只给「行级修改建议」
 *      → 面板里逐条显示 diff → 用户点「接受」才 POST /ft-ai/error-fix/apply 落盘。
 */
function PdfFixWithAIButton() {
  const { logEntries, compiling } = useCompileContext()
  const { permissionsLevel } = useEditorContext()
  const projectId = getMeta('ol-project_id')

  const [, forceRender] = useState(0)

  useEffect(() => subscribeAiFix(() => forceRender(v => v + 1)), [])

  const errors = useMemo(() => collectErrors(logEntries), [logEntries])
  const state = getAiFixState()
  const canWrite =
    permissionsLevel !== 'readOnly' && permissionsLevel !== 'review'

  const trigger = useCallback(() => {
    requestAiFix(projectId, errors)
  }, [projectId, errors])

  // 日志里每条 error 下面的「AI 修复」按钮只派发事件，请求与状态都在 store 里
  useEffect(() => {
    window.addEventListener('fl-error-fix:request', trigger)
    return () => window.removeEventListener('fl-error-fix:request', trigger)
  }, [trigger])

  if (!errors.length || !canWrite) {
    return null
  }

  return (
    <Button
      bsSize="small"
      bsStyle="default"
      className="logs-pane-actions-fix-with-ai"
      onClick={trigger}
      disabled={state.status === 'loading' || compiling}
      title="让 AI 根据编译日志给出可审阅的修改建议（不会自动改你的文件）"
    >
      {state.status === 'loading' ? (
        <Icon type="refresh" spin />
      ) : (
        <Icon type="magic" />
      )}
      &nbsp;
      <span>{state.status === 'ready' ? '重新生成修复建议' : 'AI 修复'}</span>
    </Button>
  )
}

export default PdfFixWithAIButton
