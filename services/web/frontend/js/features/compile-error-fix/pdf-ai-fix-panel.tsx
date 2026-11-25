import { useEffect, useState } from 'react'
import getMeta from '@/utils/meta'
import { useDetachCompileContext as useCompileContext } from '@/shared/context/detach-compile-context'
import { useEditorContext } from '@/shared/context/editor-context'
import {
  applyAiFix,
  dismissAiFix,
  getAiFixState,
  requestAiFix,
  skipAiFix,
  subscribeAiFix,
} from '@/features/compile-error-fix/ai-fix-store'
import type { AiFixProposal } from '@/features/compile-error-fix/ai-fix-store'

/**
 * FIXED: 2026-11-16 「AI 修复」的建议面板。
 *
 * 为什么单独成一个组件、并且渲染在 `.logs-pane-content` 里（而不是跟着按钮待在
 * `.logs-pane-actions` 里）：那个 actions 容器是右对齐、靠底部的小块，
 * 定宽面板比它宽时向左溢出，被 `.logs-pane` 的 overflow 裁掉（线上截图里
 * 「修复建议」少了「AI」、「main.tex:311」只剩「tex:311」）。
 * 现在它是日志内容区里的一个普通整宽区块，从左边界开始画，永不裁切。
 */
function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const removed = oldText.split('\n')
  const added = newText.split('\n')
  return (
    <div className="fl-error-fix-diff">
      {removed.map((line, index) => (
        <div
          className="fl-error-fix-diff-line fl-error-fix-diff-remove"
          key={`r${index}`}
        >
          <span className="fl-error-fix-diff-marker">-</span>
          <code>{line || ' '}</code>
        </div>
      ))}
      {added.map((line, index) => (
        <div
          className="fl-error-fix-diff-line fl-error-fix-diff-add"
          key={`a${index}`}
        >
          <span className="fl-error-fix-diff-marker">+</span>
          <code>{line || ' '}</code>
        </div>
      ))}
    </div>
  )
}

export default function PdfAiFixPanel() {
  const { logEntries } = useCompileContext()
  const { permissionsLevel } = useEditorContext()
  const projectId = getMeta('ol-project_id')
  const [, setVersion] = useState(0)

  useEffect(() => subscribeAiFix(() => setVersion(v => v + 1)), [])

  const state = getAiFixState()

  // 没有建议（或用户收起）时不占位置
  if (state.status !== 'ready' || !state.proposals.length) {
    return null
  }

  const canWrite =
    permissionsLevel !== 'readOnly' && permissionsLevel !== 'review'

  // 日志面板换了一次编译结果 → 旧建议已经过期，不显示（避免拿旧 diff 去改新内容）
  if (!canWrite || !logEntries) {
    return null
  }

  const appliedCount = Object.values(state.applied).filter(
    v => v === 'ok'
  ).length

  return (
    <div className="fl-error-fix-panel fl-error-fix-panel--inline">
      <div className="fl-error-fix-header">
        <span className="fl-error-fix-title">AI 修复建议</span>
        <span className="fl-error-fix-header-right">
          {appliedCount > 0 && (
            <span className="fl-error-fix-done">
              ✓ 已应用 {appliedCount} 处
            </span>
          )}
          <button
            type="button"
            className="fl-error-fix-close"
            aria-label="收起"
            title="收起"
            onClick={dismissAiFix}
          >
            ×
          </button>
        </span>
      </div>

      {state.notice && (
        <div className="fl-error-fix-notice">{state.notice}</div>
      )}

      {state.proposals.map((proposal: AiFixProposal) => {
        const applied = state.applied[proposal.id]
        return (
          <div className="fl-error-fix-item" key={proposal.id}>
            <div className="fl-error-fix-item-head">
              <code className="fl-error-fix-file">
                {proposal.file}
                {proposal.startLine
                  ? `:${proposal.startLine}${
                      (proposal.endLine || 0) > (proposal.startLine || 0)
                        ? `-${proposal.endLine}`
                        : ''
                    }`
                  : ''}
              </code>
              {applied === 'ok' ? (
                <span className="fl-error-fix-done">✓ 已应用</span>
              ) : (
                <span className="fl-error-fix-actions">
                  <button
                    type="button"
                    className="fl-error-fix-accept"
                    disabled={state.applyingId === proposal.id}
                    onClick={() => applyAiFix(projectId, proposal)}
                  >
                    {state.applyingId === proposal.id ? '应用中…' : '接受'}
                  </button>
                  <button
                    type="button"
                    className="fl-error-fix-reject"
                    disabled={state.applyingId === proposal.id}
                    onClick={() =>
                      applied === 'skip'
                        ? applyAiFix(projectId, proposal)
                        : skipAiFix(proposal.id)
                    }
                  >
                    {applied === 'skip' ? '重新查看' : '忽略'}
                  </button>
                </span>
              )}
            </div>
            {applied !== 'skip' && (
              <>
                <DiffBlock
                  oldText={proposal.oldText}
                  newText={proposal.newText}
                />
                {proposal.explanation && (
                  <div className="fl-error-fix-reason">
                    {proposal.explanation}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}

      {appliedCount > 0 && (
        <div className="fl-error-fix-notice fl-error-fix-notice--ok">
          已应用 {appliedCount} 处修改，重新编译即可看到结果。
        </div>
      )}
    </div>
  )
}

export { requestAiFix }
