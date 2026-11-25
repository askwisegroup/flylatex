import useIsMobile from '../hooks/use-is-mobile'
import { formatElapsed, formatMessageTime } from '../utils/chat-time'

/**
 * FIXED: 2026-11-17 消息时间戳（放在提问/回复下方、功能按钮前面）。
 *
 * 两个 AI 面板（`features/ai-chat` 侧栏与 `source-editor/codemirror-ai-chat`
 * 浮层）共用这一个组件，避免两边格式/移动端策略漂移。
 *
 * 样式在 stylesheets/app/editor/ai-chat.less 的 `.ai-msg-time`：
 * 颜色走 `--fl-text-muted`，因此深色/浅色/柔和三套主题都跟随。
 */
export default function AiMessageTime({
  createdAt,
  elapsedMs,
}: {
  createdAt?: string | number | Date | null
  elapsedMs?: number
}) {
  const isMobile = useIsMobile()
  const parts = formatMessageTime(createdAt, { isMobile })

  // 老消息（这个字段上线之前的）没有 createdAt：整块不渲染，不留空白
  if (parts == null) return null

  const elapsed = elapsedMs != null ? formatElapsed(elapsedMs) : ''

  return (
    <time
      className="ai-msg-time"
      dateTime={parts.iso}
      title={parts.full}
      aria-label={parts.full}
    >
      {parts.date ? (
        <span className="ai-msg-time-date">{parts.date}</span>
      ) : null}
      <span className="ai-msg-time-clock">{parts.clock}</span>
      {/* 耗时只在「回复」上给，提问没有「用时」这个概念 */}
      {elapsed ? <span className="ai-msg-time-elapsed">{elapsed}</span> : null}
    </time>
  )
}
