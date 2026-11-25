'use strict'

/**
 * `responses` 协议适配器（OpenAI Responses API）。
 *
 * 存在的意义：需求要求**按协议绑定而不是按厂商绑定**。上层（llm-relay）
 * 只说「统一形状」（= chat completions 形状），由这里负责双向翻译，
 * 换供应商 / 换协议都只改这一层。
 *
 * 与 chat_completions 的差异，逐条对上：
 *
 *   chat completions                     responses
 *   ----------------------------------   --------------------------------------
 *   POST /chat/completions               POST /responses
 *   system 消息（messages 里）           instructions（顶层字符串）
 *   messages: [{role, content}]          input: [{role, content}] / 输入项数组
 *   max_tokens / max_completion_tokens   max_output_tokens
 *   tools: [{type:'function',function}]  tools: [{type:'function',name,...}]
 *   choices[0].message.content           output[].content[].text（type=output_text）
 *   choices[0].message.tool_calls        output[].type === 'function_call'
 *   usage.{prompt,completion}_tokens     usage.{input,output}_tokens
 *
 * ⚠️ 明确不支持的（会抛错而不是静默降级）：
 *   - 非文本输入（图片 / 音频）—— 形状差异大，等真有需求再加
 *   - `logprobs` / `n>1` / `stop`
 * 抛错比"看起来成功但内容不对"好：后者排查成本极高。
 */

const SUPPORTED_PASSTHROUGH = [
  'temperature',
  'top_p',
  'stream',
  'user',
  'parallel_tool_calls',
  'seed',
]

const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
  }
  return ''
}

const isPlainText = content =>
  typeof content === 'string' ||
  !Array.isArray(content) ||
  content.every(part => part && part.type === 'text')

/** chat 的工具定义 → responses 的工具定义（function 层要摊平） */
function toResponseTool(tool) {
  if (!tool || tool.type !== 'function' || !tool.function) return tool
  const { name, description, parameters, strict } = tool.function
  const out = { type: 'function', name, parameters: parameters || { type: 'object', properties: {} } }
  if (description !== undefined) out.description = description
  if (strict !== undefined) out.strict = strict
  return out
}

function toResponseToolChoice(choice) {
  if (typeof choice === 'string') return choice
  if (choice && choice.type === 'function' && choice.function) {
    return { type: 'function', name: choice.function.name }
  }
  return choice
}

function toTextFormat(responseFormat) {
  if (!responseFormat || !responseFormat.type) return { type: 'text' }
  if (responseFormat.type === 'json_object') return { type: 'json_object' }
  if (responseFormat.type === 'json_schema' && responseFormat.json_schema) {
    return Object.assign({ type: 'json_schema' }, responseFormat.json_schema)
  }
  return { type: 'text' }
}

/** 一条 chat 消息 → 一到多个 responses 输入项 */
function toInputItems(message) {
  if (!message) return []
  const role = message.role

  if (role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textOf(message.content),
      },
    ]
  }

  const items = []
  const text = textOf(message.content)
  if (text !== '') items.push({ role, content: text })

  // assistant 发起的工具调用：responses 里是独立的 function_call 输入项
  if (role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call || !call.function) continue
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments || '{}',
      })
    }
  }

  return items
}

/**
 * 统一形状 → responses 请求体。
 * @throws {Error} 遇到本适配器不支持的能力时
 */
function toUpstream(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []

  for (const message of messages) {
    if (message && !isPlainText(message.content)) {
      throw Object.assign(new Error('responses_protocol_unsupported_content'), {
        code: 'unsupported_content',
      })
    }
  }
  if (body.n !== undefined && Number(body.n) > 1) {
    throw Object.assign(new Error('responses_protocol_unsupported_n'), {
      code: 'unsupported_n',
    })
  }
  if (body.stop !== undefined) {
    throw Object.assign(new Error('responses_protocol_unsupported_stop'), {
      code: 'unsupported_stop',
    })
  }

  const instructions = []
  const input = []
  for (const message of messages) {
    if (message && (message.role === 'system' || message.role === 'developer')) {
      const text = textOf(message.content)
      if (text) instructions.push(text)
      continue
    }
    input.push(...toInputItems(message))
  }

  const out = { input }
  if (instructions.length) out.instructions = instructions.join('\n\n')

  // FIXED: 2026-11-25 上游必须显式带 model（同 chat-completions.js 的说明）
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    out.model = body.model
  }

  const maxOutput = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens
  if (maxOutput !== undefined && maxOutput !== null) {
    out.max_output_tokens = Number(maxOutput)
  }

  for (const field of SUPPORTED_PASSTHROUGH) {
    if (body[field] !== undefined) out[field] = body[field]
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(toResponseTool)
  }
  if (body.tool_choice !== undefined) {
    out.tool_choice = toResponseToolChoice(body.tool_choice)
  }
  if (body.response_format !== undefined) {
    out.text = { format: toTextFormat(body.response_format) }
  }

  return out
}

/* ------------------------------------------------------------------ */
/* 响应                                                               */
/* ------------------------------------------------------------------ */

/** responses 响应 → 统一形状（chat completions 形状） */
function fromUpstreamJson(payload = {}) {
  const output = Array.isArray(payload.output) ? payload.output : []

  let text = ''
  const toolCalls = []

  for (const item of output) {
    if (!item) continue
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text
        }
      }
      continue
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments || '{}',
        },
      })
    }
  }

  return {
    text,
    toolCalls,
    finishReason: payload.status === 'incomplete' ? 'length' : 'stop',
    usage: payload.usage || null,
    model: payload.model,
  }
}

/* ------------------------------------------------------------------ */
/* 流式                                                               */
/* ------------------------------------------------------------------ */

/**
 * 把 responses 的 SSE 事件翻译成 chat completions 形状的 SSE 增量。
 *
 * 只处理对上层有意义的四类事件，其余（reasoning、content_part.* 等）忽略：
 *   response.output_text.delta                 → {choices:[{delta:{content}}]}
 *   response.output_item.added(function_call)  → {choices:[{delta:{tool_calls:[…]}}]}
 *   response.function_call_arguments.delta     → 追加 arguments
 *   response.completed                         → usage + finish + [DONE]
 */
function createSseTranslator(onUsage) {
  let buffer = ''
  const toolIndexByItemId = new Map()
  let nextToolIndex = 0
  let finished = false

  const frame = obj => `data: ${JSON.stringify(obj)}\n\n`

  const chunk = delta => ({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: null }],
  })

  function handleEvent(eventName, data) {
    let payload
    try {
      payload = JSON.parse(data)
    } catch (error) {
      return ''
    }
    if (!payload) return ''

    switch (eventName || payload.type) {
      case 'response.output_text.delta':
        return payload.delta ? frame(chunk({ content: payload.delta })) : ''

      case 'response.output_item.added': {
        const item = payload.item || {}
        if (item.type !== 'function_call') return ''
        const index = nextToolIndex++
        toolIndexByItemId.set(item.id || item.call_id, index)
        return frame(
          chunk({
            tool_calls: [
              {
                index,
                id: item.call_id || item.id,
                type: 'function',
                function: { name: item.name || '', arguments: '' },
              },
            ],
          })
        )
      }

      case 'response.function_call_arguments.delta': {
        const index = toolIndexByItemId.get(payload.item_id)
        if (index === undefined || !payload.delta) return ''
        return frame(
          chunk({
            tool_calls: [{ index, function: { arguments: payload.delta } }],
          })
        )
      }

      case 'response.completed': {
        const usage = payload.response && payload.response.usage
        if (usage && typeof onUsage === 'function') onUsage(usage)
        finished = true
        return (
          frame({
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage,
          }) + 'data: [DONE]\n\n'
        )
      }

      case 'response.failed':
      case 'error': {
        finished = true
        const message =
          (payload.error && payload.error.message) || payload.message || 'upstream_error'
        return `data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`
      }

      default:
        return ''
    }
  }

  return {
    /** 喂一段上游文本，返回要写给浏览器的字符串（可能为空） */
    push(text) {
      buffer += String(text || '')
      let out = ''
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')

        let eventName = ''
        const dataLines = []
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length) {
          out += handleEvent(eventName, dataLines.join('\n'))
        }
      }
      // 防止上游不发空行时缓冲无限增长
      if (buffer.length > 256 * 1024) buffer = buffer.slice(-4096)
      return out
    },

    /** 上游结束时收尾：补一个 [DONE]，避免前端一直转圈 */
    flush() {
      if (finished) return ''
      finished = true
      return 'data: [DONE]\n\n'
    },
  }
}

module.exports = {
  id: 'responses',
  endpoint: baseUrl => `${String(baseUrl).replace(/\/+$/, '')}/responses`,
  toUpstream,
  fromUpstreamJson,
  createSseTranslator,
  // 供 llm-relay 判断走哪条流式分支
  streaming: 'translate',
  // 测试可见的纯函数
  _internal: { toInputItems, toResponseTool, toResponseToolChoice, textOf },
}
