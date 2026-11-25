import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 设置页「会员套餐」。
 *
 * FIXED: 2026-11-12 默认**收起**，只留一行当前状态 + 一个按钮。
 *   之前把两档卡片直接铺在设置页里，占掉大半屏，而且用户每次进设置
 *   都要先滚过一块自己不关心的大画布。现在点「升级 / 查看套餐」才弹窗。
 *
 * 与「账户充值」是两件事：
 *   会员 = 买能力（编译 600 秒、协作不限、VIP 标识）
 *   充值 = 买 LLM 用量（按 token 扣余额）
 *
 * 价格一律用后端给的值（/api/billing/plans），前端不算价、不传价。
 *
 * FIXED: 2026-11-24 全部文案走 i18n（key 前缀 membership_）。
 *   后端 `plans.js` 的 name / tagline / cta / features / 周期 label / 折扣文案
 *   都是中文直给前端，所以这里按 **id 映射到 locale key**（free / pro /
 *   month / quarter / year），只有映射不到的未知 id 才回退用后端文案。
 *   新增文案请加 key 到 locales/en.json 与 locales/zh-CN.json。
 */

interface PlanPeriod {
  planId: string
  period: string
  label: string
  months: number
  discountLabel: string | null
  priceMicros: number
  price: number
}

interface Tier {
  id: string
  name: string
  tagline: string
  cta: string
  highlight?: boolean
  features: string[]
  currency: string
  periods: PlanPeriod[]
}

interface MembershipStatus {
  active: boolean
  expiresAt: string | null
  daysLeft: number | null
  compileTimeout: number | null
}

function symbolOf(currency: string) {
  if (currency === 'USD') return '$'
  if (currency === 'SGD') return 'S$'
  return '¥'
}

// 已知 tier → locale key 前缀（后端 id）
const TIER_KEY_PREFIX: Record<string, string> = {
  free: 'membership_tier_free',
  pro: 'membership_tier_pro',
}
// 已知 tier 的 feature 条数（与 plans.js 对齐；多出来的条目走回退）
const TIER_FEATURE_COUNT: Record<string, number> = { free: 5, pro: 9 }
// 已知周期 id → locale key
const PERIOD_KEYS: Record<string, string> = {
  month: 'membership_period_month',
  quarter: 'membership_period_quarter',
  year: 'membership_period_year',
}

function MembershipSection() {
  const { t, i18n } = useTranslation()
  const [tiers, setTiers] = useState<Tier[]>([])
  const [currency, setCurrency] = useState('CNY')
  const [period, setPeriod] = useState('month')
  const [status, setStatus] = useState<MembershipStatus | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/billing/plans', { headers: { Accept: 'application/json' } }),
      fetch('/api/billing/membership', { headers: { Accept: 'application/json' } }),
    ])
      .then(async ([plansRes, statusRes]) => {
        const plansBody = await plansRes.json()
        const statusBody = statusRes.ok ? await statusRes.json() : null
        if (cancelled) return
        if (plansBody.ok) {
          setTiers(plansBody.plans ?? [])
          setCurrency(plansBody.currency || 'CNY')
        }
        if (statusBody) setStatus(statusBody)
      })
      .catch(() => {
        if (!cancelled) setError(t('membership_err_load'))
      })
    return () => {
      cancelled = true
    }
    // t 只在错误文案里用；切语言不需要重新拉数据
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const subscribe = useCallback(
    async (planId: string) => {
      setBusy(planId)
      setError(null)
      try {
        const response = await fetch('/billing/subscribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Csrf-Token': (window as any).csrfToken,
          },
          body: JSON.stringify({ planId }),
        })
        const body = await response.json()
        if (!body.ok || !body.checkoutUrl) {
          setError(
            body.reason === 'provider_unavailable'
              ? t('membership_err_provider')
              : t('membership_err_create')
          )
          return
        }
        window.location.href = body.checkoutUrl
      } catch {
        setError(t('membership_err_network'))
      } finally {
        setBusy(null)
      }
    },
    [t]
  )

  const symbol = symbolOf(currency)

  const tierName = (tier: Tier) => {
    const prefix = TIER_KEY_PREFIX[tier.id]
    return prefix ? t(`${prefix}_name`) : tier.name
  }
  const tierTagline = (tier: Tier) => {
    const prefix = TIER_KEY_PREFIX[tier.id]
    return prefix ? t(`${prefix}_tagline`) : tier.tagline
  }
  const tierCta = (tier: Tier) => {
    const prefix = TIER_KEY_PREFIX[tier.id]
    return prefix ? t(`${prefix}_cta`) : tier.cta
  }
  const tierFeatures = (tier: Tier) => {
    const count = TIER_FEATURE_COUNT[tier.id]
    if (!count) return tier.features
    const prefix = TIER_KEY_PREFIX[tier.id]
    return Array.from({ length: count }, (_, index) =>
      t(`${prefix}_feature_${index + 1}`)
    )
  }
  const periodLabel = (value: PlanPeriod) =>
    PERIOD_KEYS[value.period] ? t(PERIOD_KEYS[value.period]) : value.label
  // 后端折扣文案形如「省 36%」，取出数字后按当前语言渲染
  const discountLabel = (value: PlanPeriod) => {
    if (!value.discountLabel) return null
    const percent = /(\d+)\s*%/.exec(value.discountLabel)
    return percent
      ? t('membership_discount_off', { percent: percent[1] })
      : value.discountLabel
  }
  const locale = i18n.language || 'en'

  return (
    <div className="settings-section" id="fl-membership">
      <h3>{t('membership_title')}</h3>
      <p className="text-muted small">{t('membership_lead')}</p>

      <p className="text-muted small">
        {status?.active ? (
          <>
            {t('membership_status_pro')}
            {status.expiresAt
              ? t('membership_status_valid_until', {
                  date: new Date(status.expiresAt).toLocaleDateString(locale),
                })
              : ''}
            {typeof status.daysLeft === 'number'
              ? t('membership_status_days_left', { days: status.daysLeft })
              : ''}
            {status.compileTimeout
              ? t('membership_status_compile_limit', {
                  seconds: status.compileTimeout,
                })
              : ''}
          </>
        ) : (
          <>{t('membership_status_free')}</>
        )}
      </p>

      {/* FIXED: 2026-11-15 会员充值页直接交代 VIP 与免费版的额度差异 */}
      <p className="text-muted small">{t('membership_vip_summary')}</p>

      {error && (
        <p className="text-danger small" role="alert">
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setDialogOpen(true)}
          disabled={tiers.length === 0}
        >
          {status?.active ? t('membership_cta_renew') : t('membership_cta_upgrade')}
        </button>
      </div>

      {/* ---------- 套餐弹窗 ---------- */}
      {dialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('membership_dialog_aria')}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 3000,
            padding: 16,
          }}
          onClick={event => {
            if (event.target === event.currentTarget && !busy) setDialogOpen(false)
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 14,
              padding: '22px 24px',
              width: 'min(880px, 96vw)',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: '0 24px 60px rgba(0,0,0,.24)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <h4 style={{ margin: 0, fontSize: 18 }}>{t('membership_dialog_title')}</h4>
              <button
                type="button"
                className="btn btn-link"
                onClick={() => setDialogOpen(false)}
                disabled={busy}
                aria-label={t('membership_dialog_close_aria')}
              >
                ✕
              </button>
            </div>

            {/* 周期切换 */}
            <div style={{ display: 'flex', gap: 8, margin: '14px 0 16px' }}>
              {(tiers.find(tier => tier.id === 'pro')?.periods ?? []).map(p => (
                <button
                  key={p.period}
                  type="button"
                  className={p.period === period ? 'btn btn-primary' : 'btn btn-default'}
                  onClick={() => setPeriod(p.period)}
                >
                  {periodLabel(p)}
                  {discountLabel(p) ? ` · ${discountLabel(p)}` : ''}
                </button>
              ))}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 16,
              }}
            >
              {tiers.map(tier => {
                const active = tier.id === 'pro' ? status?.active : !status?.active
                const selected = tier.periods.find(p => p.period === period)
                return (
                  <div
                    key={tier.id}
                    style={{
                      border: tier.highlight
                        ? '2px solid #0b6bcb'
                        : '1px solid rgba(0,0,0,.12)',
                      borderRadius: 12,
                      padding: '18px 20px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ fontSize: 17, fontWeight: 600 }}>{tierName(tier)}</div>
                    <div style={{ fontSize: 13, color: '#6b7280' }}>{tierTagline(tier)}</div>
                    <div style={{ fontSize: 28, fontWeight: 700 }}>
                      {tier.id === 'free'
                        ? `${symbol}0`
                        : selected
                        ? `${symbol}${selected.price}`
                        : '—'}
                      <span style={{ fontSize: 13, fontWeight: 400, color: '#6b7280' }}>
                        {tier.id === 'free'
                          ? t('membership_free_forever')
                          : selected
                          ? ` / ${periodLabel(selected)}`
                          : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={tier.highlight ? 'btn btn-primary' : 'btn btn-default'}
                      disabled={active || busy !== null || !selected}
                      onClick={() => selected && subscribe(selected.planId)}
                    >
                      {busy === selected?.planId
                        ? t('membership_redirecting')
                        : active
                        ? t('membership_current_plan')
                        : tierCta(tier)}
                    </button>
                    <ul
                      style={{
                        margin: '4px 0 0',
                        paddingLeft: 18,
                        fontSize: 13,
                        lineHeight: 1.9,
                      }}
                    >
                      {tierFeatures(tier).map(feature => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>

            {error && (
              <p className="text-danger small" role="alert" style={{ marginTop: 12 }}>
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default MembershipSection
