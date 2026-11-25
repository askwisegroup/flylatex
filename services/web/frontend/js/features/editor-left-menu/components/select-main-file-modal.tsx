import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Modal } from 'react-bootstrap'
import classnames from 'classnames'
import AccessibleModal from '../../../shared/components/accessible-modal'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import isValidTeXFile from '../../../main/is-valid-tex-file'
import useSaveProjectSettings from '../hooks/use-save-project-settings'
import { debugConsole } from '@/utils/debugging'
import type { MainDocument } from '../../../../../types/project-settings'

// FIXED: 2026-11-10 主文件（rootDoc）选择弹窗。
//   以前「改主文件」只有 设置 → 文档 里的一个 <select>，而那个面板在移动端被
//   mobile-pdf-only.less 整个隐藏，预览区报「主文件不存在」时用户无路可走。
//   这里把选择逻辑抽成独立弹窗：预览区可以直接弹出它，设置面板以后也能复用。
//   写入仍然走 useSaveProjectSettings（= POST /project/:id/settings + 同步
//   angular scope 上的 project.rootDoc_id），没有新增后端接口。

const MAIN_FILE_NAME_RE = /^main\.(tex|Rtex|Rnw|Rmd)$/i

type Props = {
  show: boolean
  onHide: () => void
  // 设置成功后的回调：预览区用它触发一次重新编译
  onSelected?: (docId: string) => void
}

export default function SelectMainFileModal({
  show,
  onHide,
  onSelected,
}: Props) {
  const { t } = useTranslation()
  const [docs] = useScopeValue<MainDocument[] | undefined>('docs')
  const [project] = useScopeValue<{ rootDoc_id?: string | null } | undefined>(
    'project',
    true
  )
  const saveProjectSettings = useSaveProjectSettings()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 候选：只留 .tex 类文档。排序规则 —— 名字是 main.* 的排最前，其次目录
  // 浅的优先，最后按路径字典序。这样最可能是主文件的就在列表顶上，
  // 不必为了猜主文件把整个项目的内容都拉下来。
  const candidates = useMemo(() => {
    return (docs ?? [])
      .filter(doc => isValidTeXFile(doc.doc.name))
      .slice()
      .sort((a, b) => {
        const aIsMain = MAIN_FILE_NAME_RE.test(a.doc.name) ? 0 : 1
        const bIsMain = MAIN_FILE_NAME_RE.test(b.doc.name) ? 0 : 1
        if (aIsMain !== bIsMain) {
          return aIsMain - bIsMain
        }
        const aDepth = (a.path.match(/\//g) || []).length
        const bDepth = (b.path.match(/\//g) || []).length
        if (aDepth !== bDepth) {
          return aDepth - bDepth
        }
        return a.path.localeCompare(b.path)
      })
  }, [docs])

  const recommendedId = candidates[0]?.doc.id
  const currentRootDocId = project?.rootDoc_id ?? null

  // 每次打开都重置：默认选中当前主文件，没有主文件时选中建议的那个
  useEffect(() => {
    if (!show) {
      return
    }
    setError(null)
    setSaving(false)
    setSelectedId(currentRootDocId ?? recommendedId ?? null)
  }, [show, currentRootDocId, recommendedId])

  const handleConfirm = useCallback(async () => {
    if (!selectedId || saving) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await saveProjectSettings('rootDocId', selectedId)
      onSelected?.(selectedId)
      onHide()
    } catch (err) {
      debugConsole.error('[select-main-file] failed to set root doc', err)
      setError(t('setting_main_file_failed'))
    } finally {
      setSaving(false)
    }
  }, [selectedId, saving, saveProjectSettings, onSelected, onHide, t])

  return (
    <AccessibleModal
      show={show}
      onHide={saving ? () => {} : onHide}
      id="select-main-file-modal"
      className="select-main-file-modal"
    >
      <Modal.Header closeButton>
        <Modal.Title>{t('select_main_file')}</Modal.Title>
      </Modal.Header>

      <Modal.Body>
        <p className="select-main-file-hint">
          <Trans
            i18nKey="select_main_file_hint"
            components={[<code key="documentclass" />]}
          />
        </p>

        {error && (
          <p className="select-main-file-error" role="alert">
            {error}
          </p>
        )}

        {candidates.length === 0 ? (
          <p className="select-main-file-hint">{t('select_main_file_empty')}</p>
        ) : (
          <ul className="select-main-file-list">
            {candidates.map((doc, index) => {
              const docId = doc.doc.id
              const isSuggested = index === 0
              return (
                <li key={docId}>
                  <label
                    className={classnames('select-main-file-item', {
                      'is-selected': docId === selectedId,
                    })}
                  >
                    <input
                      type="radio"
                      name="select-main-file"
                      value={docId}
                      checked={docId === selectedId}
                      onChange={() => setSelectedId(docId)}
                    />
                    <span className="select-main-file-path">{doc.path}</span>
                    {isSuggested && (
                      <span className="select-main-file-badge">
                        {t('select_main_file_recommended')}
                      </span>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </Modal.Body>

      <Modal.Footer>
        <button
          type="button"
          className="btn btn-default"
          onClick={onHide}
          disabled={saving}
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleConfirm}
          disabled={!selectedId || saving}
        >
          {saving ? t('saving') : t('set_main_file_and_recompile')}
        </button>
      </Modal.Footer>
    </AccessibleModal>
  )
}
