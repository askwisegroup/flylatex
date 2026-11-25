/**
 * 协议适配器回归测试（纯函数，不发网络请求）。
 *
 * 钉住 5 件事：
 *   1. 默认协议是 chat_completions（DeepSeek / OpenAI 通用）。
 *   2. `LLM_PROTOCOL` 写错时**告警并回退**，不静默乱走。
 *   3. chat_completions 只透传白名单字段（不把 UI 状态传给上游）。
 *   4. responses 的请求/响应双向映射正确（system→instructions、tools 摊平、
 *      usage 字段名不同）。
 *   5. responses 的不可支持能力（图片输入 / n>1 / stop）**报错而不是降级**。
 */
const test = require('node:test')
const assert = require('node:assert')

process.env.DEPLOYMENT_PROFILE = 'sg'
process.env.LLM_PROTOCOL = 'chat_completions'
process.env.LLM_BASE_URL = 'https://api.deepseek.com'
process.env.LLM_DEFAULT_MODEL = 'deepseek-flash'

const Settings = require('@overleaf/settings')
const Providers = require('./index')
const chat = require('./chat-completions')
const responses = require('./responses')

test('默认协议是 chat_completions', () => {
  assert.strictEqual(Providers.protocolId(), 'chat_completions')
  assert.strictEqual(Providers.current().id, 'chat_completions')
})

test('协议别名可用，未知协议回退并告警', () => {
  assert.strictEqual(Providers.protocolId('responses'), 'responses')
  assert.strictEqual(Providers.protocolId('RESPONSE'), 'responses')
  assert.strictEqual(Providers.protocolId('chat'), 'chat_completions')
  assert.strictEqual(Providers.protocolId('nonsense'), 'chat_completions')
})

test('endpoint 按协议拼接，且不会出现双斜杠', () => {
  assert.strictEqual(
    chat.endpoint('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions'
  )
  assert.strictEqual(
    chat.endpoint('https://api.deepseek.com/v1/'),
    'https://api.deepseek.com/v1/chat/completions'
  )
  assert.strictEqual(
    responses.endpoint('https://api.openai.com/v1'),
    'https://api.openai.com/v1/responses'
  )
})

test('baseUrl / defaultModel 从 Settings.llm 读取', () => {
  assert.strictEqual(Providers.baseUrl(), 'https://api.deepseek.com')
  assert.strictEqual(Providers.defaultModel(), 'deepseek-flash')
})

test('chat_completions 只透传白名单字段', () => {
  const body = chat.toUpstream({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    // 客户端 UI 状态，不该发给上游
    conversationId: 'abc',
    someUiFlag: true,
  })
  assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }])
  assert.strictEqual(body.temperature, 0.2)
  assert.strictEqual(body.conversationId, undefined)
  assert.strictEqual(body.someUiFlag, undefined)
})

test('chat_completions 流式自动补 stream_options.include_usage', () => {
  const body = chat.toUpstream({ stream: true, messages: [] })
  assert.strictEqual(body.stream_options.include_usage, true)
})

test('chat_completions 从 SSE 里抠出 usage', () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
    'data: [DONE]\n\n'
  assert.deepStrictEqual(chat.extractUsageFromSse(sse), {
    prompt_tokens: 10,
    completion_tokens: 5,
  })
  assert.strictEqual(chat.extractUsageFromSse('not sse'), null)
})

test('responses：system 提到 instructions，其余进 input', () => {
  const body = responses.toUpstream({
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
    max_tokens: 100,
  })
  assert.strictEqual(body.instructions, 'be terse')
  assert.deepStrictEqual(body.input, [{ role: 'user', content: 'hi' }])
  assert.strictEqual(body.max_output_tokens, 100)
})

test('responses：chat 的工具定义被摊平', () => {
  const body = responses.toUpstream({
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'read',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  })
  assert.deepStrictEqual(body.tools, [
    {
      type: 'function',
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
    },
  ])
})

test('responses：assistant 的 tool_calls 变成 function_call 输入项', () => {
  const items = responses._internal.toInputItems({
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', function: { name: 'read_file', arguments: '{"p":"a.tex"}' } },
    ],
  })
  assert.deepStrictEqual(items, [
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"p":"a.tex"}',
    },
  ])
})

test('responses：tool 消息变成 function_call_output', () => {
  const items = responses._internal.toInputItems({
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'file content',
  })
  assert.deepStrictEqual(items, [
    { type: 'function_call_output', call_id: 'call_1', output: 'file content' },
  ])
})

test('responses：不支持的能力直接报错，不静默降级', () => {
  assert.throws(
    () =>
      responses.toUpstream({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
        ],
      }),
    /unsupported_content/
  )
  assert.throws(
    () => responses.toUpstream({ messages: [], n: 2 }),
    /unsupported_n/
  )
  assert.throws(
    () => responses.toUpstream({ messages: [], stop: ['\n'] }),
    /unsupported_stop/
  )
})

test('responses：上游响应翻译成统一形状', () => {
  const translated = responses.fromUpstreamJson({
    model: 'gpt-4.1',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'hello ' },
          { type: 'output_text', text: 'world' },
        ],
      },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
    ],
    usage: { input_tokens: 12, output_tokens: 3 },
  })
  assert.strictEqual(translated.text, 'hello world')
  assert.strictEqual(translated.toolCalls.length, 1)
  assert.strictEqual(translated.toolCalls[0].function.name, 'f')
  assert.strictEqual(translated.finishReason, 'stop')
})

test('responses：SSE 事件被翻译成 chat completions 增量', () => {
  const usageSeen = []
  const translator = responses.createSseTranslator(u => usageSeen.push(u))

  const first = translator.push(
    'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n'
  )
  assert.ok(first.includes('"content":"Hi"'))

  const done = translator.push(
    'event: response.completed\ndata: {"response":{"usage":{"input_tokens":9,"output_tokens":2}}}\n\n'
  )
  assert.ok(done.includes('[DONE]'))
  assert.ok(done.includes('"finish_reason":"stop"'))
  assert.strictEqual(usageSeen.length, 1)
  assert.strictEqual(usageSeen[0].output_tokens, 2)

  // 上游已经发过 completed，flush 不应再补 [DONE]
  assert.strictEqual(translator.flush(), '')
})

test('responses：上游中途断开时 flush 补 [DONE]，避免前端一直转圈', () => {
  const translator = responses.createSseTranslator(() => {})
  translator.push('event: response.output_text.delta\ndata: {"delta":"H"}\n\n')
  assert.strictEqual(translator.flush(), 'data: [DONE]\n\n')
})

test('responses：半包事件不会被误解析', () => {
  const translator = responses.createSseTranslator(() => {})
  const partial = translator.push('event: response.output_text.delta\ndata: {"delt')
  assert.strictEqual(partial, '', '没有完整空行的半包不应产出任何数据')
  const rest = translator.push('a":"X"}\n\n')
  assert.ok(rest.includes('"content":"X"'))
})

test.after(() => {
  // 还原，避免影响其他测试文件（同进程内的 node --test 共享 env）
  Settings.llm = Object.assign({}, Settings.llm, {
    protocol: 'chat_completions',
  })
})
