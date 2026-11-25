'use strict'

/**
 * LLM 上游协议注册表。
 *
 * 设计目标（需求原文：「不要绑定具体，可以绑定 chat completions 和
 * response 协议吧」）：
 *
 *   上层（llm-relay / 记账）只认**统一形状**，
 *   协议差异全部收敛在这两个适配器里。
 *
 * 换供应商 = 改 `LLM_BASE_URL` + `LLM_API_KEY`；
 * 换协议   = 改 `LLM_PROTOCOL`；
 * 两者都不需要改业务代码。
 *
 * 适配器接口（新增协议时照此实现）：
 *   id
 *   endpoint(baseUrl)              → 完整 URL
 *   toUpstream(body)               → 统一形状 → 上游协议体
 *   fromUpstreamJson(payload)      → 上游响应 → 统一形状
 *   createSseTranslator(onUsage)   → （可选）流式翻译器
 */

const Settings = require('@overleaf/settings')

const chatCompletions = require('./chat-completions')
const responses = require('./responses')

const REGISTRY = {
  [chatCompletions.id]: chatCompletions,
  [responses.id]: responses,
}

const DEFAULT_PROTOCOL = 'chat_completions'

/** 别名：运维可能会写 responses / response / resp，统一收敛。 */
const ALIASES = {
  chat_completions: 'chat_completions',
  chatcompletions: 'chat_completions',
  chat: 'chat_completions',
  completions: 'chat_completions',
  responses: 'responses',
  response: 'responses',
  resp: 'responses',
}

function protocolId(explicit) {
  const raw = String(
    explicit ||
      (Settings.llm && Settings.llm.protocol) ||
      process.env.LLM_PROTOCOL ||
      DEFAULT_PROTOCOL
  )
    .trim()
    .toLowerCase()
  const resolved = ALIASES[raw] || DEFAULT_PROTOCOL
  if (raw && !ALIASES[raw]) {
    // 拼错不静默：直接告警，否则会出现「明明配了 responses 却在走 chat」
    console.warn(
      `[llm-providers] 未知协议 "${raw}"，回退到 ${DEFAULT_PROTOCOL}（可用：${Object.keys(
        REGISTRY
      ).join(', ')}）`
    )
  }
  return resolved
}

/** 当前生效的协议适配器 */
function current(explicit) {
  return REGISTRY[protocolId(explicit)]
}

const get = current

/** 当前 base URL（已去尾斜杠） */
function baseUrl() {
  const configured =
    (Settings.llm && Settings.llm.baseUrl) || process.env.LLM_BASE_URL || ''
  return String(configured).replace(/\/+$/, '')
}

/** 当前协议的完整上游 URL */
function endpoint(explicit) {
  return current(explicit).endpoint(baseUrl())
}

/** 当前协议允许的模型白名单（空数组 = 不限制） */
function allowedModels() {
  const configured = (Settings.llm && Settings.llm.allowedModels) || []
  return Array.isArray(configured) ? configured : []
}

/** 当前协议的默认模型 */
function defaultModel() {
  return (
    (Settings.llm && Settings.llm.defaultModel) ||
    process.env.LLM_DEFAULT_MODEL ||
    ''
  )
}

/**
 * usage 归一成 chat completions 字段名。
 *
 * responses 给的是 `input_tokens` / `output_tokens`；记账、计价、前端都按
 * `prompt_tokens` / `completion_tokens` 算，所以只在这一个地方翻译。
 * （从 llm-relay.js 挪过来：agent 链路现在也走同一套协议，不能各写一份。）
 */
function normalizeUsage(usage) {
  if (!usage) return null
  const prompt =
    usage.prompt_tokens !== undefined ? usage.prompt_tokens : usage.input_tokens
  const completion =
    usage.completion_tokens !== undefined
      ? usage.completion_tokens
      : usage.output_tokens
  if (prompt === undefined && completion === undefined) return usage
  const out = Object.assign({}, usage, {
    prompt_tokens: Number(prompt) || 0,
    completion_tokens: Number(completion) || 0,
  })
  out.total_tokens =
    Number(usage.total_tokens) || out.prompt_tokens + out.completion_tokens
  return out
}

/**
 * 上游原始 JSON → 统一（chat completions）形状。
 *
 * ✓ chat_completions：原样返回（它本身就是统一形状）。
 * ✓ 错误体（带 `error`）原样返回：上层靠 error/status 分支分流，
 *   翻译成空 `choices` 会把 401/402 变成“模型没回话”。
 * ✓ 已经是统一形状（带 `choices`）的对象原样返回，便于重入。
 */
function toChatShape(payload, explicit) {
  const provider = current(explicit)
  if (!payload || typeof payload !== 'object') return payload
  if (provider.id === 'chat_completions') return payload
  if (Array.isArray(payload.choices) || payload.error) return payload
  if (!payload.output && !payload.status) return payload

  const unified = provider.fromUpstreamJson(payload)
  const message = { role: 'assistant', content: unified.text || '' }
  if (Array.isArray(unified.toolCalls) && unified.toolCalls.length) {
    message.tool_calls = unified.toolCalls
  }
  return {
    id: payload.id,
    model: unified.model || payload.model,
    created: payload.created_at,
    choices: [
      { index: 0, message, finish_reason: unified.finishReason || 'stop' },
    ],
    usage: normalizeUsage(unified.usage),
  }
}

module.exports = {
  REGISTRY,
  DEFAULT_PROTOCOL,
  list: () => Object.keys(REGISTRY),
  protocolId,
  current,
  get,
  baseUrl,
  endpoint,
  allowedModels,
  defaultModel,
  normalizeUsage,
  toChatShape,
}
