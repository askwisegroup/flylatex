import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import SettingsMenuSelect, { Option } from './settings-menu-select'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import { useLayoutContext } from '../../../../shared/context/layout-context'
import type { SettingsPanelMode } from '../../../../../../types/project-settings'

/**
 * 设置的显示方式：左侧面板展开（默认，沿用原行为）/ 居中弹窗（分类展示）。
 *
 * FIXED: 2026-11-01
 * 只影响「文件 - 设置」打开展示的方式，设置项本身、保存逻辑、生效方式都不变。
 * 和 overalTheme / aiPanelLayout 一样跟账号走（User.ace.settingsPanelMode），
 * 没设置过就是 'left'。
 */
export default function SettingsPanelModeSelect() {
  const { t } = useTranslation()
  const { settingsPanelMode, setSettingsPanelMode } =
    useProjectSettingsContext()
  const { setLeftMenuShown } = useLayoutContext()

  // 弹窗 -> 左侧面板的交接：先让弹窗卸载，再展开左面板，避免两个都在动画
  const setSettingsModalShownLater = useCallback(() => {
    window.setTimeout(() => setLeftMenuShown(true), 150)
  }, [setLeftMenuShown])

  const options: Array<Option<SettingsPanelMode>> = useMemo(
    () => [
      { value: 'modal', label: t('settings_panel_mode_modal') },
      { value: 'left', label: t('settings_panel_mode_left') },
    ],
    [t]
  )

  const handleChange = useCallback(
    (value: SettingsPanelMode) => {
      setSettingsPanelMode(value)
      // 立即生效：左侧面板和文件菜单读的都是同一份设置（scope 上的 settings），
      // 保存时会同步更新，不需要额外事件。
      // 从左侧面板切到弹窗时，当前这一份设置会被卸载，
      // 所以顺手把左面板收起来、把弹窗打开（等收起动画跑完再弹）。
      if (value === 'modal') {
        setLeftMenuShown(false)
        window.setTimeout(() => {
          document.dispatchEvent(
            new CustomEvent('fl:settings-modal', { detail: { open: true } })
          )
        }, 220)
      } else {
        // 反过来：从弹窗切回左侧面板时，弹窗会随模式变化立刻卸载，
        // 这里顺手把左面板展开，别让设置"凭空消失"。
        setSettingsModalShownLater()
      }
    },
    [setSettingsPanelMode, setLeftMenuShown, setSettingsModalShownLater]
  )

  return (
    <SettingsMenuSelect<SettingsPanelMode>
      onChange={handleChange}
      value={settingsPanelMode ?? 'modal'}
      options={options}
      label={t('settings_panel_mode')}
      name="settingsPanelMode"
    />
  )
}
