import { useCallback, useEffect, useState } from 'react'
import AISparklesIcon from '../../../shared/components/ai-sparkles-icon'

/**
 * FIXED: 2026-11-08 从 codemirror-toolbar 抽出来独立成组件。
 *
 * 目的：TeX 工具条和 Markdown 预览提示条共用同一颗「AI 助手」按钮
 * （同一个组件、同一套主题变量、同一个事件协议），不要各写一份，
 * 否则样式和状态同步逻辑迟早会跑偏。
 *
 * 事件协议（沿用原实现，未改动）：
 *  - 点击 → dispatch `editor:toggle-ai-chat`，不本地取反；
 *  - 面板开闭后广播 `editor:ai-chat-state`，这里据此回填图标状态，
 *    保证图标与面板实际开闭一致。
 */
function AIChatToggleButton({ className }: { className?: string }) {
  const [aiChatOpen, setAIChatOpen] = useState(false)

  const toggleAIChat = useCallback(() => {
    // FIXED: 2026-10-16 不再在本地取反，只发 toggle 事件；
    //   图标状态改由面板广播的 editor:ai-chat-state 回填，保证与面板实际开闭一致。
    window.dispatchEvent(new CustomEvent('editor:toggle-ai-chat'))
  }, [])

  useEffect(() => {
    const handleAIChatState = (event: Event) => {
      const open = (event as CustomEvent<{ open?: boolean }>).detail?.open
      if (typeof open === 'boolean') {
        setAIChatOpen(open)
      }
    }

    window.addEventListener('editor:ai-chat-state', handleAIChatState)
    return () => {
      window.removeEventListener('editor:ai-chat-state', handleAIChatState)
    }
  }, [])

  return (
    <button
      type="button"
      className={[
        'ol-cm-toolbar-button',
        'fl-ai-toggle-button',
        aiChatOpen ? 'active' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      title="AI Chat"
      onClick={toggleAIChat}
      aria-label="Toggle AI Chat"
    >
      {/* FIXED: 2026-10-16 换用统一的 AI 图标（Sparkles），替代原手写聊天气泡 SVG */}
      <AISparklesIcon size={16} />
    </button>
  )
}

export default AIChatToggleButton
