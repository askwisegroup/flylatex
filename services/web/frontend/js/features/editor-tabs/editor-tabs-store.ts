import customLocalStorage from '@/infrastructure/local-storage'
import { debugConsole } from '@/utils/debugging'

/**
 * FIXED: 2026-11-16 编辑器多文件页签（路线 B：轻量自研）。
 *
 * 为什么是模块级 store 而不是 React Context Provider：
 *   CodeMirror 的 view / state 在切换文档、切换源码↔富文本时会重建，
 *   挂在编辑器内部的 Provider 会跟着重建（页签顺序、激活态就丢了）；
 *   模块级单例 + 订阅只依赖 localStorage，重建多少次都一样。
 *
 * 不碰核心编辑器的依据：
 *   1. 不入 CodeMirror 的文档模型，不改协作/OT 任何一行；
 *   2. 记的只是「打开过哪些 docId」，切换仍然走 editorManager.openDocId（原有唯一入口）；
 *   3. 滚动位置本来就有 scroll-position.ts 按 `doc.position.<docId>` 存取，切回来自动还原。
 *   已知取舍：CM6 单 view，undo 历史切走即失效（Pro 也是靠 scope 重建，不是它的优势项）。
 */

export type EditorTab = { id: string; name: string }

/** 页签上限：只影响「显示几个」，不限制用户打开文件；超出时挤掉最旧的非激活页签 */
const MAX_TABS = 12

const listeners = new Set<() => void>()

/** 页签栏总开关（浏览器级偏好，不走 user settings：那要动 5 个服务端文件 + i18n 白名单） */
const ENABLED_KEY = 'editor.tabs.enabled'

let tabs: EditorTab[] = []
let storageKey: string | null = null
let enabled = true

try {
  enabled = customLocalStorage.getItem(ENABLED_KEY) !== false
} catch {
  // 读不到就当开启（默认行为不变）
  enabled = true
}

function normalize(value: unknown): EditorTab[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const result: EditorTab[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const { id, name } = item as Partial<EditorTab>
    if (typeof id !== 'string' || !id || seen.has(id)) {
      continue
    }
    seen.add(id)
    result.push({ id, name: typeof name === 'string' ? name : id })
  }
  return result.slice(-MAX_TABS)
}

function emit() {
  for (const listener of listeners) {
    listener()
  }
}

function persist() {
  if (!storageKey) {
    return
  }
  try {
    customLocalStorage.setItem(storageKey, tabs)
  } catch (error) {
    // 写不进去（隐私模式/配额满）只影响下次恢复，不影响当前会话
    debugConsole.warn('[editor-tabs] 无法持久化页签', error)
  }
}

/** 每个项目一套页签；切项目（或换项目 id）时重新读一次 */
export function initEditorTabs(projectId: string) {
  const key = `editor.tabs.${projectId}`
  if (storageKey === key) {
    return
  }
  storageKey = key
  tabs = normalize(customLocalStorage.getItem(key))
  emit()
}

export function getTabs(): EditorTab[] {
  return tabs
}

export function subscribeTabs(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 文档被打开时入列（已存在则只更新名字） */
export function openTab(id: string, name: string) {
  if (!id) {
    return
  }
  const existing = tabs.find(tab => tab.id === id)
  if (existing) {
    if (name && existing.name !== name) {
      tabs = tabs.map(tab => (tab.id === id ? { ...tab, name } : tab))
      persist()
      emit()
    }
    return
  }
  tabs = [...tabs, { id, name: name || id }]
  if (tabs.length > MAX_TABS) {
    tabs = tabs.slice(tabs.length - MAX_TABS)
  }
  persist()
  emit()
}

/** 关闭一个页签。是否「顺带切到邻居」由调用方决定（它才知道谁是激活项） */
export function closeTab(id: string) {
  const next = tabs.filter(tab => tab.id !== id)
  if (next.length === tabs.length) {
    return
  }
  tabs = next
  persist()
  emit()
}

/** 文档已被删除/无权访问：把已经失效的页签剔掉 */
export function pruneTabs(exists: (id: string) => boolean) {
  const next = tabs.filter(tab => exists(tab.id))
  if (next.length === tabs.length) {
    return
  }
  tabs = next
  persist()
  emit()
}

/**
 * 页签栏是否显示。默认显示；用户可以在「设置 → 编辑器 → 文件页签」关掉，
 * 也可以在页签栏右端的收起按钮一键关掉。
 */
export function isTabsEnabled() {
  return enabled
}

export function setTabsEnabled(value: boolean) {
  if (enabled === value) {
    return
  }
  enabled = value
  try {
    customLocalStorage.setItem(ENABLED_KEY, value)
  } catch (error) {
    debugConsole.warn('[editor-tabs] 无法保存页签栏开关', error)
  }
  emit()
}

/** 仅供测试/调试：清空当前项目的页签记录 */
export function resetTabsForTests() {
  tabs = []
  storageKey = null
  enabled = true
  listeners.clear()
}
