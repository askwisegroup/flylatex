import { useTranslation } from 'react-i18next'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import SettingsMenuSelect from './settings-menu-select'

/**
 * 导航栏是否显示项目/文章标题（设置 → 通用）
 *
 * FIXED: 2026-11-06
 * 默认「否」＝ 顶部菜单栏只有菜单，和改造前完全一致；选「是」后在菜单右侧
 * 显示当前项目标题（菜单与右侧按钮之间，视觉居中，见 ide-menu-bar.less 的
 * `.ide-menu-bar-title`）。跟账号走（User.ace.navbarShowTitle），改完即时生效。
 */
export default function SettingsNavbarTitle() {
  const { t } = useTranslation()
  const { navbarShowTitle, setNavbarShowTitle } = useProjectSettingsContext()

  return (
    <SettingsMenuSelect<boolean>
      onChange={setNavbarShowTitle}
      value={navbarShowTitle ?? false}
      options={[
        {
          value: false,
          label: t('navbar_show_title_no'),
        },
        {
          value: true,
          label: t('navbar_show_title_yes'),
        },
      ]}
      label={t('navbar_show_title')}
      name="navbarShowTitle"
    />
  )
}
