import { useConnectionContext } from '@/features/ide-react/context/connection-context'
import useEventListener from '@/shared/hooks/use-event-listener'
import { useCallback, useEffect, useState } from 'react'
import { Alerts } from '@/features/ide-react/components/alerts/alerts'
import { useLayoutContext } from '@/shared/context/layout-context'
import MainLayout from '@/features/ide-react/components/layout/main-layout'
import { EditorAndSidebar } from '@/features/ide-react/components/editor-and-sidebar'
import EditorLeftMenu from '@/features/editor-left-menu/components/editor-left-menu'
import EditorNavigationToolbar from '@/features/ide-react/components/editor-navigation-toolbar'
import ChatPane from '@/features/chat/components/chat-pane'
import AIChatPanel from '@/features/ai-chat'
import { useLayoutEventTracking } from '@/features/ide-react/hooks/use-layout-event-tracking'
import useSocketListeners from '@/features/ide-react/hooks/use-socket-listeners'
import { useModalsContext } from '@/features/ide-react/context/modals-context'
import { useOpenFile } from '@/features/ide-react/hooks/use-open-file'

export default function IdePage() {
  useLayoutEventTracking()
  useSocketListeners()

  useOpenFile()

  const [leftColumnDefaultSize, setLeftColumnDefaultSize] = useState(20)
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const { connectionState, registerUserActivity } = useConnectionContext()
  const { showLockEditorMessageModal } = useModalsContext()

  // FIXED: 2026-11-08 删掉挂载时的调试日志（遗留的排查代码，纯噪音）

  useEffect(() => {
    if (connectionState.forceDisconnected) {
      showLockEditorMessageModal(connectionState.forcedDisconnectDelay)
    }
  }, [
    connectionState.forceDisconnected,
    connectionState.forcedDisconnectDelay,
    showLockEditorMessageModal,
  ])

  const listener = useCallback(
    () => registerUserActivity(),
    [registerUserActivity]
  )

  useEventListener('cursor:editor:update', listener)

  useEffect(() => {
    document.body.addEventListener('click', listener)
    return () => document.body.removeEventListener('click', listener)
  }, [listener])

  useEffect(() => {
    const handleToggleAIChat = () => {
      setAiChatOpen(prev => !prev)
    }
    window.addEventListener('chat:toggle-ai', handleToggleAIChat)
    return () =>
      window.removeEventListener('chat:toggle-ai', handleToggleAIChat)
  }, [])

  const { chatIsOpen } = useLayoutContext()

  const mainContent = (
    <div className="editor-and-sidebar-wrapper">
      <EditorAndSidebar
        leftColumnDefaultSize={leftColumnDefaultSize}
        setLeftColumnDefaultSize={setLeftColumnDefaultSize}
        shouldPersistLayout
      />
      {aiChatOpen && (
        <div className="ai-chat-container">
          <AIChatPanel onClose={() => setAiChatOpen(false)} />
        </div>
      )}
    </div>
  )

  return (
    <>
      <Alerts />
      <EditorLeftMenu />
      <MainLayout
        headerContent={<EditorNavigationToolbar />}
        chatContent={<ChatPane />}
        mainContent={mainContent}
        chatIsOpen={chatIsOpen}
        shouldPersistLayout
      />
    </>
  )
}
