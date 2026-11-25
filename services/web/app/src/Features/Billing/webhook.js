'use strict'

/**
 * 支付渠道回调入口。
 *
 * 这个文件只做三件事，顺序不能变：
 *   1. 用**原始 body** 验签（必须，见下）
 *   2. 把事件拍平 / 判成功
 *   3. 交给 checkout.applyPaidEvent 入账
 *
 * 为什么必须拿原始 body：
 *   express 的 json 中间件会把 body 解析成对象再序列化，
 *   字节顺序、空格、转义都会变，HMAC 必然对不上。
 *   所以这个路由必须单独挂 express.raw()（不要经过任何 JSON 解析），
 *   而且要在全局 body-parser 之前 —— 顺序错了就只能靠猜。
 *
 * 为什么验签失败也返回 200：
 *   渠道的直觉是「4xx/5xx 就重试」。签名错是配置问题，
 *   重试一万次也不会变对，只会把日志刷爆。
 *   这里返回 200 + 明确 reason，同时打 error 日志告警。
 *   但如果对方是「我们暂时处理不了」（比如数据库抖动），
 *   必须返回 5xx 让它重试 —— 否则这笔钱就永远丢了。
 */

const logger = require('@overleaf/logger')
const Providers = require('./providers')
const Checkout = require('./checkout')

/**
 * @param {{ rawBody: Buffer|string, headers: object }} args
 * @returns {Promise<{ status: number, body: object }>} 直接回给渠道的响应
 */
async function handleRawEvent({ rawBody, headers } = {}) {
  const provider = Providers.current()
  if (provider.id === 'none') {
    logger.error('[billing] 收到支付回调但未配置支付渠道')
    return { status: 200, body: { ok: false, reason: 'provider_not_configured' } }
  }

  const verified = provider.verifyWebhook({ rawBody, headers })
  if (!verified.ok) {
    logger.error(
      { provider: provider.id, reason: verified.reason },
      '[billing] 支付回调验签失败'
    )
    return { status: 200, body: { ok: false, reason: verified.reason } }
  }

  const parsed = provider.parseEvent(verified.event)
  if (!parsed.isSucceeded) {
    // 非支付成功事件（created / refund …）：不处理，但要让渠道知道我们收到了
    return {
      status: 200,
      body: { ok: true, ignored: true, event: parsed.eventType },
    }
  }

  try {
    const result = await Checkout.applyPaidEvent({
      event: verified.event,
      provider,
    })
    if (result.reason === 'order_not_found') {
      // 我们不认识这笔钱 —— 这属于资金异常，需要人工介入
      logger.error(
        { eventId: parsed.eventId, intentId: parsed.intentId },
        '[billing] 回调对应的订单不存在，需人工核对'
      )
    }
    return {
      status: 200,
      body: {
        ok: true,
        credited: Boolean(result.credited),
        duplicate: Boolean(result.duplicate),
        reason: result.reason,
      },
    }
  } catch (error) {
    // 处理失败（DB 抖动等）：返回 5xx 让渠道重试，别吞掉这笔钱
    logger.error({ err: error }, '[billing] 回调处理失败，等待渠道重试')
    return { status: 500, body: { ok: false, reason: 'processing_failed' } }
  }
}

module.exports = { handleRawEvent }
