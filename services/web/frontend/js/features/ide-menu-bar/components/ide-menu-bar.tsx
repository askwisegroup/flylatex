import { useLayoutContext } from '../../../shared/context/layout-context'
import FileMenu from './file-menu'
import EditMenu from './edit-menu'
import AIMenu from './ai-menu'
import HelpMenu from './help-menu'
import ToolsMenu from './tools-menu'
import MenuBarRight from './menu-bar-right'
// FIXED: 2026-11-07 导航栏左侧第一个位置加产品 LOGO（点击回 /project）
import MenuBarLogo from './menu-bar-logo'
import getMeta from '../../../utils/meta'

function IdeMenuBar() {
  const showIdeMenuBar = getMeta('ol-showIdeMenuBar') !== false

  if (!showIdeMenuBar) {
    return null
  }

  return (
    <div className="ide-menu-bar">
      <div className="ide-menu-bar-left">
        <MenuBarLogo />
        <FileMenu />
        <EditMenu />
        <AIMenu />
        <ToolsMenu />
        <HelpMenu />
      </div>
      <MenuBarRight />
    </div>
  )
}

export default IdeMenuBar
