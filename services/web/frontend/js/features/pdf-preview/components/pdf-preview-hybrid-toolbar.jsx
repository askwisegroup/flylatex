import { memo, useState, useEffect, useRef } from 'react'
import { ButtonToolbar } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import { useLayoutContext } from '../../../shared/context/layout-context'
import PdfCompileButton from './pdf-compile-button'
import SwitchToEditorButton from './switch-to-editor-button'
import PdfHybridLogsButton from './pdf-hybrid-logs-button'
import PdfHybridDownloadButton from './pdf-hybrid-download-button'
import PdfHybridCodeCheckButton from './pdf-hybrid-code-check-button'
import PdfOrphanRefreshButton from './pdf-orphan-refresh-button'
import { DetachedSynctexControl } from './detach-synctex-control'
import Icon from '../../../shared/components/icon'
// FIXED: 2026-11-01 移动端需要一颗「AI 助手」入口：
// 手机上是 PDF 单栏只读模式（文件树 / 编辑器 / AI 菜单全部隐藏），
// 没有这颗按钮就完全进不去 Agent。复用编辑器工具条那颗按钮（同一个组件、同一套事件协议），
// 桌面端由 CSS 隐藏（.fl-pdf-ai-button），行为零变化。
import AIChatToggleButton from '@/features/source-editor/components/ai-chat-toggle-button'

const ORPHAN_UI_TIMEOUT_MS = 5000

function PdfPreviewHybridToolbar() {
  const { detachRole, detachIsLinked } = useLayoutContext()

  const uiTimeoutRef = useRef()
  const [orphanPdfTabAfterDelay, setOrphanPdfTabAfterDelay] = useState(false)

  const orphanPdfTab = !detachIsLinked && detachRole === 'detached'

  useEffect(() => {
    if (uiTimeoutRef.current) {
      clearTimeout(uiTimeoutRef.current)
    }

    if (orphanPdfTab) {
      uiTimeoutRef.current = setTimeout(() => {
        setOrphanPdfTabAfterDelay(true)
      }, ORPHAN_UI_TIMEOUT_MS)
    } else {
      setOrphanPdfTabAfterDelay(false)
    }
  }, [orphanPdfTab])

  let ToolbarInner = null
  if (orphanPdfTabAfterDelay) {
    // when the detached tab has been orphan for a while
    ToolbarInner = <PdfPreviewHybridToolbarOrphanInner />
  } else if (orphanPdfTab) {
    ToolbarInner = <PdfPreviewHybridToolbarConnectingInner />
  } else {
    // tab is not detached or not orphan
    ToolbarInner = <PdfPreviewHybridToolbarInner />
  }

  return (
    <ButtonToolbar className="toolbar toolbar-pdf toolbar-pdf-hybrid">
      {ToolbarInner}
    </ButtonToolbar>
  )
}

function PdfPreviewHybridToolbarInner() {
  return (
    <>
      <div className="toolbar-pdf-left">
        <PdfCompileButton />
        <PdfHybridLogsButton />
        <PdfHybridDownloadButton />
        {/* FIXED: 2026-11-01 移动端专属的 AI 助手入口（桌面端 CSS 隐藏）。
            放在 left 组末尾 + margin-left:auto，靠右显示：
            right 组在移动端被整条隐藏，塞进去就会跟着一起消失。 */}
        <AIChatToggleButton className="fl-pdf-ai-button" />
      </div>
      <div className="toolbar-pdf-right">
        <PdfHybridCodeCheckButton />
        <SwitchToEditorButton />
        <DetachedSynctexControl />
      </div>
    </>
  )
}

function PdfPreviewHybridToolbarOrphanInner() {
  const { t } = useTranslation()
  return (
    <>
      <div className="toolbar-pdf-orphan">
        {t('tab_no_longer_connected')}
        <PdfOrphanRefreshButton />
      </div>
    </>
  )
}

function PdfPreviewHybridToolbarConnectingInner() {
  const { t } = useTranslation()
  return (
    <>
      <div className="toolbar-pdf-orphan">
        <Icon type="refresh" fw spin />
        {t('tab_connecting')}…
      </div>
    </>
  )
}

export default memo(PdfPreviewHybridToolbar)
