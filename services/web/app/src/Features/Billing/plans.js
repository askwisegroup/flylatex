'use strict'

/**
 * 会员套餐目录（只读，代码内定义，不入库）。
 *
 * 两档：免费 / 专业版（参考 Manus 的升级弹窗，不做 Max 档）。
 * 周期：月 / 季 / 年。价格是「发布动作」，走 git，不走运营后台改。
 *
 * 与 LLM 额度的关系（之前搞混过，这里写死口径）：
 *   - 会员（本文件）卖「能力」：编译超时 600 秒、协作人数不限、VIP 标识。
 *   - 充值（Billing.createTopup）卖「用量」：LLM 按 token 扣余额。
 *   两本账完全独立：买会员不加 LLM 余额，充值也不会变成会员。
 */

/**
 * 价格（微单位，1 元 = 1_000_000）。缺币种回落 CNY。
 *
 * 社区版只提供结构与流程，**不含任何真实售价**：全部置 0，部署方自行填写
 * （或改用 Settings.llm 之外的自有计价服务）。0 表示「未定价」，
 * /api/billing/plans 会把 0 原样返回，前端显示为 ¥0。
 */
const PRICES = {
  month: { CNY: 0, USD: 0, SGD: 0 },
  quarter: { CNY: 0, USD: 0, SGD: 0 },
  year: { CNY: 0, USD: 0, SGD: 0 },
}

const PERIODS = [
  {
    period: 'month',
    planId: 'pro-month',
    label: '月付',
    months: 1,
    // 相对月付的年化折扣，用于 UI 上的「省 X%」
    discountLabel: null,
  },
  {
    period: 'quarter',
    planId: 'pro-quarter',
    label: '季付',
    months: 3,
    discountLabel: '省 15%',
  },
  {
    period: 'year',
    planId: 'pro-year',
    label: '年付',
    months: 12,
    discountLabel: '省 36%',
  },
]

/**
 * 权益清单。文案直接给前端渲染，避免前端再写一份。
 * 只写我们**真的**具备的能力，不吹。
 */
const TIERS = [
  {
    id: 'free',
    name: '免费',
    tagline: '先把手上的论文编译起来',
    cta: '当前计划',
    features: [
      '编辑、编译、PDF 预览',
      '项目最多 50 个，协作者最多 5 人',
      '磁盘空间 256MB，单个文件最大 10MB',
      '单次编译最长 300 秒',
      'LLM 助手按实际 token 扣费',
    ],
  },
  {
    id: 'pro',
    name: '专业版',
    tagline: '长文档、大工程不被打断',
    cta: '升级',
    highlight: true,
    features: [
      '包含免费版全部功能',
      '项目数量不限，协作者人数不限',
      '磁盘空间 2GB，单个文件最大 50MB',
      '单次编译最长 600 秒（10 分钟）',
      'Agent 单次编译最长 10 分钟',
      '可接入自定义 MCP 服务',
      '账号 VIP 标识',
      'AI 助手优先队列',
      '优先支持',
    ],
  },
]

function normaliseCurrency(code) {
  return String(code || 'CNY').toUpperCase()
}

function priceFor(period, currencyCode) {
  const row = PRICES[period]
  if (!row) return null
  const code = normaliseCurrency(currencyCode)
  return row[code] != null ? row[code] : row.CNY
}

function getPeriod(period) {
  return PERIODS.find(p => p.period === period) || null
}

/** 按 planId 反查（'pro-year' → {months:12, period:'year', ...}） */
function getPlan(planId) {
  const p = PERIODS.find(item => item.planId === planId)
  if (!p) return null
  return {
    id: p.planId,
    tier: 'pro',
    name: '专业版 · ' + p.label,
    months: p.months,
    period: p.period,
  }
}

/**
 * 面向接口的套餐列表：微单位换算成货币单位，前端不再乘除 1e6。
 */
function listTiers(currencyCode) {
  const code = normaliseCurrency(currencyCode)
  return TIERS.map(tier => {
    if (tier.id === 'free') {
      return Object.assign({}, tier, { currency: code, periods: [] })
    }
    return Object.assign({}, tier, {
      currency: code,
      periods: PERIODS.map(p => ({
        planId: p.planId,
        period: p.period,
        label: p.label,
        months: p.months,
        discountLabel: p.discountLabel,
        priceMicros: priceFor(p.period, code),
        price: priceFor(p.period, code) / 1e6,
      })),
    })
  })
}

module.exports = {
  TIERS,
  PERIODS,
  getPlan,
  getPeriod,
  listTiers,
  priceFor,
  normaliseCurrency,
}
