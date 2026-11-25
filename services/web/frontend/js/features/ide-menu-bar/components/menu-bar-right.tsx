import { useLayoutContext } from '../../../shared/context/layout-context'
import ShareProjectButton from '../../editor-navigation-toolbar/components/share-project-button'
import HistoryToggleButton from '../../editor-navigation-toolbar/components/history-toggle-button'
import LayoutDropdownButton from '../../editor-navigation-toolbar/components/layout-dropdown-button'
import ChatToggleButton from '../../editor-navigation-toolbar/components/chat-toggle-button'
import getMeta from '../../../utils/meta'
import { useCallback, useState } from 'react'
import * as eventTracking from '../../../infrastructure/event-tracking'
import { useTranslation } from 'react-i18next'

function MenuBarRight() {
  const { t } = useTranslation()
  const { chatIsOpen, setChatIsOpen, view, setView } = useLayoutContext()
  const isRestrictedTokenMember = getMeta('ol-isRestrictedTokenMember')

  const [showShareModal, setShowShareModal] = useState(false)

  const handleOpenShareModal = useCallback(() => {
    eventTracking.sendMB('navigation-clicked-share')
    setShowShareModal(true)
  }, [])

  const handleHideShareModal = useCallback(() => {
    setShowShareModal(false)
  }, [])

  const toggleChatOpen = useCallback(() => {
    setChatIsOpen(value => !value)
  }, [setChatIsOpen])

  const toggleHistoryOpen = useCallback(() => {
    setView(view === 'history' ? 'editor' : 'history')
  }, [view, setView])

  return (
    <div className="ide-menu-bar-right">
      {/* FIXED: 2026-11-13 符号面板入口（插入数学符号）。只派发事件，
          具体的开关状态由 SymbolPalette 组件自己管。 */}
      <button
        type="button"
        className="ide-menu-toggle"
        title={t('symbol_palette_title') + ' (Ctrl+Shift+K)'}
        onClick={() =>
          window.dispatchEvent(new Event('fl:toggle-symbol-palette'))
        }
      >
        Ω
      </button>
      <ShareProjectButton onClick={handleOpenShareModal} />
      {!isRestrictedTokenMember && (
        <HistoryToggleButton
          historyIsOpen={view === 'history'}
          onClick={toggleHistoryOpen}
        />
      )}
      <LayoutDropdownButton />
    </div>
  )
}

export default MenuBarRight
