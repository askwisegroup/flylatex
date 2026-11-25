import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import Icon from '../../../shared/components/icon'
import AISparklesIcon from '../../../shared/components/ai-sparkles-icon'

/**
 * FIXED: 2026-11-10 移动端四档 Tab（文件 / 源码 / 预览 / AI 助手）。
 *
 * 背景：之前移动端是「阶段 1 轻量只读」—— 打开项目就是单栏 PDF，
 * 文件树、编辑器、设置全被 CSS 藏掉。于是导入的项目一旦主文件没选对，
 * 手机上既改不了文件也改不了主文件，编译不出来 → AI 助手也没有产物可用，
 * 直接走进死路。
 *
 * 这一版的做法是「只加一个切换器」，不动桌面布局：
 *  - 组件只在 <= 767px 渲染（JS 侧 matchMedia + CSS 侧 media query 双重把关）；
 *  - 真实布局状态仍由 ide.js 掌管：这里只写 ui.mobileTab，ide.js 负责把它
 *    翻译成 ui.view / ui.pdfLayout 和 body 上的 fl-mobile-tab-* 类；
 *  - AI 助手复用编辑器已有的浮层（codemirror-ai-chat.tsx 的 mobileViewport 分支）
 *    和它的事件协议 editor:toggle-ai-chat / editor:ai-chat-state，没有第二套开关。
 */
type MobileTab = 'files' | 'source' | 'preview' | 'agent'

const TAB_IDS: MobileTab[] = ['files', 'source', 'preview', 'agent']
const MOBILE_QUERY = '(max-width: 767px)'

function isMobileTab(value: unknown): value is MobileTab {
  return typeof value === 'string' && (TAB_IDS as string[]).includes(value)
}

export default function MobileTabs() {
  const { t } = useTranslation()

  // 只在手机宽度下挂载：桌面端连 DOM 都不产生，样式和事件都没有副作用
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia(MOBILE_QUERY).matches
  )

  const [mobileTab, setMobileTab] = useScopeValue<MobileTab | undefined>(
    'ui.mobileTab'
  )
  const active: MobileTab = isMobileTab(mobileTab) ? mobileTab : 'preview'

  // AI 面板的实际开闭：以面板自己广播的状态为准，不在这里猜
  const [aiChatOpen, setAiChatOpen] = useState(false)

  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onAIChatState = (event: Event) => {
      const open = (event as CustomEvent<{ open?: boolean }>).detail?.open
      if (typeof open !== 'boolean') {
        return
      }
      setAiChatOpen(open)
      // 面板关掉了，Agent 这一档就没有内容了 —— 退回预览，
      // 否则用户看到的是一个「选中的 Tab 但什么都没显示」
      if (!open && activeRef.current === 'agent') {
        setMobileTab('preview')
      }
    }
    window.addEventListener('editor:ai-chat-state', onAIChatState)
    return () => {
      window.removeEventListener('editor:ai-chat-state', onAIChatState)
    }
  }, [setMobileTab])

  const select = useCallback(
    (tab: MobileTab) => {
      setMobileTab(tab)
      // 选中 Agent 就把浮层打开（协议与工具栏那颗按钮完全一致）
      if (tab === 'agent' && !aiChatOpen) {
        window.dispatchEvent(new CustomEvent('editor:toggle-ai-chat'))
      }
    },
    [aiChatOpen, setMobileTab]
  )

  // 每个 key 都写成字面量调用：i18next-scanner 只认 t('literal')，
  // 写成 t(`mobile_tab_${id}`) 会被 bin/check_extracted_translations 判成缺失。
  const items = useMemo(
    () => [
      {
        id: 'files' as const,
        label: t('mobile_tab_files'),
        icon: <Icon type="folder-open-o" fw />,
      },
      {
        id: 'source' as const,
        label: t('mobile_tab_source'),
        icon: <Icon type="code" fw />,
      },
      {
        id: 'preview' as const,
        label: t('mobile_tab_preview'),
        icon: <Icon type="file-pdf-o" fw />,
      },
      {
        id: 'agent' as const,
        label: t('mobile_tab_agent'),
        icon: <AISparklesIcon size={18} />,
      },
    ],
    [t]
  )

  if (!isMobile) {
    return null
  }

  return (
    <div
      className="fl-mobile-tabs"
      role="tablist"
      aria-label={t('mobile_tabs_label')}
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          className={classNames('fl-mobile-tab', {
            'is-active': active === item.id,
          })}
          onClick={() => select(item.id)}
        >
          <span className="fl-mobile-tab-icon">{item.icon}</span>
          <span className="fl-mobile-tab-label">{item.label}</span>
        </button>
      ))}
    </div>
  )
}
