import DownloadMenu from './download-menu'
import ActionsMenu from './actions-menu'
import HelpMenu from './help-menu'
import SyncMenu from './sync-menu'
import SettingsMenu from './settings-menu'
import { useProjectSettingsContext } from '../context/project-settings-context'

export default function EditorLeftMenuBody() {
  const { settingsPanelMode } = useProjectSettingsContext()

  // FIXED: 2026-11-01 弹窗模式下，设置项改在居中弹窗里展示。
  // 这里不渲染，保证同一时刻只有一份设置组件在挂载状态
  // （有的设置项带副作用，比如切换主题会往 <head> 插 <link>）。
  const useSettingsModal = (settingsPanelMode ?? 'modal') === 'modal'

  return (
    <>
      <DownloadMenu />
      <ActionsMenu />
      <SyncMenu />
      {!useSettingsModal && <SettingsMenu />}
      <HelpMenu />
    </>
  )
}
