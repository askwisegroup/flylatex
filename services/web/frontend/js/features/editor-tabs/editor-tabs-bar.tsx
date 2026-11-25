import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import classNames from 'classnames'
import { getPanel } from '@codemirror/view'
import { useCodeMirrorViewContext } from '@/features/source-editor/components/codemirror-editor'
import { createEditorTabsPanel } from '@/features/source-editor/extensions/editor-tabs-panel'
import useScopeValue from '@/shared/hooks/use-scope-value'
import { useIdeContext } from '@/shared/context/ide-context'
import withErrorBoundary from '@/infrastructure/error-boundary'
import { useEditorTabs } from './use-editor-tabs'
import { closeTab, isTabsEnabled, setTabsEnabled } from './editor-tabs-store'
import { showToast } from '@/shared/utils/toast'

/**
 * FIXED: 2026-11-16 编辑器多文件页签（路线 B）。
 *
 * 行为约定（刻意保守）：
 *   1. 只有打开过 2 个以上文件时才出现，单文件用户不会看到多出来的一条横栏；
 *   2. 切换 = 调原来的 editorManager.openDocId，编辑器内部逻辑一行不动；
 *   3. 关闭当前页签时先切到右邻居（没有则左邻居），最后剩 1 个页签时不再消失前先切换，
 *      避免编辑器停在一个已经被关掉的文档上；
 *   4. 中键关闭、键盘 Enter/空格切换、Delete 关闭；不做拖拽排序（v2 再说）。
 *
 * FIXED: 2026-11-16 线上事故修复：这里原来用 `useEditorManagerContext()`，
 * 那是**React IDE 专属** Context。旧版（Angular）编辑器页面的 Provider 树是
 * ContextRoot，里面只有 EditorProvider，没有 EditorManagerProvider —— 于是
 * 每次打开项目都抛「useEditorManagerContext is only available inside EditorManagerProvider」，
 * 被编辑器错误边界接住，整页变成「抱歉，出错了」。
 * 改用两棵树都有的 `useIdeContext().editorManager`（React IDE 里它也是被挂到
 * ide 对象上的那一个，见 editor-manager-context.tsx:646），并给整块加静默错误边界：
 * 页签这种东西再出问题最多是不出现，绝不能连累编辑器。
 *
 * 文案直接用中文：本项目默认 zh-CN，新增的其它设置区块也是同样处理，
 * 不走 i18n 可以少动 8 个语言包与 extracted-translations 白名单。
 */
function EditorTabsBar() {
  const view = useCodeMirrorViewContext()
  const panel = getPanel(view, createEditorTabsPanel)

  if (!panel) {
    return null
  }

  return createPortal(<EditorTabs />, panel.dom)
}

function EditorTabs() {
  const [openDocId] = useScopeValue<string | null>('editor.open_doc_id')
  const [openDocName] = useScopeValue<string | null>('editor.open_doc_name')
  // 两棵树唯一共有的「打开文档」入口：Angular EditorManager / React EditorManager
  // 都被挂到 ide.editorManager 上
  const { editorManager } = useIdeContext()
  const openDocument = useCallback(
    (docId: string) => {
      editorManager?.openDocId?.(docId)
    },
    [editorManager]
  )
  const tabs = useEditorTabs(openDocId ?? null, openDocName ?? null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const [confirmHide, setConfirmHide] = useState(false)

  // Esc 关掉确认框（不收起页签栏）
  useEffect(() => {
    if (!confirmHide) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConfirmHide(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmHide])

  // 激活的页签滚动到可见区域（页签多到横向溢出时不至于「切过去了但看不见」）
  useEffect(() => {
    const active = stripRef.current?.querySelector('.ol-cm-editor-tab-active')
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [openDocId, tabs.length])

  const handleClose = useCallback(
    (id: string) => {
      if (id === openDocId) {
        const index = tabs.findIndex(tab => tab.id === id)
        const neighbor = tabs[index + 1] ?? tabs[index - 1]
        if (!neighbor) {
          // 最后一个页签：关掉它编辑器就空了，直接不响应
          return
        }
        openDocument(neighbor.id)
      }
      closeTab(id)
    },
    [openDocId, openDocument, tabs]
  )

  // 用户关掉了页签栏（设置里，或点了右端的收起按钮）
  if (!isTabsEnabled() || tabs.length < 2) {
    return null
  }

  return (
    <div
      className="ol-cm-editor-tabs"
      role="tablist"
      aria-label="打开的文件"
      ref={stripRef}
    >
      {tabs.map(tab => {
        const isActive = tab.id === openDocId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            title={tab.name}
            className={classNames('ol-cm-editor-tab', {
              'ol-cm-editor-tab-active': isActive,
            })}
            onClick={() => {
              if (!isActive) {
                openDocument(tab.id)
              }
            }}
            onAuxClick={event => {
              // 中键关闭
              if (event.button === 1) {
                event.preventDefault()
                handleClose(tab.id)
              }
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openDocument(tab.id)
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault()
                handleClose(tab.id)
              }
            }}
          >
            <span className="ol-cm-editor-tab-name">{tab.name}</span>
            <button
              type="button"
              className="ol-cm-editor-tab-close"
              aria-label={`关闭 ${tab.name}`}
              title="关闭"
              // mousedown 上拦一下，点关闭时不要把焦点从编辑器抢走
              onMouseDown={event => event.preventDefault()}
              onClick={event => {
                event.stopPropagation()
                handleClose(tab.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      {/*
        FIXED: 2026-11-16 反馈「最右边那个像『更多』的按钮，原来是把页签栏关掉」：
        换成带文字的小胶囊「收起」，并在收起时给一句 toast 指明从哪里再打开
        （工具 → 显示文件页签 / 设置 → 编辑器 → 文件页签）。
      */}
      <button
        type="button"
        className="ol-cm-editor-tabs-hide"
        title="收起文件页签栏（可在 工具 → 显示文件页签 重新打开）"
        aria-label="收起文件页签栏"
        onMouseDown={event => event.preventDefault()}
        onClick={() => setConfirmHide(true)}
      >
        <span className="ol-cm-editor-tabs-hide-icon" aria-hidden="true">
          ⌃
        </span>
        收起
      </button>

      {/* FIXED: 2026-11-16 收起前先确认一次；确认框里直接告诉用户「去哪里再打开」，
          免得像上次那样收起后完全找不到入口。portal 到 body，避免被编辑器容器裁切。 */}
      {confirmHide &&
        createPortal(
          <div className="fl-editor-tabs-confirm-backdrop" role="presentation">
            {/* 点遮罩关闭：用真正的 button 覆盖整块区域，语义与键盘可达性都正确 */}
            <button
              type="button"
              className="fl-editor-tabs-confirm-mask"
              aria-label="取消"
              onClick={() => setConfirmHide(false)}
            />
            <div
              className="fl-editor-tabs-confirm"
              role="dialog"
              aria-modal="true"
              aria-label="收起文件页签栏"
            >
              <div className="fl-editor-tabs-confirm-title">
                要收起文件页签栏吗？
              </div>
              <div className="fl-editor-tabs-confirm-body">
                收起后编辑器顶部不再显示页签。随时可以从{' '}
                <strong>工具 → 显示文件页签</strong> 或{' '}
                <strong>设置 → 编辑器 → 文件页签</strong> 重新打开。
              </div>
              <div className="fl-editor-tabs-confirm-actions">
                <button
                  type="button"
                  className="fl-editor-tabs-confirm-cancel"
                  onClick={() => setConfirmHide(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="fl-editor-tabs-confirm-ok"
                  onClick={() => {
                    setConfirmHide(false)
                    setTabsEnabled(false)
                    showToast('页签栏已收起：工具 → 显示文件页签 可重新打开', {
                      duration: 4000,
                    })
                  }}
                >
                  收起页签栏
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

// FIXED: 2026-11-16 页签是「锦上添花」，任何异常都降级为不显示（默认 fallback 渲染空），
// 不把编辑器一起带走。错误仍会经 error-reporter 上报。
export default withErrorBoundary(EditorTabsBar)
