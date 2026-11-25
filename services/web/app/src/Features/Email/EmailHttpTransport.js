const http = require('http')
const https = require('https')
const { URL } = require('url')
const logger = require('@overleaf/logger')
const OError = require('@overleaf/o-error')

// FIXED: 2026-11-19 新增。内部版专用的邮件传输层：把发信委派给外部 HTTP 服务
// （可以是自己的网关，也可以直接是 Brevo 这类供应商 API）。
//
// 设计约束（与项目约定一致）：
//   - 本文件只做「HTTP 调用 + 报文映射 + 超时 + 错误分类」，不含密钥；
//   - 地址/Key 由 internal-values.email 或环境变量注入，开源版两者都没有 → 不会
//     走到这里（EmailSender 默认仍走原有 SES/SMTP/stub 逻辑）；
//   - 4xx 视为永久失败（地址非法、被抑制……），5xx/429/超时视为可重试，错误上带
//     `info.retryable`，供队列消费者将来决定是否重试（当前 Bull 行为不变）。
//
// 支持的报文格式（email.provider）：
//   - generic（默认）：POST <url> { to, subject, html, text, from?, replyTo? }
//                      Header: Authorization: Bearer <token>
//   - brevo：        POST https://api.brevo.com/v3/smtp/email
//                      { sender, to: [{ email }], subject, htmlContent, textContent }
//                      Header: api-key: <token>

const DEFAULT_TIMEOUT_MS = 30 * 1000
const MAX_RESPONSE_BYTES = 100 * 1024

module.exports = {
  createClient,
}

/**
 * @param {{
 *   url: string,
 *   token?: string,
 *   provider?: 'generic' | 'brevo',
 *   senderName?: string,
 *   senderEmail?: string,
 *   timeoutMs?: number,
 * }} config
 * @returns {{ sendMail: (options: Object) => Promise<{ messageId?: string }> }}
 */
function createClient(config = {}) {
  if (!config.url) {
    throw new OError('email provider url is not configured')
  }
  const provider = config.provider || 'generic'
  if (provider === 'brevo' && !config.senderEmail) {
    throw new OError(
      'email provider "brevo" requires a sender email ' +
        '(EMAIL_SENDER_EMAIL / internal-values.email.senderEmail / Settings.email.fromAddress)'
    )
  }
  return {
    async sendMail(options) {
      const { payload, headers } = buildRequest(config, provider, options)
      const startedAt = Date.now()
      const result = await postJson({ ...config, headers }, payload)
      logger.debug(
        {
          provider,
          statusCode: result.statusCode,
          ms: Date.now() - startedAt,
        },
        'email provider accepted message'
      )
      return { messageId: result.messageId }
    },
  }
}

function buildRequest(config, provider, options) {
  if (provider === 'brevo') {
    return {
      payload: {
        sender: {
          name: config.senderName || undefined,
          email: config.senderEmail,
        },
        to: [{ email: options.to }],
        subject: options.subject,
        ...(options.html ? { htmlContent: options.html } : {}),
        ...(options.text ? { textContent: options.text } : {}),
        ...(options.replyTo ? { replyTo: { email: options.replyTo } } : {}),
      },
      headers: config.token ? { 'api-key': config.token } : {},
    }
  }

  return {
    payload: {
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      from: options.from || undefined,
      replyTo: options.replyTo || undefined,
      idempotencyKey: options.idempotencyKey || undefined,
    },
    headers: {
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(options.idempotencyKey
        ? { 'Idempotency-Key': options.idempotencyKey }
        : {}),
    },
  }
}

function postJson(config, payload) {
  let target
  try {
    target = new URL(config.url)
  } catch (err) {
    return Promise.reject(
      new OError('email provider url is invalid', {
        retryable: false,
      }).withCause(err)
    )
  }

  const isHttps = target.protocol === 'https:'
  const body = Buffer.from(JSON.stringify(payload))
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const request = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...(config.headers || {}),
        },
      },
      response => {
        const chunks = []
        let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(
              new OError('email provider response too large', {
                retryable: false,
                statusCode: response.statusCode,
              })
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('error', err => {
          reject(OError.tag(err, 'failed to read email provider response'))
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const statusCode = response.statusCode
          if (statusCode >= 200 && statusCode < 300) {
            let messageId
            try {
              messageId = JSON.parse(text).messageId
            } catch (err) {
              // 2xx 但响应不是 JSON：视为成功，只是拿不到 messageId
            }
            return resolve({ messageId, statusCode })
          }
          reject(
            new OError(`email provider returned ${statusCode}`, {
              statusCode,
              retryable: statusCode === 429 || statusCode >= 500,
              response: text.slice(0, 500),
            })
          )
        })
      }
    )

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new OError('email provider request timed out', {
          retryable: true,
          timeoutMs,
        })
      )
    })

    request.on('error', err => {
      reject(OError.tag(err, 'email provider request failed'))
    })

    request.end(body)
  })
}
