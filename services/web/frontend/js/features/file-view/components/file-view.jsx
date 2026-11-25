import { useState, useCallback } from 'react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'

import FileViewHeader from './file-view-header'
import FileViewImage from './file-view-image'
import FileViewPdf from './file-view-pdf'
import FileViewText from './file-view-text'
import { isMarkdownFile } from '../../../shared/utils/is-markdown-file'
import Icon from '../../../shared/components/icon'

const imageExtensions = ['png', 'jpg', 'jpeg', 'gif']

export default function FileView({ file }) {
  const [contentLoading, setContentLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  const { t } = useTranslation()

  const { textExtensions, editableFilenames } = window.ExposedSettings

  const extension = file.name.split('.').pop().toLowerCase()

  const isEditableTextFile =
    textExtensions.includes(extension) ||
    editableFilenames.includes(file.name.toLowerCase())

  const isImageFile = imageExtensions.includes(extension)
  const isPdfFile = extension === 'pdf'
  const isUnpreviewableFile = !isEditableTextFile && !isImageFile && !isPdfFile

  const handleLoad = useCallback(() => {
    setContentLoading(false)
  }, [])

  const handleError = useCallback(() => {
    if (!hasError) {
      setContentLoading(false)
      setHasError(true)
    }
  }, [hasError])

  // FIXED: 2026-11-08 .md 复用 MarkdownPreview 后，下载按钮已经放进它的工具条
  // （AI 按钮左边），这里就不再渲染独占一行的 FileViewHeader。
  // 链接型文件（linkedFileData）例外：它带来源信息，必须保留原来的头部。
  const usesMarkdownPreview =
    isEditableTextFile && isMarkdownFile(file.name) && !file.linkedFileData

  const content = (
    <>
      {!usesMarkdownPreview && <FileViewHeader file={file} />}
      {isImageFile && (
        <FileViewImage
          fileName={file.name}
          fileId={file.id}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
      {isEditableTextFile && (
        <FileViewText file={file} onLoad={handleLoad} onError={handleError} />
      )}
      {isPdfFile && (
        <FileViewPdf
          fileId={file.id}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
    </>
  )

  return (
    // FIXED: 2026-11-08 .md 走 MarkdownPreview 时加个标记类，用来去掉外层留白：
    // 那块视图自带工具条，工具条应该直接贴着顶部（和编辑器里一致），
    // 不该先空出一条 .file-view 的 padding。
    <div
      className={`file-view full-size${
        usesMarkdownPreview ? ' file-view-markdown' : ''
      }`}
    >
      {!hasError && content}
      {!isUnpreviewableFile && contentLoading && <FileViewLoadingIndicator />}
      {(isUnpreviewableFile || hasError) && (
        <p className="no-preview">{t('no_preview_available')}</p>
      )}
    </div>
  )
}

function FileViewLoadingIndicator() {
  const { t } = useTranslation()
  return (
    <div className="loading-panel loading-panel-file-view">
      <span>
        <Icon type="refresh" spin />
        &nbsp;&nbsp;{t('loading')}…
      </span>
    </div>
  )
}

FileView.propTypes = {
  file: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  }).isRequired,
}
