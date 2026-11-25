'use strict'

/**
 * AiUsage 的**哑实现**（开源版默认走这里）。
 *
 * 设计原则：
 *   - `record()` 必须**永不抛**，且必须存在 —— 调用点在完成响应前 await 它，
 *     记账失败绝不能让一次正常的大模型调用变成 500。
 *   - `summaryToday()` 返回 `null`（不是空对象）：调用方靠 null 区分
 *     「没有账本」与「今天没有调用」，前者不该显示成「今日 0 次」。
 *   - `isEnabled()` 恒 false：控制器/前端据此隐藏计费与用量块。
 *
 * 不要把商业逻辑加回这里 —— 需要真实现时写 `impl.js`（见 contract.md）。
 */

module.exports = {
  name: 'dummy',
  __implPath: null,

  /** 是否有真实的记账实现（开源版恒 false） */
  isEnabled() {
    return false
  },

  /** Mongo 集合名；公开侧日志/测试会引用，避免各处写字面量 */
  COLLECTION_NAME: 'llm_usage',

  /** @returns {Promise<void>} 永远成功、永远不抛 */
  async record() {},

  /** @returns {Promise<null>} 没有账本 */
  async summaryToday() {
    return null
  },
}
