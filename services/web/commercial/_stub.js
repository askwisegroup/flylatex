'use strict'

/**
 * 社区版的「商业集成」占位实现。
 *
 * 本仓库不包含我们运营的商业系统（外部账号中心、高校联合登录、私有 LLM 网关、
 * 个人知识库、文献检索等）。这些能力在完整产品里是**独立部署的服务**，通过 HTTP
 * 与本系统对接；它们不在开源范围内，所以这里只提供「不启用」的桩。
 *
 * 设计约束：
 *   · 加载期不能抛错 —— 这些模块在 router.js 顶部被 require，抛错等于站点起不来；
 *   · 调用期也不抛错 —— 相关路由在未配置时本就应当表现为「未启用」；
 *   · 任何属性访问都返回同样的桩，避免 `X.SOME_CONST` 这类读法炸掉；
 *   · 打一条 warn 便于排障时确认「功能没接上」而不是「代码坏了」。
 */

const logger = require('@overleaf/logger')

const warned = new Set()

function warnOnce(label) {
  if (warned.has(label)) return
  warned.add(label)
  logger.warn(
    { module: label },
    '[community] commercial integration not included; feature disabled'
  )
}

function makeStub(label) {
  const target = function () {}
  return new Proxy(target, {
    get(_t, key) {
      if (typeof key !== 'string') return undefined
      // 不要变成 thenable，否则 `await stub` 会挂住
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      if (key === '__esModule') return false
      if (key === 'toString' || key === 'valueOf') return () => label
      if (key === 'inspect' || key === Symbol.for('nodejs.util.inspect.custom')) {
        return () => label
      }
      return makeStub(`${label}.${key}`)
    },
    apply() {
      warnOnce(label)
      return undefined
    },
    has() {
      return true
    },
  })
}

module.exports = { makeStub }
