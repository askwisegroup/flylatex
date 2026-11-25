import { ChangeEvent, FC, memo, useCallback } from 'react'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import Tooltip from '../../../shared/components/tooltip'
import { sendMB } from '../../../infrastructure/event-tracking'
import isValidTeXFile from '../../../main/is-valid-tex-file'
import { isMarkdownFile } from '../../../shared/utils/is-markdown-file'
import { useTranslation } from 'react-i18next'
import { PromotionOverlay } from './table-generator/promotion/popover'
import { FeedbackBadge } from '@/shared/components/feedback-badge'

/**
 * FIXED: 2026-11-08 加 readOnly：file-view 里复用这个开关时用。
 * 文件实体没有编辑器，切到「代码编辑器」也没有东西可切 —— 所以只显示状态
 * （可视化编辑器选中），不响应点击。外观/文案/配色与工具条上的完全一致。
 */
type EditorSwitchProps = {
  readOnly?: boolean
}

function EditorSwitch({ readOnly = false }: EditorSwitchProps) {
  const { t } = useTranslation()
  const [newSourceEditor, setNewSourceEditor] = useScopeValue(
    'editor.newSourceEditor'
  )
  const [visual, setVisual] = useScopeValue('editor.showVisual')

  const [docName] = useScopeValue('editor.open_doc_name')
  // FIXED: 2026-11-08 Markdown 也允许进入这个模式（内容换成只读渲染预览，
  // 见 features/ide-react/components/editor/editor-pane.tsx 的 showMarkdownPreview）。
  // 之前只有 TeX 能进，.md 只能看源码。
  const richTextAvailable = isValidTeXFile(docName) || isMarkdownFile(docName)
  // TODO: rename this after legacy & toolbar split tests are complete
  const richTextOrVisual = richTextAvailable && visual

  // FIXED: 2026-11-08 开关状态改成「二选一」的单一判断，不再分别依赖
  // editor.newSourceEditor / richTextAvailable 的取值形态。
  // 之前 checked={!richTextOrVisual && !!newSourceEditor}，只要 newSourceEditor 是
  // undefined（scope 值尚未就绪、或 localStorage 里存了脏值），两个选项就会都不选中 ——
  // 用户看到的就是「代码编辑器/可视化编辑器 两个都没亮」。
  // 现在：isVisual 为假就一定是代码编辑器，恒有且只有一个选中。
  // readOnly（文件视图）：固定显示「可视化编辑器」选中，且不可切换
  const isVisual = readOnly || !!richTextOrVisual
  const isCode = !isVisual

  const handleChange = useCallback(
    event => {
      if (readOnly) {
        return
      }
      const editorType = event.target.value

      switch (editorType) {
        case 'ace':
          setVisual(false)
          setNewSourceEditor(false)
          break

        case 'cm6':
          setVisual(false)
          setNewSourceEditor(true)
          break

        case 'rich-text':
          setVisual(true)
          setNewSourceEditor(true)
          break
      }

      sendMB('editor-switch-change', { editorType })
    },
    [setVisual, setNewSourceEditor, readOnly]
  )

  return (
    <div className="editor-toggle-switch">
      <fieldset
        className="toggle-switch"
        // 只读：整组不接收指针事件（外观保持原样，不做灰色变体）
        style={readOnly ? { pointerEvents: 'none' } : undefined}
        aria-disabled={readOnly || undefined}
      >
        <legend className="sr-only">Editor mode.</legend>

        <input
          type="radio"
          name="editor"
          value="cm6"
          id="editor-switch-cm6"
          className="toggle-switch-input"
          checked={isCode}
          onChange={handleChange}
          disabled={readOnly}
        />
        <label
          htmlFor="editor-switch-cm6"
          className={`toggle-switch-label${
            isCode ? ' toggle-switch-label-active' : ''
          }`}
        >
          <span>{t('code_editor')}</span>
        </label>

        <RichTextToggle
          checked={isVisual}
          disabled={!richTextAvailable}
          handleChange={handleChange}
        />
      </fieldset>

      {!!richTextOrVisual && (
        // <FeedbackBadge
        //   id="visual-editor-feedback"
        //   url="https://forms.gle/AUqHmKNiEH3DRniPA"
        //   text={<VisualEditorFeedbackContent />}
        // />
        <></>
      )}
    </div>
  )
}

const VisualEditorFeedbackContent = () => (
  <>
    We have a new Visual Editor!
    <br />
    Click to give feedback
  </>
)

const RichTextToggle: FC<{
  checked: boolean
  disabled: boolean
  handleChange: (event: ChangeEvent<HTMLInputElement>) => void
}> = ({ checked, disabled, handleChange }) => {
  const { t } = useTranslation()

  const toggle = (
    <span>
      <input
        type="radio"
        name="editor"
        value="rich-text"
        id="editor-switch-rich-text"
        className="toggle-switch-input"
        checked={checked}
        onChange={handleChange}
        disabled={disabled}
      />
      <label
        htmlFor="editor-switch-rich-text"
        className={`toggle-switch-label${
          checked ? ' toggle-switch-label-active' : ''
        }`}
      >
        <span>{t('visual_editor')}</span>
      </label>
    </span>
  )

  if (disabled) {
    return (
      <Tooltip
        description={t('visual_editor_is_only_available_for_tex_files')}
        id="rich-text-toggle-tooltip"
        overlayProps={{ placement: 'bottom' }}
        tooltipProps={{ className: 'tooltip-wide' }}
      >
        {toggle}
      </Tooltip>
    )
  }

  return <PromotionOverlay>{toggle}</PromotionOverlay>
}

export default memo(EditorSwitch)
