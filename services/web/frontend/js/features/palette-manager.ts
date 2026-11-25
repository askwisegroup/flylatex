import { useCallback, useEffect, useState } from 'react'

/**
 * FIXED: 2026-11-13 编辑区浮层面板的统一开关。
 *
 * 为什么要一个中心：三个面板（快捷命令 / 符号表在「工具」菜单，全项目搜索在
 * 「编辑」菜单）都从顶栏菜单打开，产品要求
 *   1) 互斥：同时只能开一个；
 *   2) 开关语义：已打开时再点同一个菜单项要关掉，而不是重开。
 * 如果每个面板各自维护 open 状态，这两条都得靠事件互相打听，很容易出现
 * 「两个面板叠在一起」或「点了没反应」。
 *
 * 实现上是一个极小的外部 store + React 订阅 hook，不引第三方状态库。
 * （注意 React 17 没有 useSyncExternalStore，见下方 usePaletteOpen 的说明）
 */

export type PaletteId = 'command' | 'symbol' | 'search'

let active: PaletteId | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getActivePalette(): PaletteId | null {
  return active
}

/** 直接设置当前面板（null = 全部关闭） */
export function setActivePalette(id: PaletteId | null) {
  if (active === id) return
  active = id
  emit()
}

/** 开关语义：已打开就关，否则打开（并自动关掉另一个） */
export function togglePalette(id: PaletteId) {
  setActivePalette(active === id ? null : id)
}

export function subscribePalette(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 组件用：这个面板现在是否打开。
 *
 * 注意：不能写 useSyncExternalStore —— 这个项目是 React 17.0.2，
 * 该 API 是 React 18 才有的（用了会在运行时报
 * "TypeError: (0, n.useSyncExternalStore) is not a function"，
 * 整个编辑器白屏）。用最朴素的 useState + 订阅即可。
 */
export function usePaletteOpen(id: PaletteId): boolean {
  const [open, setOpen] = useState(() => active === id)

  useEffect(() => {
    // 订阅变化；同时立即同步一次，避免订阅前状态已变化
    const unsubscribe = subscribePalette(() => setOpen(active === id))
    setOpen(active === id)
    return unsubscribe
  }, [id])

  return open
}

/** 组件用：关闭自己（点 ✕、按 Esc、点遮罩都走这个） */
export function useClosePalette(): () => void {
  return useCallback(() => setActivePalette(null), [])
}
