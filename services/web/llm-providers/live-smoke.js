'use strict'

/**
 * 上游 LLM 真实连通性 smoke。
 *
 * 用法（不要把 key 写进文件，走环境变量）：
 *   LLM_BASE_URL=https://api.deepseek.com \
 *   LLM_API_KEY=sk-... \
 *   LLM_DEFAULT_MODEL=deepseek-flash \
 *   node commercial/providers/live-smoke.js
 *
 * 验证 4 件事：
 *   1. base URL / key / model 三者匹配（最常见的配置错误）
 *   2. 非流式调用能拿到正文
 *   3. 流式调用能拿到增量和 usage（记账依赖它）
 *   4. 我们自己的计价能算出非零金额（否则 Billing 会当成 0 费用）
 *
 * 只读：不发任何写请求，不动数据库。
 */

const https = require('https')
const http = require('http')

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(
  /\/+$/,
  ''
)
const API_KEY = process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_DEFAULT_MODEL || 'deepseek-flash'

if (!API_KEY) {
  console.error('缺少 LLM_API_KEY')
  process.exit(2)
}

const ENDPOINT = `${BASE_URL}/chat/completions`

function post(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'http:' ? http : https
    const payload = Buffer.from(JSON.stringify(body))
    const request = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: `Bearer ${API_KEY}`,
          Accept: body.stream ? 'text/event-stream' : 'application/json',
        },
        timeout: 120000,
      },
      response => resolve({ response, request })
    )
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.write(payload)
    request.end()
  })
}

async function checkNonStreaming() {
  const { response } = await post(ENDPOINT, {
    model: MODEL,
    messages: [
      { role: 'system', content: '你只回答一个词。' },
      { role: 'user', content: '用中文回答：1+1 等于几？' },
    ],
    // deepseek-flash 默认开启思考模式，推理 token 与正文共享输出预算。
    // 32 会被推理吃光、正文为空 —— 这里给足预算才能验证正文链路。
    max_tokens: 512,
    temperature: 0,
  })

  let raw = ''
  response.setEncoding('utf8')
  for await (const chunk of response) raw += chunk

  const status = response.statusCode
  if (status !== 200) {
    return { ok: false, status, detail: raw.slice(0, 400) }
  }
  const body = JSON.parse(raw)
  const content = body.choices?.[0]?.message?.content || ''
  return {
    ok: Boolean(content),
    status,
    model: body.model,
    content: content.trim().slice(0, 80),
    usage: body.usage,
  }
}

async function checkStreaming() {
  const { response } = await post(ENDPOINT, {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
    max_tokens: 2048,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
  })

  if (response.statusCode !== 200) {
    let raw = ''
    response.setEncoding('utf8')
    for await (const chunk of response) raw += chunk
    return { ok: false, status: response.statusCode, detail: raw.slice(0, 400) }
  }

  let text = ''
  let reasoning = ''
  let usage = null
  let buffer = ''
  response.setEncoding('utf8')
  for await (const chunk of response) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        const choice = parsed.choices?.[0] || {}
        const delta = choice.delta || {}
        if (delta.content) text += delta.content
        // deepseek-flash 是思考模型：正文之前会先大量输出 reasoning_content。
        // 这里单独统计，便于判断「用户看到长时间空白」是模型特性还是链路问题。
        if (delta.reasoning_content) reasoning += delta.reasoning_content
        if (parsed.usage) usage = parsed.usage
      } catch (error) {
        /* 半行 */
      }
    }
  }
  return {
    ok: Boolean(text),
    text: text.trim().slice(0, 80),
    reasoningChars: reasoning.length,
    usage,
  }
}

;(async () => {
  console.log(`endpoint = ${ENDPOINT}`)
  console.log(`model    = ${MODEL}\n`)

  const plain = await checkNonStreaming()
  console.log('[1] 非流式:', plain.ok ? 'OK' : 'FAIL', JSON.stringify(plain))

  const stream = await checkStreaming()
  console.log('[2] 流式  :', stream.ok ? 'OK' : 'FAIL', JSON.stringify(stream))

  // [3] 计价：用真实 usage 算一次，确认不是 0
  process.env.LLM_DEFAULT_MODEL = MODEL
  const Pricing = require('../../app/src/Features/Billing/pricing')
  const usage = (stream.usage || plain.usage) || null
  if (usage) {
    const cost = Pricing.costFor(MODEL, usage)
    console.log(
      '[3] 计价  :',
      cost.ok ? `OK ${cost.micros} micro` : `FAIL ${cost.reason}`,
      JSON.stringify(cost.ok ? cost.breakdown.tokens : {})
    )
  } else {
    console.log('[3] 计价  : 上游没有返回 usage，无法验证（检查 stream_options）')
  }

  process.exit(plain.ok && stream.ok ? 0 : 1)
})().catch(error => {
  console.error('smoke 异常:', error.message)
  process.exit(1)
})
