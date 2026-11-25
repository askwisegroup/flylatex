// @ts-nocheck
import React, { memo, useState, ReactElement, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useCodeMirrorViewContext } from "../../components/codemirror-editor";
import { ToolbarButtonMenu } from "../../components/toolbar/button-menu";
import { ListGroupItem, Modal, Button, Alert } from "react-bootstrap";
import MaterialIcon from "@/shared/components/material-icon";
import AccessibleModal from '@/shared/components/accessible-modal';
import i18nPromise from '../../../../i18n';

const FETCH_AI_BASE = '/ft-ai';

export const AITools = memo(function AITools() {
  const { t, i18n } = useTranslation()
  const view = useCodeMirrorViewContext()
  const [dlgShow, setDlgShow] = useState(false)
  const [content, setContent] = useState<string | ReactElement>('')
  const [pureText, setPureText] = useState<string>('')
  const [showAlert, setShowAlert] = useState(false)
  const [showError, setShowError] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    i18nPromise.then(() => {
      i18n.reloadResources()
    })
  }, [])

  // 添加设备和浏览器检测调试信息
  // useEffect(() => {
  //   if (typeof window !== 'undefined') {
  //     console.log('AITools - Device and Browser Info:', {
  //       userAgent: navigator.userAgent,
  //       platform: navigator.platform,
  //       touchSupport: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
  //       isMac: /Mac|iPhone|iPod|iPad/i.test(navigator.platform),
  //       isEdge: /Edg/i.test(navigator.userAgent),
  //       isWebKit: /WebKit/i.test(navigator.userAgent),
  //       screenSize: `${screen.width}x${screen.height}`,
  //       viewportSize: `${window.innerWidth}x${window.innerHeight}`
  //     })
  //   }
  // }, [])

  const onHide = () => {
    if (!isLoading) {
      setDlgShow(false)
    }
  }

  // Add event handlers to prevent modal from closing accidentally
  const handleModalClick = useCallback((e: any) => {
    // console.log('AITools Modal click event:', e.type, e.target, e.currentTarget)
    // 完全阻止模态框内容的点击事件传播
    e.stopPropagation()
    e.preventDefault()
  }, [])

  const handleBackdropClick = useCallback((e: any) => {
    // console.log('AITools Backdrop click event:', e.type, e.target, e.currentTarget)
    // Only close modal if clicking the backdrop (not the content)
    if (e.target === e.currentTarget) {
      // console.log('Closing AITools modal via backdrop click')
      onHide()
    }
  }, [onHide])

  const getSelectedText = () => {
    const { from, to } = view.state.selection.main;
    return view.state.doc.sliceString(from, to)
  }

  const getAllText = () => {
    return view.state.doc.toString();
  }

  const handleDoubleClick = async () => {
    if (!pureText) return;
    try {
      await navigator.clipboard.writeText(pureText);
      showAlertAndClose();
    } catch (err) {
      showErrorAndClose();
    }
  };

  const showAlertAndClose = () => {
    setShowAlert(true);
    setTimeout(() => {
      setShowAlert(false);
    }, 3000);
  }

  const showErrorAndClose = () => {
    setShowError(true);
    setTimeout(() => {
      setShowError(false);
    }, 3000);
  }

  const handleAIRequest = async (text: string, mode: string, initialMessage: string) => {
    if (!text) {
      setContent(mode === 'translate' ? t('please_select_text_to_translate') : t('document_is_empty'));
      setDlgShow(true);
      return;
    }

    setIsLoading(true);
    setDlgShow(true);
    setContent(initialMessage);

    try {
      const res = await fetch(FETCH_AI_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          mode
        })
      });
      const data = await res.json();
      const _data = data.data;

      if (_data) {
        setPureText(_data);
        if (mode === 'translate') {
          setContent(
            <>
              {t('original_content')}:<br /> {text}
              <hr />
              {t('translated_content')}：<br />{_data}
            </>
          );
        } else if (mode === 'summary') {
          setContent(<>{t('summary')}:<br /><br />{_data}</>);
        } else if (mode === 'abstract') {
          setContent(<>{t('abstract')}:<br /><br />{_data}</>);
        }
      } else {
        setContent(t('service_error'));
      }
    } catch (err) {
      setContent(t('service_error'));
    } finally {
      setIsLoading(false);
    }
  };
  
  return (
    <>
      <ToolbarButtonMenu
        id="toolbar-ai-tools"
        label={t('toolbar_ai_tools')}
        icon="face"
        materialIcon
      >
        <ListGroupItem
          onClick={(e: any) => {
            e.preventDefault()
            e.stopPropagation()
            const text = getSelectedText();
            handleAIRequest(text, 'translate', t('translating_please_wait'));
          }}
          onTouchStart={(e: any) => e.stopPropagation()}
          onTouchEnd={(e: any) => e.stopPropagation()}
          onMouseDown={(e: any) => e.stopPropagation()}
          onMouseUp={(e: any) => e.stopPropagation()}
        >
          <MaterialIcon type="123" />
          {t('toolbar_translate_content')}
        </ListGroupItem>
        <ListGroupItem
          onClick={(e: any) => {
            e.preventDefault()
            e.stopPropagation()
            const text = getAllText();
            handleAIRequest(text, 'summary', t('processing_please_wait'));
          }}
          onTouchStart={(e: any) => e.stopPropagation()}
          onTouchEnd={(e: any) => e.stopPropagation()}
          onMouseDown={(e: any) => e.stopPropagation()}
          onMouseUp={(e: any) => e.stopPropagation()}
        >
          <MaterialIcon type="cycle" />
          {t('toolbar_document_summary')}
        </ListGroupItem>
        <ListGroupItem
          onClick={(e: any) => {
            e.preventDefault()
            e.stopPropagation()
            const text = getAllText();
            handleAIRequest(text, 'abstract', t('processing_please_wait'));
          }}
          onTouchStart={(e: any) => e.stopPropagation()}
          onTouchEnd={(e: any) => e.stopPropagation()}
          onMouseDown={(e: any) => e.stopPropagation()}
          onMouseUp={(e: any) => e.stopPropagation()}
        >
          <MaterialIcon type="rebase" />
          {t('toolbar_generate_abstract')}
        </ListGroupItem>
      </ToolbarButtonMenu>

      <AccessibleModal 
        onHide={onHide} 
        className="figure-modal" 
        show={dlgShow} 
        backdrop="static" 
        keyboard={false}
        onClick={handleBackdropClick}
        onTouchStart={(e: any) => e.stopPropagation()}
        onTouchEnd={(e: any) => e.stopPropagation()}
        onMouseDown={(e: any) => e.stopPropagation()}
        onMouseUp={(e: any) => e.stopPropagation()}
        style={{
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent'
        }}
      >
        <Modal.Header closeButton={!isLoading}>
          <Modal.Title>
            {t('ai_assistant')}
          </Modal.Title>
        </Modal.Header>

        <Modal.Body
          onClick={handleModalClick}
          onTouchStart={(e: any) => e.stopPropagation()}
          onTouchEnd={(e: any) => e.stopPropagation()}
          onMouseDown={(e: any) => e.stopPropagation()}
          onMouseUp={(e: any) => e.stopPropagation()}
        >
          <div 
            style={{ 
              padding: '0',
              pointerEvents: 'auto',
              position: 'relative',
              zIndex: 9999
            }}
            onClick={(e: any) => e.stopPropagation()}
            onTouchStart={(e: any) => e.stopPropagation()}
            onTouchEnd={(e: any) => e.stopPropagation()}
            onMouseDown={(e: any) => e.stopPropagation()}
            onMouseUp={(e: any) => e.stopPropagation()}
          >
            {showAlert ? (<Alert bsStyle="info">{t('content_copied_to_clipboard')}</Alert>) : null}
            {showError ? (<Alert bsStyle="danger">{t('copy_failed')}</Alert>) : null}
            <div 
              onClick={handleDoubleClick}
              onTouchStart={(e: any) => e.stopPropagation()}
              onTouchEnd={(e: any) => e.stopPropagation()}
              onMouseDown={(e: any) => e.stopPropagation()}
              onMouseUp={(e: any) => e.stopPropagation()}
              style={{ cursor: 'pointer' }}
            >
              {content}
            </div>
          </div>
        </Modal.Body>

        <Modal.Footer>
          {/* FIXED: 2026-10-30 这是弹窗里唯一的操作按钮，原来没有 bsStyle，
              渲染成灰蓝的 .btn-default，主题主色不生效 */}
          <Button
            bsStyle="primary"
            onClick={(e: any) => {
              e.preventDefault()
              e.stopPropagation()
              onHide()
            }}
            onTouchStart={(e: any) => e.stopPropagation()}
            onTouchEnd={(e: any) => e.stopPropagation()}
            onMouseDown={(e: any) => e.stopPropagation()}
            onMouseUp={(e: any) => e.stopPropagation()}
            disabled={isLoading}
          >{isLoading ? t('processing') : t('ok')}</Button>
        </Modal.Footer>
      </AccessibleModal>
    </>
  )
})

