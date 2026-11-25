'use strict'

/**
 * 金额换算：我方账本用「微单位」(1e-6)，支付渠道用「最小货币单位」(分/元/…)。
 *
 * 为什么单独一个文件：
 *   这个换算是充值链路上**唯一**会静默产生 100 倍差错的地方
 *   （少乘 100 = 用户付 100 到账 1，多乘 100 = 平台白送 99）。
 *   散落在各处迟早写错一次，所以收敛到一处并被测试钉死。
 *
 * 两个方向的规则故意不同：
 *   micros → minor : 向下取整。宁可少收用户一分，也不能多扣。
 *   minor  → micros: 精确乘法，无浮点参与。
 */

const MICRO = 1_000_000

/**
 * 各货币的最小单位指数。
 * 未列出的货币按 2 位处理（绝大多数情况），并在调用处打警告，
 * 以免把一个 0 位小数货币（如 JPY）当成 2 位而放大 100 倍。
 */
const MINOR_UNIT_EXP = Object.freeze({
  // 2 位小数
  CNY: 2,
  SGD: 2,
  USD: 2,
  HKD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  NZD: 2,
  MYR: 2,
  THB: 2,
  PHP: 2,
  IDR: 2,
  INR: 2,
  TWD: 2,
  MOP: 2,
  // 0 位小数
  JPY: 0,
  KRW: 0,
  VND: 0,
})

/** 该货币乘以多少倍得到最小单位（SGD → 100, JPY → 1） */
function minorFactor(currency) {
  const code = String(currency || '').toUpperCase()
  const exp = MINOR_UNIT_EXP[code]
  if (exp === undefined) return { factor: 100, known: false }
  return { factor: Math.pow(10, exp), known: true }
}

/**
 * micro → 支付渠道要的整数金额（向下取整）。
 * @returns {{ amountMinor: number, currency: string, known: boolean }}
 */
function toMinorUnits(micros, currency) {
  const amount = Number(micros)
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('invalid_micros')
  }
  const { factor, known } = minorFactor(currency)
  // 先除 1e6 再乘 factor，用整数运算避免 0.1+0.2 类误差
  const amountMinor = Math.floor((amount * factor) / MICRO)
  return { amountMinor, currency: String(currency).toUpperCase(), known }
}

/** 支付渠道回报的整数金额 → micro（精确，无浮点） */
function toMicros(amountMinor, currency) {
  const amount = Number(amountMinor)
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error('invalid_minor_amount')
  }
  const { factor } = minorFactor(currency)
  return (amount * MICRO) / factor
}

/** 给日志/界面用：micro → "12.34" */
function formatAmount(micros, currency) {
  const { factor } = minorFactor(currency)
  const decimals = Math.round(Math.log10(factor))
  return (Number(micros) / MICRO).toFixed(decimals)
}

module.exports = {
  MICRO,
  MINOR_UNIT_EXP,
  minorFactor,
  toMinorUnits,
  toMicros,
  formatAmount,
}
