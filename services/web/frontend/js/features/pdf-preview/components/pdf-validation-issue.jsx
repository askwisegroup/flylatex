import { memo, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import PdfLogEntry from './pdf-log-entry'
import { useEditorContext } from '../../../shared/context/editor-context'
import SelectMainFileModal from '../../editor-left-menu/components/select-main-file-modal'

PdfValidationIssue.propTypes = {
  name: PropTypes.string.isRequired,
  issue: PropTypes.any,
}

function PdfValidationIssue({ issue, name }) {
  const { t } = useTranslation()

  switch (name) {
    case 'sizeCheck':
      return (
        <PdfLogEntry
          headerTitle={t('project_too_large')}
          formattedContent={
            <>
              <div>{t('project_too_large_please_reduce')}</div>
              <ul className="list-no-margin-bottom">
                {issue.resources.map(resource => (
                  <li key={resource.path}>
                    {resource.path} &mdash; {resource.kbSize}
                    kb
                  </li>
                ))}
              </ul>
            </>
          }
          entryAriaLabel={t('validation_issue_entry_description')}
          level="error"
        />
      )

    case 'conflictedPaths':
      return (
        <PdfLogEntry
          headerTitle={t('conflicting_paths_found')}
          formattedContent={
            <>
              <div>{t('following_paths_conflict')}</div>
              <ul className="list-no-margin-bottom">
                {issue.map(detail => (
                  <li key={detail.path}>/{detail.path}</li>
                ))}
              </ul>
            </>
          }
          entryAriaLabel={t('validation_issue_entry_description')}
          level="error"
        />
      )

    case 'mainFile':
      return <MainFileIssue />

    default:
      return null
  }
}

// FIXED: 2026-11-10 「主文件不存在」以前只是一句死话：`请选择主文件`，没有按钮。
//   桌面端勉强能去 设置 → 文档 改，移动端那个面板被 CSS 整个隐藏了，谁也改不了
//   —— 编译不出来 → 没有 PDF → AI 助手也跟着没法干活。
//   现在这里直接给出入口：弹窗选一个 .tex，写回 rootDoc，然后重新编译一次。
function MainFileIssue() {
  const { t } = useTranslation()
  const { permissionsLevel } = useEditorContext()
  const [showPicker, setShowPicker] = useState(false)

  const openPicker = useCallback(() => setShowPicker(true), [])
  const closePicker = useCallback(() => setShowPicker(false), [])
  // 复用手动编译那条通路（Ctrl+S / AI 写完文件后都走这个事件）
  const recompile = useCallback(() => {
    window.dispatchEvent(new Event('pdf:recompile'))
  }, [])

  return (
    <>
      <PdfLogEntry
        headerTitle={t('main_file_not_found')}
        formattedContent={
          <div className="main-file-issue">
            <div className="main-file-issue-text">
              {t('please_set_main_file')}
            </div>
            {permissionsLevel !== 'readOnly' && (
              <button
                type="button"
                className="btn btn-primary btn-sm main-file-issue-action"
                onClick={openPicker}
              >
                {t('select_main_file')}
              </button>
            )}
          </div>
        }
        entryAriaLabel={t('validation_issue_entry_description')}
        level="error"
      />
      {permissionsLevel !== 'readOnly' && (
        <SelectMainFileModal
          show={showPicker}
          onHide={closePicker}
          onSelected={recompile}
        />
      )}
    </>
  )
}

export default memo(PdfValidationIssue)
