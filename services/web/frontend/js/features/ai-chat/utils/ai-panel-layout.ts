import type { AIPanelLayout } from '../../../../../types/project-settings'

/**
 * FIXED: 2026-11-08 AI 面板落点判定（第二版）。
 *
 * 第一版的教训：直接 document.querySelector('.ui-layout-east') 来判断「右侧是否可用」
 * 是错的。页面上不止一个 .ui-layout-east：
 *   1) editor.pug 的 div[layout="pdf"] > .ui-layout-east —— PDF 预览区（我们要的）
 *   2) main.pug  的 #ide-body[layout="main"] > .ui-layout-east —— 聊天面板（默认收起、宽度 0）
 * 一旦选错或者加上「必须含可见子元素」这种脆弱条件，就会出现
 * 「右侧明明开着、面板却被塞到底部」——把用户设置直接架空。
 *
 * 现在的规则：
 *   - 明确优先取 div[layout="pdf"] 下的 east（PDF 区），不做任何 DOM 顺序假设；
 *   - 判定只要求「这个 pane 真的占地方」（宽度 > 0、可见），
 *     不再要求它有可见子元素（pdfLayout=flat 时子元素为空不代表 pane 不可用）；
 *   - 找不到 PDF 区的 east 时，退化到「文档里任何一个真的展开着的 east」也算可用；
 *   - 两个都没有，才算右侧不可用。
 */
const EAST_CLASS = 'ui-layout-east'

function isPaneUsable(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false
  if (el.offsetWidth <= 0) return false
  return window.getComputedStyle(el).display !== 'none'
}

/** PDF 预览所在的 .ui-layout-east（不做 DOM 顺序假设） */
export function findPdfEastPane(): HTMLElement | null {
  const pdfLayout = document.querySelector('[layout="pdf"]')
  if (!pdfLayout) return null

  for (const child of Array.from(pdfLayout.children)) {
    if (child.classList.contains(EAST_CLASS)) {
      return child as HTMLElement
    }
  }
  return null
}

/**
 * FIXED: 2026-11-08 右侧是否展开 —— 用应用状态判断，不靠量 DOM！
 *
 * IDE 里本来就有权威状态（ide.js 里两个 $watch 双向同步）：
 *   ui.pdfOpen   布尔，右侧 PDF 区是否展开（editor.pug: open-east="ui.pdfOpen"）
 *   ui.pdfLayout 'sideBySide' | 'flat'（开关右侧时会跟着改）
 *   ui.view      'editor' | 'file' → 编辑器布局可见；其他（PDF 全屏、历史）不可见
 * 之前用 offsetWidth 去猜，既会误判（页面刚加载还没量宽度、选错同名 pane），
 * 也拿不到「用户关掉了右侧」这个语义。这里改成读状态。
 *
 * 返回 null 表示「这套页面没有这些状态」（例如 React 版 IDE），
 * 调用方再退回 DOM 度量。
 */
export function resolveSideDockFromState(state: {
  pdfOpen?: boolean | null
  pdfLayout?: string | null
  view?: string | null
}): boolean | null {
  const { pdfOpen, pdfLayout, view } = state

  // 编辑器布局不在前台（PDF 全屏 / 历史版本）→ 右侧没有落点
  if (view != null && view !== 'editor' && view !== 'file') {
    return false
  }
  if (pdfOpen === true) return true
  if (pdfOpen === false) return false
  if (pdfLayout === 'sideBySide') return true
  if (pdfLayout === 'flat') return false
  return null
}

/** 右侧（PDF 区）现在能不能挂面板（DOM 兜底：没有应用状态时才用） */
export function isSideDockAvailableByDom(): boolean {
  const pdfEast = findPdfEastPane()
  if (isPaneUsable(pdfEast)) {
    return true
  }

  // 退化：文档里任何真的展开着的 east 都算可用（不同 IDE 页面结构可能不一样）
  const all = Array.from(
    document.querySelectorAll(`.${EAST_CLASS}`)
  ) as HTMLElement[]
  return all.some(isPaneUsable)
}

/** 要挂载的右侧容器（调用方拿它 appendChild） */
export function getSideDockPane(): HTMLElement | null {
  // 优先 PDF 区（即使此刻收起也返回它，保持与旧行为一致的落点）
  const pdfEast = findPdfEastPane()
  if (pdfEast) {
    return pdfEast
  }
  const all = Array.from(
    document.querySelectorAll(`.${EAST_CLASS}`)
  ) as HTMLElement[]
  return all.find(isPaneUsable) ?? null
}

/** 底部停靠容器是否存在（south 面板由 fl:ai-dock 事件负责打开） */
export function isBottomDockAvailable(): boolean {
  return !!document.getElementById('fl-ai-dock')
}
