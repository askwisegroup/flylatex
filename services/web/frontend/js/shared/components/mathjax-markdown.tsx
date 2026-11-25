import { useEffect, useRef, type CSSProperties } from 'react'
import { configureMathJax } from '../../features/mathjax/configure'
import { loadMathJax } from '../../features/mathjax/load-mathjax'
import { debugConsole } from '@/utils/debugging'
import { renderMarkdown } from '../utils/markdown'

type MathJaxMarkdownProps = {
  markdown: string | undefined | null
  className?: string
  style?: CSSProperties
  /**
   * FIXED: 2026-11-08 渲染**项目文件**时传 true，走 sanitize-html 白名单。
   * 默认 false，AI 面板行为保持不变。
   */
  sanitize?: boolean
}

/**
 * FIXED: 2026-10-23 AI 消息里的 LaTeX 公式排版
 *
 * renderMarkdown 会保留 `\(...\)`、`\[...\]` 等分隔符（见 markdown.ts），
 * 这里在 HTML 插入 DOM 后用 MathJax 做二次排版，避免公式以源码形式显示。
 * 复用聊天面板已有的 MathJax v2/v3 加载逻辑。
 */
export function MathJaxMarkdown({
  markdown,
  className,
  style,
  sanitize,
}: MathJaxMarkdownProps) {
  const root = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = root.current
    if (!element || !markdown) return

    // MathJax v2（旧页面仍可能以 v2 启动）
    if (window.MathJax?.Hub) {
      const { Hub } = window.MathJax
      const timeout = setTimeout(() => {
        configureMathJax()
        Hub.Queue(['Typeset', Hub, element])
      }, 0)
      return () => clearTimeout(timeout)
    }

    // MathJax v3
    let cancelled = false
    loadMathJax()
      .then(MathJax => {
        if (!cancelled) {
          MathJax.typesetPromise([element]).catch(debugConsole.error)
        }
      })
      .catch(debugConsole.error)

    return () => {
      cancelled = true
    }
  }, [markdown])

  return (
    <div
      ref={root}
      className={className}
      style={style}
      dangerouslySetInnerHTML={{
        __html: renderMarkdown(markdown, { sanitize }),
      }}
    />
  )
}

export default MathJaxMarkdown
