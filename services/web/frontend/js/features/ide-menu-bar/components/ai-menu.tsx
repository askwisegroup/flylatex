import { useCallback, useEffect, useState, ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Dropdown, MenuItem, Modal, Button, Alert } from 'react-bootstrap'
import AccessibleModal from '../../../shared/components/accessible-modal'
import Icon from '../../../shared/components/icon'
import MaterialIcon from '@/shared/components/material-icon'
import { showToast } from '../../../shared/utils/toast'
import {
  TargetLang,
  TARGET_LANGS,
  TARGET_LANG_LABEL_KEY,
  storeTargetLang,
} from '../../../shared/utils/translate-lang'

const FETCH_AI_BASE = '/ft-ai'

function AIMenu() {
  const { t } = useTranslation()
  const [showModal, setShowModal] = useState(false)
  const [content, setContent] = useState<string | ReactElement>('')
  const [copyableContent, setCopyableContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [showAlert, setShowAlert] = useState(false)
  // FIXED: 2026-10-29 记录本次请求的模式/原文/目标语言，供弹窗内切换语言重新翻译
  const [lastMode, setLastMode] = useState('')
  const [sourceText, setSourceText] = useState('')
  // FIXED: 2026-11-09 默认不预选目标语言：打开翻译先停住，等用户选了再发请求。
  // OLD: const [targetLang, setTargetLang] = useState<TargetLang>(readStoredTargetLang)
  const [targetLang, setTargetLang] = useState<TargetLang | ''>('')
  // FIXED: 2026-10-29 AI 面板开合状态：面板自己通过 editor:ai-chat-state 广播
  const [chatIsOpen, setChatIsOpen] = useState(false)

  // 真正发请求：翻译可指定目标语言；切换语言时用同一段原文重发
  const runAIRequest = useCallback(
    async (mode: string, text: string, lang: TargetLang | '') => {
      setIsLoading(true)
      setShowModal(true)
      setLastMode(mode)
      setSourceText(text)
      setContent(
        mode === 'translate'
          ? t('translating_please_wait')
          : t('processing_please_wait')
      )

      try {
        const res = await fetch(FETCH_AI_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            mode === 'translate'
              ? { text, mode, targetLang: lang }
              : { text, mode }
          ),
        })
        if (!res.ok) {
          // FIXED: 2026-10-30 带出服务端真实原因
          let detail = `HTTP ${res.status}`
          try {
            const errorBody = await res.json()
            detail = errorBody?.msg || errorBody?.error || detail
          } catch {
            // 非 JSON 响应，保留状态码
          }
          throw new Error(detail)
        }

        const data = await res.json()
        const _data = data.data

        if (_data) {
          if (mode === 'translate') {
            const copyText = `${t('original_content')}:\n${text.substring(
              0,
              500
            )}${text.length > 500 ? '...' : ''}\n\n${t(
              'translated_content'
            )}:\n${_data}`
            setCopyableContent(copyText)
            setContent(
              <>
                {t('original_content')}:<br /> {text.substring(0, 500)}
                {text.length > 500 ? '...' : ''}
                <hr />
                {t('translated_content')}：<br />
                {_data}
              </>
            )
          } else if (mode === 'summary') {
            setCopyableContent(_data)
            setContent(
              <>
                {t('summary')}:<br />
                <br />
                {_data}
              </>
            )
          } else if (mode === 'abstract') {
            setCopyableContent(_data)
            setContent(
              <>
                {t('abstract')}:<br />
                <br />
                {_data}
              </>
            )
          }
        } else {
          setContent(
            data && data.msg
              ? `${t('service_error')}：${data.msg}`
              : t('service_error')
          )
          setCopyableContent('')
        }
      } catch (err) {
        console.error('[AI menu] request failed:', err)
        setContent(
          err && (err as Error).message
            ? `${t('service_error')}：${(err as Error).message}`
            : t('service_error')
        )
        setCopyableContent('')
      } finally {
        setIsLoading(false)
      }
    },
    [t]
  )

  const handleAIRequest = useCallback(
    (mode: string) => {
      const selection = window.getSelection()
      const selected =
        selection && selection.toString() ? selection.toString() : ''

      // FIXED: 2026-10-29 翻译只针对选中的内容。
      // 以前没有选中会退化成"拿整篇文档去翻译"，既慢又不是用户想要的，
      // 现在直接提示先选中要翻译的内容。
      if (mode === 'translate') {
        if (!selected.trim()) {
          showToast(t('translate_no_selection'), {
            duration: 2600,
            fadeOut: true,
          })
          return
        }
        // FIXED: 2026-11-09 每次都先停在弹窗等用户选目标语言，不预选、不发请求
        setTargetLang('')
        setLastMode('translate')
        setSourceText(selected)
        setContent(t('please_select_target_language_to_start'))
        setShowModal(true)
        return
      }

      let text = selected
      if (!text) {
        const editorContent = document.querySelector('.cm-content')
        if (editorContent) {
          text = editorContent.textContent || ''
        }
      }

      if (!text) {
        setContent(t('document_is_empty'))
        setLastMode(mode)
        setShowModal(true)
        return
      }

      runAIRequest(mode, text, targetLang)
    },
    [runAIRequest, targetLang, t]
  )

  // 弹窗里切换目标语言：记忆选择并立即重新翻译
  const handleTargetLangChange = useCallback(
    (lang: TargetLang | '') => {
      setTargetLang(lang)
      if (!lang) {
        return
      }
      storeTargetLang(lang)
      if (!isLoading && sourceText) {
        runAIRequest('translate', sourceText, lang)
      }
    },
    [isLoading, runAIRequest, sourceText]
  )

  // FIXED: 2026-10-29 面板的实际开合状态由它自己广播（editor:ai-chat-state），
  // 菜单按真实状态显示"打开对话/关闭对话"，不再靠猜。
  useEffect(() => {
    const handleState = (e: Event) => {
      const detail = (e as CustomEvent<{ open: boolean }>).detail
      setChatIsOpen(Boolean(detail && detail.open))
    }
    window.addEventListener('editor:ai-chat-state', handleState)
    return () => window.removeEventListener('editor:ai-chat-state', handleState)
  }, [])

  const handleToggleChat = useCallback(() => {
    // 注意：这里只发 editor:toggle-ai-chat。
    // 旧版 Angular 编辑器与新版 React IDE 都挂着 CodeMirrorAIChat（它监听这个事件），
    // 而 chat:toggle-ai 只有新版 IDE 的另一个面板在听 —— 同时发会开出两个面板。
    window.dispatchEvent(new CustomEvent('editor:toggle-ai-chat'))
  }, [])

  const handleCopyContent = useCallback(async () => {
    if (copyableContent) {
      try {
        await navigator.clipboard.writeText(copyableContent)
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 2000)
      } catch (err) {
        console.error('Copy failed:', err)
      }
    }
  }, [copyableContent])

  const closeModal = useCallback(() => {
    if (!isLoading) {
      setShowModal(false)
      setCopyableContent('')
    }
  }, [isLoading])

  return (
    <>
      <Dropdown id="ide-menu-ai" pullRight className="ide-menu-dropdown">
        <Dropdown.Toggle noCaret className="ide-menu-toggle">
          AI
        </Dropdown.Toggle>
        <Dropdown.Menu className="ide-menu-dropdown-menu">
          <MenuItem onClick={() => handleAIRequest('translate')}>
            <MaterialIcon type="123" /> {t('toolbar_translate_content')}
          </MenuItem>
          <MenuItem onClick={() => handleAIRequest('summary')}>
            <MaterialIcon type="cycle" /> {t('toolbar_document_summary')}
          </MenuItem>
          <MenuItem onClick={() => handleAIRequest('abstract')}>
            <MaterialIcon type="rebase" /> {t('toolbar_generate_abstract')}
          </MenuItem>
          <MenuItem divider />
          <MenuItem onClick={handleToggleChat}>
            <Icon type="comments" fw />{' '}
            {chatIsOpen ? t('close_chat') : t('open_chat')}
          </MenuItem>
        </Dropdown.Menu>
      </Dropdown>

      <AccessibleModal
        onHide={closeModal}
        className="ide-ai-modal"
        show={showModal}
        backdrop="static"
        keyboard={false}
      >
        <Modal.Header closeButton={!isLoading}>
          <Modal.Title>{t('ai_assistant')}</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          {/* FIXED: 2026-11-01 颜色不在这里定，交给 .ide-ai-modal .alert
              （@fl-alert-success-*）：bootstrap 的 .alert-info 底色是写死的 @ol-blue，
              亮色调（绿）/ 柔和色调（陶土）里会杵一块蓝的 */}
          {showAlert && (
            <Alert bsStyle="info">{t('content_copied_to_clipboard')}</Alert>
          )}
          {/* FIXED: 2026-10-29 翻译结果弹窗支持切换目标语言（源语言由模型自动判断） */}
          {lastMode === 'translate' && (
            <div className="ide-ai-modal-language">
              <label htmlFor="ide-ai-target-lang">
                {t('translate_target_language')}
              </label>
              <select
                id="ide-ai-target-lang"
                value={targetLang}
                disabled={isLoading}
                onChange={e =>
                  handleTargetLangChange(e.target.value as TargetLang | '')
                }
              >
                {!targetLang && (
                  <option value="">{t('please_select_target_language')}</option>
                )}
                {TARGET_LANGS.map(lang => (
                  <option key={lang} value={lang}>
                    {t(TARGET_LANG_LABEL_KEY[lang])}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div
            className="ide-ai-modal-content"
            onClick={handleCopyContent}
            style={{
              cursor: copyableContent ? 'pointer' : 'default',
            }}
          >
            {content}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button onClick={closeModal} disabled={isLoading}>
            {isLoading ? t('processing') : t('ok')}
          </Button>
        </Modal.Footer>
      </AccessibleModal>
    </>
  )
}

export default AIMenu
