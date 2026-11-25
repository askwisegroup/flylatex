import { useTranslation } from 'react-i18next'
import type { ProjectCompiler } from '../../../../../../types/project-settings'
import { useEditorContext } from '../../../../shared/context/editor-context'
// FIXED: 2026-11 用 canEditContent 代替 === 'readOnly' 判断
import { canEditContent } from '../../../ide-react/types/permissions-level'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import SettingsMenuSelect from './settings-menu-select'

export default function SettingsCompiler() {
  const { t } = useTranslation()
  const { permissionsLevel } = useEditorContext()
  const { compiler, setCompiler } = useProjectSettingsContext()

  // FIXED: 2026-11 评审者也不能切编译器
  if (!canEditContent(permissionsLevel)) {
    return null
  }

  return (
    <SettingsMenuSelect<ProjectCompiler>
      onChange={setCompiler}
      value={compiler}
      options={[
        {
          value: 'pdflatex',
          label: 'pdfLaTeX',
        },
        {
          value: 'latex',
          label: 'LaTeX',
        },
        {
          value: 'xelatex',
          label: 'XeLaTeX',
        },
        {
          value: 'lualatex',
          label: 'LuaLaTeX',
        },
      ]}
      label={t('compiler')}
      name="compiler"
    />
  )
}
