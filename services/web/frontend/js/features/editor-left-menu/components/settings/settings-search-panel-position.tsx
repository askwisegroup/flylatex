import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import SettingsMenuSelect, { Option } from './settings-menu-select'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import type { SearchPanelPosition } from '../../../../../../types/project-settings'

/**
 * 搜索 / 替换面板的位置：编辑器底部（默认，现状）/ 顶部。
 *
 * FIXED: 2026-11-01
 * 只影响 CM6 把搜索面板挂在编辑器哪一侧（Panel.top），搜索逻辑、快捷键、
 * 「Aa / .* / W」这些选项全都不动。和 overallTheme / aiPanelLayout 一样跟账号走
 * （User.ace.searchPanelPosition），没设置过就是 'bottom'。
 *
 * 生效时机：**下次打开**搜索面板时。面板正开着的时候改，需要关掉再打开一次
 * （CodeMirror 的面板位置是创建时定下来的，不重排）。
 */
export default function SettingsSearchPanelPositionSelect() {
  const { t } = useTranslation()
  const { searchPanelPosition, setSearchPanelPosition } =
    useProjectSettingsContext()

  const options: Array<Option<SearchPanelPosition>> = useMemo(
    () => [
      { value: 'bottom', label: t('settings_search_panel_position_bottom') },
      { value: 'top', label: t('settings_search_panel_position_top') },
    ],
    [t]
  )

  const handleChange = useCallback(
    (value: SearchPanelPosition) => {
      setSearchPanelPosition(value)
    },
    [setSearchPanelPosition]
  )

  return (
    <SettingsMenuSelect<SearchPanelPosition>
      onChange={handleChange}
      value={searchPanelPosition ?? 'bottom'}
      options={options}
      label={t('settings_search_panel_position')}
      name="searchPanelPosition"
    />
  )
}
