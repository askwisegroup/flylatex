'use strict'

/**
 * AI 用量记账的**唯一出口**（holder）。
 *
 * 背景：用量记录 + 按量扣费属于**商业实现**，不进开源代码。开源仓库里没有
 * `impl.js`，这里加载到的是 `./dummy`：所有方法空转、`isEnabled()` 恒 false，
 * 计费/用量相关的接口与 UI 自动降级为「不可用」，业务代码里不需要任何 if。
 *
 * 加载顺序（先命中先用）：
 *   1. `process.env.AI_USAGE_IMPL`  —— 指向任意路径的私有实现（仓外也可）
 *   2. `./impl.js`                  —— 仓内私有实现（.gitignore，仅商业分支存在）
 *   3. `./dummy`                    —— 哑实现（开源仓库走这条）
 *
 * 为什么先 `fs.existsSync` 再 require，而不是 try/catch MODULE_NOT_FOUND：
 * 私有实现内部自己 require 的模块如果缺失，错误码同样是 MODULE_NOT_FOUND，
 * try/catch 会把它当成「没有私有实现」，于是**记不上账还不报警**。
 * 这里只在「文件本身不存在」时降级，私有实现内部的任何错误照常抛。
 *
 * 契约见 ./contract.md；新增方法请同时改 dummy.js 与 impl.example.js。
 */

const fs = require('fs')
const path = require('path')

const dummy = require('./dummy')

/** 私有实现必须提供的方法；缺一个就等于「静默不记账」，因此拒绝启动 */
const REQUIRED = ['record', 'summaryToday']

const CANDIDATES = [process.env.AI_USAGE_IMPL, 'impl.js'].filter(Boolean)

function resolveOne(candidate) {
  return path.isAbsolute(candidate)
    ? candidate
    : path.join(__dirname, candidate)
}

function loadImplementation() {
  for (const candidate of CANDIDATES) {
    const file = resolveOne(candidate)
    if (!fs.existsSync(file)) continue

    const impl = require(file)
    const missing = REQUIRED.filter(name => typeof impl[name] !== 'function')
    if (missing.length) {
      throw new Error(
        `AiUsage 私有实现 ${path.relative(process.cwd(), file)} 缺少 ${missing.join(
          '() / '
        )}()，拒绝以「记不上账」的状态启动`
      )
    }
    // Object.create(dummy)：私有实现没覆盖的可选字段（isEnabled / COLLECTION_NAME）
    // 自动继承哑实现的默认值，避免调用方到处判空。
    return Object.assign(Object.create(dummy), impl, { __implPath: file })
  }
  // 私有实现缺失：开源版本本来就是这样，但**不能静默**。
  // dummy 下 record() 全是空操作、summaryToday() 恒为 null，一旦商业部署
  // 忘了带 impl.js，表现就是「用量页永远是 0、也不扣费」，事后极难倒查。
  console.warn(
    '[AiUsage] 未提供私有实现（AI_USAGE_IMPL / impl.js），用量记录已关闭：' +
      'record() 为空操作，summaryToday() 返回 null。开源版本属预期；' +
      '商业部署请放入 impl.js（契约见 app/src/Features/AiUsage/contract.md）。'
  )
  return dummy
}

module.exports = loadImplementation()
