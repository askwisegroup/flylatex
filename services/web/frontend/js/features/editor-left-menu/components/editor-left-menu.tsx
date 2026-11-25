import { useEffect, useState } from 'react'
import { useLayoutContext } from '../../../shared/context/layout-context'
import { useProjectSettingsContext } from '../context/project-settings-context'
import LeftMenuMask from './left-menu-mask'
import AccessibleModal from '../../../shared/components/accessible-modal'
import { Modal } from 'react-bootstrap'
import classNames from 'classnames'
import { lazy, Suspense } from 'react'
import { FullSizeLoadingSpinner } from '@/shared/components/loading-spinner'
import SettingsModal from './settings-modal'
const EditorLeftMenuBody = lazy(() => import('./editor-left-menu-body'))

export default function EditorLeftMenu() {
  const { leftMenuShown, setLeftMenuShown } = useLayoutContext()
  const { settingsPanelMode } = useProjectSettingsContext()

  // FIXED: 2026-11-01 「文件 - 设置」的第二种显示方式：居中弹窗。
  // 开关状态放在这里而不是 LayoutContext，避免动到 scope 上的既有字段；
  // 由 toolbar-header 的菜单项派发 fl:settings-modal 事件来打开。
  const [settingsModalShown, setSettingsModalShown] = useState(false)
  // 默认就是弹窗（User.ace.settingsPanelMode 默认 'modal'）
  const useSettingsModal = (settingsPanelMode ?? 'modal') === 'modal'

  useEffect(() => {
    if (!useSettingsModal) {
      setSettingsModalShown(false)
      return
    }
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { open?: boolean }
        | undefined
      setSettingsModalShown(detail?.open !== false)
    }
    document.addEventListener('fl:settings-modal', onOpen)
    return () => {
      document.removeEventListener('fl:settings-modal', onOpen)
    }
  }, [useSettingsModal])

  const closeModal = () => {
    setLeftMenuShown(false)
  }

  return (
    <>
      <AccessibleModal
        backdropClassName="left-menu-modal-backdrop"
        keyboard
        onHide={closeModal}
        id="left-menu-modal"
        show={leftMenuShown}
      >
        <Modal.Body
          className={classNames('full-size', { shown: leftMenuShown })}
          id="left-menu"
        >
          <Suspense fallback={<FullSizeLoadingSpinner delay={500} />}>
            <EditorLeftMenuBody />
          </Suspense>
        </Modal.Body>
      </AccessibleModal>
      {leftMenuShown && <LeftMenuMask />}
      {/* 弹窗模式：设置项只挂一份（左侧面板里那份此时不渲染），避免 effect 重复执行 */}
      {useSettingsModal && (
        <SettingsModal
          show={settingsModalShown}
          onHide={() => setSettingsModalShown(false)}
        />
      )}
    </>
  )
}
