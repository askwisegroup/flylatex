type AISparklesIconProps = {
  /** 图标边长（px），默认 16 */
  size?: number
  className?: string
  style?: React.CSSProperties
}

/**
 * FIXED: 2026-10-16 AI 助手统一图标（Sparkles / 四点星光）
 *
 * 背景：
 *  - 项目所用 FontAwesome 为 4.7.0，其中并没有 sparkles / robot / brain 等现代 AI 图标；
 *  - 原工具栏「打开 AI 助手」按钮是手写的 message-square（通用评论气泡）SVG，语义偏且风格不统一；
 *  - 助手头像用的 <Icon type="robot" /> 在 4.7 中不存在，实际渲染为空白。
 *
 * 说明：线型风格与项目其它图标保持一致（24×24 viewBox / stroke-width 2 / 圆头圆角），
 *       三处（工具栏 + 两个面板的助手头像）共用本组件，便于日后统一更换。
 */
function AISparklesIcon({ size = 16, className, style }: AISparklesIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </svg>
  )
}

export default AISparklesIcon
