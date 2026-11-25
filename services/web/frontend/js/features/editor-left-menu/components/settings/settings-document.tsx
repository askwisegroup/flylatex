import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import isValidTeXFile from '../../../../main/is-valid-tex-file'
import { useEditorContext } from '../../../../shared/context/editor-context'
import useScopeValue from '../../../../shared/hooks/use-scope-value'
// FIXED: 2026-11 用 canEditContent 代替 === 'readOnly' 判断
import { canEditContent } from '../../../ide-react/types/permissions-level'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import SettingsMenuSelect from './settings-menu-select'
import type { Option } from './settings-menu-select'
import type { MainDocument } from '../../../../../../types/project-settings'

export default function SettingsDocument() {
  const { t } = useTranslation()
  const { permissionsLevel } = useEditorContext()
  const [docs] = useScopeValue<MainDocument[] | undefined>('docs')
  const { rootDocId, setRootDocId } = useProjectSettingsContext()

  const validDocsOptions = useMemo(() => {
    const filteredDocs =
      docs?.filter(
        doc => isValidTeXFile(doc.doc.name) || rootDocId === doc.doc.id
      ) ?? []

    const mappedDocs: Array<Option> = filteredDocs.map(doc => ({
      value: doc.doc.id,
      label: doc.path,
    }))

    return mappedDocs
  }, [docs, rootDocId])

  // FIXED: 2026-11 评审者也不能改主文档设置
  if (!canEditContent(permissionsLevel)) {
    return null
  }

  return (
    <SettingsMenuSelect
      onChange={setRootDocId}
      value={rootDocId}
      options={validDocsOptions}
      label={t('main_document')}
      name="rootDocId"
    />
  )
}
