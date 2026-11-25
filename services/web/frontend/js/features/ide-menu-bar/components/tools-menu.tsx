// ⚠️ 死代码（2026-11-13 核实）：本文件所属的 features/ide-menu-bar/ 除
// menu-bar-logo / about-brand-mark 之外没有任何外部引用，真实菜单栏在
// features/editor-navigation-toolbar/components/toolbar-header.jsx。
// 改菜单请改那边，不要改这里（我在 2026-11-13 就白改过一次）。
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Dropdown, MenuItem } from 'react-bootstrap'
import Icon from '../../../shared/components/icon'
import { togglePalette, usePaletteOpen } from '../../palette-manager'

function ToolsMenu() {
  const { t } = useTranslation()

  const handleWordCount = useCallback(() => {
    window.dispatchEvent(new CustomEvent('editor:word-count'))
  }, [])

  const handleReferencesSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent('references:search'))
  }, [])

  // FIXED: 2026-11-13 三个浮层面板都从「工具」菜单进，语义统一为 toggle：
  // 已打开时再点同一个菜单项是「关闭」，点另一个则自动关掉前一个（互斥）。
  // 互斥逻辑在 palette-manager 里，这里只负责触发。
  const commandPaletteOpen = usePaletteOpen('command')
  const symbolPaletteOpen = usePaletteOpen('symbol')
  const projectSearchOpen = usePaletteOpen('search')

  return (
    <Dropdown id="ide-menu-tools" pullRight className="ide-menu-dropdown">
      <Dropdown.Toggle noCaret className="ide-menu-toggle">
        {t('tools')}
      </Dropdown.Toggle>
      <Dropdown.Menu className="ide-menu-dropdown-menu">
        <MenuItem onClick={handleWordCount}>
          <Icon type="file-text-o" fw /> {t('word_count')}
        </MenuItem>
        <MenuItem divider />
        <MenuItem
          onClick={() => togglePalette('command')}
          className={commandPaletteOpen ? 'active' : undefined}
        >
          <Icon type="terminal" fw /> {t('menu_command_palette')}
        </MenuItem>
        <MenuItem
          onClick={() => togglePalette('symbol')}
          className={symbolPaletteOpen ? 'active' : undefined}
        >
          <Icon type="superscript" fw /> {t('menu_symbol_palette')}
        </MenuItem>
        <MenuItem
          onClick={() => togglePalette('search')}
          className={projectSearchOpen ? 'active' : undefined}
        >
          <Icon type="search" fw /> {t('menu_project_search')}
        </MenuItem>
        <MenuItem divider />
        <MenuItem onClick={handleReferencesSearch}>
          <Icon type="search" fw /> {t('crossref_toolbar_button')}
        </MenuItem>
      </Dropdown.Menu>
    </Dropdown>
  )
}

export default ToolsMenu
