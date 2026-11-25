import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import SettingsMenuSelect, { Option } from './settings-menu-select'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import type { AIPanelLayout } from '../../../../../../types/project-settings'

/**
 * AI 面板展示位置：侧边（默认，覆盖 PDF 区） / 底部停靠（横跨编辑器 + 预览） / 居中弹窗。
 *
 * FIXED: 2026-10-30
 * 布局本身是 jquery-layout 的 south 面板，这里只负责写用户设置；
 * 真正的切换由 React 侧的 AI 面板（codemirror-ai-chat）通过
 * `fl:ai-panel-layout` 事件即时完成，无需刷新页面。
 *
 * FIXED: 2026-11-13 新增「弹窗（居中浮动）」。
 * 用于给批注面板腾位置：右侧/底部被审阅面板占用时，AI 面板改为真模态弹窗。
 */
export default function SettingsAIPanelLayout() {
  const { t } = useTranslation()
  const { aiPanelLayout, setAIPanelLayout } = useProjectSettingsContext()

  const options: Array<Option<AIPanelLayout>> = useMemo(
    () => [
      { value: 'side', label: t('ai_panel_layout_side') },
      { value: 'bottom', label: t('ai_panel_layout_bottom') },
      // FIXED: 2026-11-13 弹窗模式（居中，模态，宽度 PC 50%）
      { value: 'modal', label: t('ai_panel_layout_modal') },
    ],
    [t]
  )

  const handleChange = useCallback(
    (value: AIPanelLayout) => {
      setAIPanelLayout(value)
      // 立即生效：AI 面板监听这个事件，把 portal 目标换掉并开合 south 面板
      document.dispatchEvent(
        new CustomEvent('fl:ai-panel-layout', { detail: value })
      )
    },
    [setAIPanelLayout]
  )

  return (
    <SettingsMenuSelect<AIPanelLayout>
      onChange={handleChange}
      value={aiPanelLayout ?? 'side'}
      options={options}
      label={t('ai_panel_layout')}
      name="aiPanelLayout"
    />
  )
}
