import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { useProjectContext } from '../../../shared/context/project-context'
import { debugConsole } from '@/utils/debugging'
import MarkdownPreview from '../../source-editor/components/markdown-preview'
import { isMarkdownFile } from '../../../shared/utils/is-markdown-file'

const MAX_FILE_SIZE = 2 * 1024 * 1024

export default function FileViewText({ file, onLoad, onError }) {
  const { _id: projectId } = useProjectContext({
    _id: PropTypes.string.isRequired,
  })

  const [textPreview, setTextPreview] = useState('')
  const [shouldShowDots, setShouldShowDots] = useState(false)
  const [inFlight, setInFlight] = useState(false)

  useEffect(() => {
    if (inFlight) {
      return
    }
    let path = `/project/${projectId}/file/${file.id}`
    fetch(path, { method: 'HEAD' })
      .then(response => {
        if (!response.ok) throw new Error('HTTP Error Code: ' + response.status)
        return response.headers.get('Content-Length')
      })
      .then(fileSize => {
        let truncated = false
        let maxSize = null
        if (fileSize > MAX_FILE_SIZE) {
          truncated = true
          maxSize = MAX_FILE_SIZE
        }

        if (maxSize != null) {
          path += `?range=0-${maxSize}`
        }
        return fetch(path).then(response => {
          return response.text().then(text => {
            if (truncated) {
              text = text.replace(/\n.*$/, '')
            }

            setTextPreview(text)
            onLoad()
            setShouldShowDots(truncated)
          })
        })
      })
      .catch(err => {
        debugConsole.error(err)
        onError()
      })
      .finally(() => {
        setInFlight(false)
      })
  }, [projectId, file.id, onError, onLoad, inFlight])
  // FIXED: 2026-11-08 方案 A：一点数据都不动，也不新增任何渲染实现。
  // 存成 file 实体的 .md 复用下午写的整块视图——MarkdownPreview：
  // 同一个工具条（代码编辑器｜可视化编辑器 + 提示 + AI 按钮）、同一份正文
  // （MarkdownPreviewBody）、同一套 .markdown-preview-body 样式。
  // 唯一区别：文件不能编辑，所以开关传 readOnly —— 固定显示「可视化编辑器」选中，
  // 点击不切换（文件实体没有编辑器可切）。
  // .txt 不算 Markdown，仍按裸文本显示。
  const isMarkdown = isMarkdownFile(file.name)

  return (
    // FIXED: 2026-11-08 这个根 div 是 .file-view 的 flex 子项，之前它没有类名、
    // 高度是 auto —— 它把上面传下来的剩余高度吞掉了，导致 .text-preview 的
    // flex:1 1 auto 完全无效，正文永远撑不开、也就永远没有滚动条。
    // 这里给它一个类名，让 .file-view-markdown 分支把它接进 flex 链。
    <div className="file-view-text-root">
      {textPreview && (
        <div className="text-preview">
          {isMarkdown ? (
            <MarkdownPreview
              markdown={textPreview}
              downloadUrl={`/project/${projectId}/file/${file.id}`}
            />
          ) : (
            <div className="scroll-container">
              <p>{textPreview}</p>
              {shouldShowDots && <p>...</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

FileViewText.propTypes = {
  file: PropTypes.shape({ id: PropTypes.string, name: PropTypes.string })
    .isRequired,
  onLoad: PropTypes.func.isRequired,
  onError: PropTypes.func.isRequired,
}
