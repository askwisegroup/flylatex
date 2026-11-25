const { callbackify } = require('util')
const logger = require('@overleaf/logger')
const metrics = require('@overleaf/metrics')
const Settings = require('@overleaf/settings')
const nodemailer = require('nodemailer')
const sesTransport = require('nodemailer-ses-transport')
const OError = require('@overleaf/o-error')
const { RateLimiter } = require('../../infrastructure/RateLimiter')
const _ = require('lodash')
// FIXED: 2026-11-19 内部/私有默认值的统一出口（开源版为占位值）
const INTERNAL = require('../../../../config/internal-values')
const EmailHttpTransport = require('./EmailHttpTransport')

const EMAIL_SETTINGS = Settings.email || {}
const EMAIL_INTERNAL = (INTERNAL && INTERNAL.email) || {}

module.exports = {
  sendEmail: callbackify(sendEmail),
  promises: {
    sendEmail,
  },
}

const client = getClient()

const rateLimiter = new RateLimiter('send_email', {
  points: 100,
  duration: 3 * 60 * 60,
})

function getClient() {
  // FIXED: 2026-11-19 支持外部 HTTP 邮件网关（内部版专用，开源版走不到这里）。
  //   优先级：环境变量 > internal-values.email；都没有 → 完全走下面的原有逻辑。
  const transport = process.env.EMAIL_TRANSPORT || EMAIL_INTERNAL.transport
  if (transport === 'http') {
    const url = process.env.EMAIL_GATEWAY_URL || EMAIL_INTERNAL.gatewayUrl
    const token = process.env.EMAIL_GATEWAY_TOKEN || EMAIL_INTERNAL.gatewayToken
    if (!url || !token) {
      throw new OError(
        'email transport "http" requires EMAIL_GATEWAY_URL and EMAIL_GATEWAY_TOKEN ' +
          '(or internal-values.email.gatewayUrl / gatewayToken)'
      )
    }
    // provider: 'generic'（默认，Bearer + 自定义报文）或 'brevo'（api-key + Brevo 报文）
    const provider = process.env.EMAIL_PROVIDER || EMAIL_INTERNAL.provider
    const senderName =
      process.env.EMAIL_SENDER_NAME ||
      EMAIL_INTERNAL.senderName ||
      Settings.appName
    const senderEmail =
      process.env.EMAIL_SENDER_EMAIL ||
      EMAIL_INTERNAL.senderEmail ||
      EMAIL_SETTINGS.fromAddress ||
      (INTERNAL.misc && INTERNAL.misc.adminEmail)
    logger.debug({ provider }, 'using http email provider')
    const httpClient = EmailHttpTransport.createClient({
      url,
      token,
      provider,
      senderName,
      senderEmail,
      timeoutMs: EMAIL_INTERNAL.timeoutMs,
    })
    httpClient.provider = provider || 'http'
    return httpClient
  }
  if (transport) {
    logger.warn(
      { transport },
      'unknown email transport, using legacy transport'
    )
  }
  return getLegacyClient()
}

// FIXED: 2026-11-19 原传输层选择逻辑原样保留，作为未配置 HTTP 网关时的默认路径。
function getLegacyClient() {
  let client
  let provider = 'stub'
  if (EMAIL_SETTINGS.parameters) {
    const emailParameters = EMAIL_SETTINGS.parameters
    if (emailParameters.AWSAccessKeyID || EMAIL_SETTINGS.driver === 'ses') {
      logger.debug('using aws ses for email')
      provider = 'ses'
      client = nodemailer.createTransport(sesTransport(emailParameters))
    } else if (emailParameters.sendgridApiKey) {
      throw new OError(
        'sendgridApiKey configuration option is deprecated, use SMTP instead'
      )
    } else if (emailParameters.MandrillApiKey) {
      throw new OError(
        'MandrillApiKey configuration option is deprecated, use SMTP instead'
      )
    } else {
      logger.debug('using smtp for email')
      provider = 'smtp'
      const smtp = _.pick(
        emailParameters,
        'host',
        'port',
        'secure',
        'auth',
        'ignoreTLS',
        'logger',
        'name'
      )
      client = nodemailer.createTransport(smtp)
    }
  } else {
    logger.warn(
      'Email transport and/or parameters not defined. No emails will be sent.'
    )
    client = {
      async sendMail() {
        // 实际未发送：由 sendEmail 统一打 warn（info 级可见）
      },
    }
  }
  client.provider = provider
  return client
}

async function sendEmail(options) {
  const startedAt = Date.now()
  try {
    const canContinue = await checkCanSendEmail(options)
    if (!canContinue) {
      logger.warn(
        {
          emailType: options.emailType,
          sendingUserId: options.sendingUser_id,
          to: options.to,
        },
        'email not sent: rate limit hit'
      )
      throw new OError('rate limit hit sending email')
    }
    metrics.inc('email')
    const sendMailOptions = {
      to: options.to,
      from: EMAIL_SETTINGS.fromAddress || '',
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo || EMAIL_SETTINGS.replyToAddress,
      socketTimeout: 30 * 1000,
    }
    if (EMAIL_SETTINGS.textEncoding != null) {
      sendMailOptions.textEncoding = EMAIL_SETTINGS.textEncoding
    }
    await client.sendMail(sendMailOptions)
    // FIXED: 2026-11-19 发信结果在 info/warn 级可见。
    // 之前成功只打 debug，线上 info 级完全看不到，排查时无法区分「发了」和「没发」。
    if (client.provider === 'stub') {
      logger.warn(
        { emailType: options.emailType, to: options.to },
        'email not sent: no email transport configured'
      )
    } else {
      logger.info(
        {
          emailType: options.emailType,
          provider: client.provider,
          to: options.to,
          ms: Date.now() - startedAt,
        },
        'email sent'
      )
    }
  } catch (err) {
    logger.error(
      {
        err,
        emailType: options.emailType,
        provider: client.provider,
        to: options.to,
        ms: Date.now() - startedAt,
      },
      'email send failed'
    )
    throw new OError('error sending message').withCause(err)
  }
}

async function checkCanSendEmail(options) {
  if (options.sendingUser_id == null) {
    // email not sent from user, not rate limited
    return true
  }
  try {
    await rateLimiter.consume(options.sendingUser_id)
  } catch (err) {
    if (err instanceof Error) {
      throw err
    } else {
      return false
    }
  }
  return true
}
