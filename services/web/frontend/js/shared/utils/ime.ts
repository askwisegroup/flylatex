/**
 * FIXED: 2026-10-23 判断一次按键是否属于输入法（IME）组合输入
 *
 * 问题：用中文输入法打英文时，按 Enter 只是「上屏候选词」，浏览器却同时派发了
 *       一次 Enter keydown；AI 输入框收到后就当作回车发送，句子还没打完就发了出去。
 * 方案：keydown 里先判断这次按键是否归输入法处理，是则直接放行，不触发发送。
 *
 * 需要同时看三个信号：
 *   - isComposing：组合输入进行中（Chrome / Firefox / 新版 Safari）
 *   - keyCode === 229：按键已交由输入法处理（旧内核、部分 IME）
 *   - 刚 compositionend：部分 Safari 版本先结束组合、再派发这次 Enter，
 *     此时前两个信号都可能缺失，用一个很短的宽限窗口兜住同一次按键
 */

/** compositionend 之后仍视为输入法按键的宽限窗口（毫秒） */
export const IME_ENTER_GRACE_MS = 100

type ImeEvent = {
  nativeEvent: {
    isComposing?: boolean
    keyCode?: number
  }
}

export function isImeComposing(
  event: ImeEvent,
  compositionEndedAt = 0,
  now = Date.now()
): boolean {
  const { nativeEvent } = event
  if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
    return true
  }
  const elapsed = now - compositionEndedAt
  return compositionEndedAt > 0 && elapsed >= 0 && elapsed < IME_ENTER_GRACE_MS
}
