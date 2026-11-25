'use strict'

/**
 * AiUsage 私有实现的**骨架**（入库，开源仓库里唯一能看到的那份）。
 *
 * 用法：复制成 `impl.js`（已被 .gitignore 忽略），再实现 record / summaryToday。
 * 生产实现在商业分支上，不进开源仓库 —— 开源版加载到的是 ../dummy.js。
 *
 * 需要实现什么，见同目录 contract.md。
 */

const COLLECTION_NAME = 'llm_usage'

let collectionPromise = null

function getCollection() {
  // 私有实现里通常是：
  //   const { getCollectionInternal } = require('../../infrastructure/mongodb')
  //   return getCollectionInternal(COLLECTION_NAME)
  throw new Error('impl.example.js 只是骨架，请实现 getCollection()')
}

module.exports = {
  name: 'example',
  COLLECTION_NAME,

  isEnabled() {
    return true
  },

  /**
   * 一次大模型调用结束后写一条用量记录（可顺带扣费）。
   * 契约：永不抛；无 userId 静默跳过；扣费用上游 requestId 做幂等键。
   */
  async record(entry) {
    // 参考实现要点：
    //   1. ObjectId(entry.userId) 落库；无 userId 直接 return（匿名无归属）
    //   2. 归一 usage：prompt_tokens / completion_tokens / total_tokens
    //      （responses 协议的 input/output_tokens 已在上游被归一）
    //   3. billing === 'free' → 只记用量不扣费
    //   4. 扣费失败只打日志，绝不 await 到调用链上
    return undefined
  },

  /**
   * 今日按模型/来源聚合的用量。
   * @returns {Promise<null|{calls:number,promptTokens:number,completionTokens:number,
   *   totalTokens:number,byModel:Array<{model:string,source:string,calls:number,totalTokens:number}>,
   *   bySource:Record<string,{calls:number,totalTokens:number}>}>}
   */
  async summaryToday(userId) {
    return null
  },
}
