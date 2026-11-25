import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayoutContext } from '../../../../shared/context/layout-context'
import getMeta from '../../../../utils/meta'
import SettingsMenuSelect, { Option } from './settings-menu-select'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import type { OverallThemeMeta } from '../../../../../../types/project-settings'
import type { OverallTheme } from '../../../source-editor/extensions/theme'

export default function SettingsOverallTheme() {
  const { t } = useTranslation()
  const overallThemes = getMeta('ol-overallThemes') as
    | OverallThemeMeta[]
    | undefined
  const { loadingStyleSheet } = useLayoutContext()
  const { overallTheme, setOverallTheme } = useProjectSettingsContext()

  const options: Array<Option<OverallTheme>> = useMemo(
    () =>
      overallThemes?.map(({ name, nameKey, val }) => ({
        value: val,
        // FIXED: 2026-10-29 主题名做本地化，缺 key 时回退英文 name
        label: nameKey ? t(nameKey, name) : name,
      })) ?? [],
    [overallThemes, t]
  )

  // TODO: check for IEEE brand by:
  // - const brandVariation = getMeta('ol-brandVariation') as any[]
  // - settings.overleaf != null && !isIEEE(brandVariation)
  if (!overallThemes) {
    return null
  }

  return (
    <SettingsMenuSelect<OverallTheme>
      onChange={setOverallTheme}
      value={overallTheme}
      options={options}
      loading={loadingStyleSheet}
      label={t('overall_theme')}
      name="overallTheme"
    />
  )
}
