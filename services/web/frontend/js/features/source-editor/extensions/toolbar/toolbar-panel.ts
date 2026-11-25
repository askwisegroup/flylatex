import { StateEffect, StateField } from '@codemirror/state'
import { EditorView, showPanel } from '@codemirror/view'

const toggleToolbarEffect = StateEffect.define<boolean>()
const toolbarState = StateField.define<boolean>({
  create: () => true,
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(toggleToolbarEffect)) {
        value = effect.value
      }
    }
    return value
  },
  provide: f => showPanel.from(f, on => (on ? createToolbarPanel : null)),
})

export function createToolbarPanel() {
  const dom = document.createElement('div')
  dom.classList.add('ol-cm-toolbar-portal')
  return { dom, top: true }
}

/**
 * A panel which contains the editor toolbar, provided by a state field which allows the toolbar to be toggled,
 * and styles for the toolbar.
 */
export const toolbarPanel = () => [
  toolbarState,
  // NOTE: 弹层（下拉 / 表格网格 / 更多菜单）的样式已迁到
  // stylesheets/app/editor/toolbar-popovers.less —— 它们 portal 到 body 后
  // 不再受 .cm-editor 作用域约束。
  EditorView.theme({
    '.ol-cm-toolbar': {
      backgroundColor: 'var(--editor-toolbar-bg)',
      color: 'var(--toolbar-btn-color)',
      flex: 1,
      display: 'flex',
      overflowX: 'hidden',
    },
    '&.overall-theme-dark .ol-cm-toolbar': {
      '& img': {
        filter: 'invert(1)',
      },
    },
    '.ol-cm-toolbar-overflow': {
      display: 'flex',
      flexWrap: 'wrap',
    },
    '.ol-cm-toolbar-button-group': {
      display: 'flex',
      alignItems: 'center',
      whiteSpace: 'nowrap',
      flexWrap: 'nowrap',
      padding: '0 4px',
      margin: '4px 0',
      lineHeight: '1',
      '&:not(:first-of-type)': {
        borderLeft: '1px solid rgba(125, 125, 125, 0.3)',
        '&.ol-cm-toolbar-end': {
          borderLeft: 'none',
        },
        '&.ol-cm-toolbar-stretch': {
          flex: 1,
        },
        '&.overflow-hidden': {
          borderLeft: 'none',
        },
      },
      '&.overflow-hidden': {
        width: 0,
        padding: 0,
      },
    },
    '.formatting-buttons-wrapper': {
      flex: 1,
    },
    '.ol-cm-toolbar-button': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      margin: '0 1px',
      backgroundColor: 'transparent',
      border: 'none',
      borderRadius: '1px',
      lineHeight: '1',
      width: '24px',
      height: '24px',
      overflow: 'hidden',
      '&:hover, &:focus, &:active, &.active': {
        backgroundColor: 'rgba(125, 125, 125, 0.1)',
        color: 'inherit',
        boxShadow: 'none',
        '&[aria-disabled="true"]': {
          opacity: '0.2',
        },
      },
      '&.active, &:active': {
        backgroundColor: 'rgba(125, 125, 125, 0.2)',
      },
      '&[aria-disabled="true"]': {
        opacity: '0.2',
        cursor: 'not-allowed',
      },
      '.overflow-hidden &': {
        display: 'none',
      },
      '&.ol-cm-toolbar-button-math': {
        fontFamily: '"Noto Serif", serif',
        fontSize: '16px',
        fontWeight: 700,
      },
    },
    '&.overall-theme-dark .ol-cm-toolbar-button': {
      opacity: 0.8,
      '&:hover, &:focus, &:active, &.active': {
        backgroundColor: 'rgba(125, 125, 125, 0.2)',
      },
      '&.active, &:active': {
        backgroundColor: 'rgba(125, 125, 125, 0.4)',
      },
      '&[aria-disabled="true"]': {
        opacity: 0.2,
      },
    },
    '.ol-cm-toolbar-end': {
      justifyContent: 'flex-end',
      '& .badge': {
        marginRight: '5px',
      },
    },
    '.ol-cm-toolbar-overflow-toggle': {
      display: 'none',
      '&.ol-cm-toolbar-overflow-toggle-visible': {
        display: 'flex',
      },
    },
    '.ol-cm-toolbar-menu-toggle': {
      background: 'transparent',
      boxShadow: 'none !important',
      border: 'none',
      whiteSpace: 'nowrap',
      color: 'inherit',
      borderRadius: '0',
      opacity: 0.8,
      width: '120px',
      fontSize: '13px',
      fontFamily: 'Lato',
      fontWeight: '700',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '5px 6px',
      '&:hover, &:focus, &.active': {
        backgroundColor: 'rgba(125, 125, 125, 0.1)',
        opacity: '1',
        color: 'inherit',
      },
      '& .caret': {
        marginTop: '0',
      },
    },
  }),
]
