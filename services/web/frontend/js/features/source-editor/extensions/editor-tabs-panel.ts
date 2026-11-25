import { showPanel } from '@codemirror/view'

/**
 * FIXED: 2026-11-16 多文件页签的挂载点：CodeMirror 的 top panel。
 *
 * 为什么用 panel 而不是在 EditorPane 里加一层 div：
 *   panel 是编辑器自己的布局（CM 负责算高度、随编辑器一起显示/隐藏），
 *   不用动外层 flex/grid 的高度链 —— 那条链上还有符号面板、评审面板、
 *   移动端全屏浮层三套布局，改一处就会在另一处溢出。
 *   与现有工具栏（toolbar-panel.ts）完全同构，风险最小。
 *
 * 注意：createEditorTabsPanel 必须是**模块级稳定引用**，
 * 因为 React 侧要用 getPanel(view, createEditorTabsPanel) 去找这个 panel。
 */
export function createEditorTabsPanel() {
  const dom = document.createElement('div')
  dom.classList.add('ol-cm-editor-tabs-portal')
  return { dom, top: true }
}

export const editorTabsPanel = () => [showPanel.of(createEditorTabsPanel)]
