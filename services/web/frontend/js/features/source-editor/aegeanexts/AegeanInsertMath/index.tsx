import { Modal } from 'react-bootstrap'
import { useRef, memo, useCallback, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useCodeMirrorViewContext } from '../../components/codemirror-editor'
import AccessibleModal from '@/shared/components/accessible-modal'
import { EditorView } from '@codemirror/view'
import { ToolbarButton } from '../../components/toolbar/toolbar-button'
import VMath from './VMath'

export const AegeanInsertMathDropdown = memo(
  function AegeanInsertMathDropdown() {
    const { t } = useTranslation()
    const view = useCodeMirrorViewContext()
    const [dlgShow, setDlgShow] = useState(false)
    const onHide = useCallback(() => {
      setDlgShow(false)
    }, [view])

    const vMathRef = useRef(null)

    // Listen for custom event to open math dialog from IDE menu bar
    useEffect(() => {
      const handleInsertMath = () => {
        setDlgShow(true)
      }
      window.addEventListener('aegean:insert-math', handleInsertMath)
      window.addEventListener('editor:insert-math', handleInsertMath)
      return () => {
        window.removeEventListener('aegean:insert-math', handleInsertMath)
        window.removeEventListener('editor:insert-math', handleInsertMath)
      }
    }, [])

    return (
      <>
        <ToolbarButton
          id="toolbar-math"
          label={t('toolbar_insert_math')}
          icon="calculator"
          command={(view: EditorView) => {
            // show AccessibleModal
            setDlgShow(true)
          }}
        />
        <AccessibleModal
          onHide={onHide}
          className="figure-modal"
          show={dlgShow}
          backdrop="static"
          keyboard={false}
        >
          <Modal.Header closeButton>
            <Modal.Title>{t('toolbar_insert_math')}</Modal.Title>
          </Modal.Header>

          <Modal.Body>
            <VMath ref={vMathRef} />
          </Modal.Body>

          <Modal.Footer>
            {/* FIXED: 2026-10-30 原生 <button> 没有 class，用的是浏览器默认样式 */}
            <button
              className="btn btn-primary"
              onClick={() => {
                const getExpression = (vMathRef.current as any).getExpression
                if (getExpression) {
                  let e = getExpression()()
                  if (e) {
                    if (view.state.readOnly) {
                      return false
                    }
                    const { from, to } = view.state.selection.main
                    // insert latex expression to selection
                    view.dispatch({
                      changes: { from, to, insert: '\\(' + e + '\\)' },
                    })
                    // close dialog
                    setDlgShow(false)
                  }
                }
              }}
            >
              {t('toolbar_insert_inline_math')}
            </button>
            &nbsp;&nbsp;
            {/* FIXED: 2026-10-30 原生 <button> 没有 class，用的是浏览器默认样式 */}
            <button
              className="btn btn-primary"
              onClick={() => {
                const getExpression = (vMathRef.current as any).getExpression
                if (getExpression) {
                  let e = getExpression()()
                  if (e) {
                    if (view.state.readOnly) {
                      return false
                    }
                    const { from, to } = view.state.selection.main
                    // insert latex expression to selection
                    view.dispatch({
                      changes: { from, to, insert: '\\[' + e + '\\]' },
                    })
                    // close dialog
                    setDlgShow(false)
                  }
                }
              }}
            >
              {t('toolbar_insert_display_math')}
            </button>
          </Modal.Footer>
        </AccessibleModal>
      </>
    )
  }
)
