'use strict'

/**
 * `chat_completions` 协议适配器（OpenAI Chat Completions 形状）。
 *
 * DeepSeek / OpenAI / Moonshot / 大部分中转商都用这一套，因此它是默认协议。
 *
 * 约定（所有协议适配器都实现同一组接口，见 ./index.js 的说明）：
 *   endpoint(baseUrl)       → 完整 URL
 *   toUpstream(body)        → 把「统一形状」转成上游协议体
 *   fromUpstreamJson(p)     → 把上游响应转成统一形状
 *   createStreamTranslator()→ 把上游 SSE 转成统一形状的增量
 *
 * ⚠️ 这里的「统一形状」就是 chat completions 形状本身 —— 它已经是最通用的
 *    那个，没必要再造一层。这样 chat_completions 适配器几乎是恒等变换，
 *    而 responses 适配器负责双向翻译。
 */

const PASSTHROUGH = [
  // FIXED: 2026-11-25 白名单里一直缺 `model`。
  // relay 把 model 校验后写进 payload.model（llm-relay.js:564），但 toUpstream
  // 只挑白名单字段，于是真正发出去的上游请求体里**没有 model** ——
  // NE 网关会自己兜一个默认模型，所以国内一直没暴露；换成 DeepSeek/OpenAI
  // 这类兼容接口就是 400 model is required。
  'model',
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'stream',
  'stream_options',
  'response_format',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'user',
]

/** 上游要求显式 `stream_options.include_usage` 才会在最后一帧带 usage。 */
function withUsageStreamOption(body) {
  if (!body || !body.stream) return body
  return Object.assign({}, body, {
    stream_options: Object.assign({ include_usage: true }, body.stream_options),
  })
}

module.exports = {
  id: 'chat_completions',

  endpoint(baseUrl) {
    return `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  },

  /** chat completions 到 chat completions：只挑白名单字段，防止把客户端
   *  的杂字段（如 UI 状态）透传给上游。 */
  toUpstream(body) {
    const out = {}
    for (const field of PASSTHROUGH) {
      if (body[field] !== undefined) out[field] = body[field]
    }
    return withUsageStreamOption(out)
  },

  fromUpstreamJson(payload) {
    const choice = (payload && payload.choices && payload.choices[0]) || {}
    const message = choice.message || {}
    return {
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      finishReason: choice.finish_reason || null,
      usage: (payload && payload.usage) || null,
      model: payload && payload.model,
    }
  },

  /**
   * chat completions 的 SSE **本身就是统一形状**，不需要翻译。
   * relay 会把这路流直接透传，并用 `LlmUsage.createUsageTap` 顺手抠 usage
   * （那一层已经在生产用了很久，不动它）。
   */
  streaming: 'passthrough',

  extractUsageFromSse,
}

/**
 * 从一段（可能不完整的）SSE 文本里找 `usage`。
 * 供 relay 记账用；解析失败一律返回 null，绝不影响转发。
 */
function extractUsageFromSse(chunk) {
  const text = String(chunk || '')
  if (!text || text.indexOf('"usage"') === -1) return null
  let found = null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const body = trimmed.slice(5).trim()
    if (!body || body === '[DONE]') continue
    try {
      const parsed = JSON.parse(body)
      if (parsed && parsed.usage) found = parsed.usage
    } catch (error) {
      // 半行 JSON：忽略
    }
  }
  return found
}
