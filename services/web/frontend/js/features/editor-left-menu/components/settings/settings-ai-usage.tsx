import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import getMeta from '../../../../utils/meta'

/**
 * 设置 → AI 助手 → AI 用量（只读展示）
 *
 * FIXED: 2026-11-01
 * 背景：额度/用量原来只在「账号设置」页（/user/settings）里能看，
 * 但用户是在编辑器里连续使用 AI 的，想知道"还剩多少"得先切页面。
 * 这里在设置面板里给一行摘要，数据源与账号设置页完全一致（同一个网关账本）：
 *   GET /api/llm/balance → { balance: { remaining, totalIncome, totalExpense, totalWriteOff }, link }
 *   GET /api/llm/usage   → { usage: { totalTokens, calls, bySource } }
 * 读不到就降级成一句说明 + 去账号设置页看，不报错、不阻塞其他设置项。
 *
 * FIXED: 2026-11-25 站内计费（海外站）下不再请求 NE 网关。
 * 之前这个面板只有 NE 一条路径，`DEPLOYMENT_PROFILE=sg` 的站点上照样打
 * /api/llm/balance，读不到就显示「额度需先连接账号」——而用户刚在 /user/settings
 * 充过钱、余额就在本地账本里，两处数字互相打脸。
 * 现在与 accounts 页的 UsageSection 用同一个开关（ol-ExposedSettings.billing.ledgerEnabled）：
 *   ledger 模式 → 只打 /api/llm/usage（本地 llm_usage 集合，按模型/来源聚合）
 *                 余额不在这里重复算，给一个跳 /user/settings 的入口
 *   NE 模式     → 行为与以前完全一致（国内站）
 */
type Balance = {
  remaining: number
  totalIncome: number
  totalExpense: number
  totalWriteOff: number
  updatedAt?: string | null
}

type Usage = {
  totalTokens?: number | null
  calls?: number | null
  // FIXED: 2026-11-01 按来源拆开（站内 AI 助手 / 白板共用同一本账）
  bySource?: Record<string, { calls?: number; totalTokens?: number }> | null
  // FIXED: 2026-11-25 后端 summaryToday 一直有按模型聚合，前端一直没用上：
  // 海外站「今天到底是谁吃掉的额度」只能靠这个回答
  byModel?: Array<{ model?: string; totalTokens?: number; calls?: number }> | null
}

type State = {
  loading: boolean
  refreshing: boolean
  balance: Balance | null
  usage: Usage | null
  reason: string
}

const DETAIL_URL = '/user/settings'

export default function SettingsAIUsage() {
  const { t } = useTranslation()
  const [state, setState] = useState<State>({
    loading: true,
    refreshing: false,
    balance: null,
    usage: null,
    reason: '',
  })

  // 与 /user/settings 的 UsageSection 同一个开关：海外站读本地账本，不碰 NE 网关
  const exposed = getMeta('ol-ExposedSettings') as
    | { billing?: { ledgerEnabled?: boolean; enabled?: boolean } }
    | undefined
  const ledgerMode = Boolean(exposed?.billing?.ledgerEnabled)

  const load = useCallback(async (isRefresh?: boolean) => {
    if (isRefresh) {
      setState(prev => ({ ...prev, refreshing: true }))
    }
    try {
      const [balanceRes, usageRes] = await Promise.all([
        // ledger 模式下没有「网关余额」这个东西：NULL response，不发起请求。
        // 否则 401/404 会被当成 reason 显示成 NE 口径的文案。
        ledgerMode
          ? Promise.resolve(null)
          : fetch('/api/llm/balance', { headers: { Accept: 'application/json' } }),
        fetch('/api/llm/usage', { headers: { Accept: 'application/json' } }),
      ])

      let balance: Balance | null = null
      let reason = ''
      if (balanceRes && balanceRes.ok) {
        const body = await balanceRes.json()
        if (body && body.balance) {
          balance = body.balance
        } else {
          reason = typeof body?.reason === 'string' ? body.reason : 'unavailable'
        }
      }

      let usage: Usage | null = null
      if (usageRes.ok) {
        const body = await usageRes.json()
        usage = body?.usage ?? null
      }

      setState({ loading: false, refreshing: false, balance, usage, reason })
    } catch {
      // 网关不可达 / 非 JSON（例如登录重定向）都按“读不到”处理
      setState({
        loading: false,
        refreshing: false,
        balance: null,
        usage: null,
        reason: 'unavailable',
      })
    }
  }, [ledgerMode])

  useEffect(() => {
    load()
  }, [load])

  const fmt = (value?: number | null) =>
    typeof value === 'number' ? value.toLocaleString() : '—'

  return (
    <div className="form-group left-menu-setting">
      <label>{t('ai_usage', { defaultValue: '用量信息' })}</label>

      <div className="settings-ai-usage">
        {state.loading ? (
          <p className="settings-ai-usage-line">
            {t('ai_usage_loading', { defaultValue: '读取中…' })}
          </p>
        ) : ledgerMode ? (
          // 海外站：金额在本地账本（/user/settings 的充值记录），这里只报用量，
          // 不再拿「网关剩余额度」冒充余额。
          <p className="settings-ai-usage-line settings-ai-usage-sub">
            {t('ai_usage_today', {
              defaultValue: '今日 __tokens__ tokens · __calls__ 次调用',
              tokens: fmt(state.usage?.totalTokens),
              calls: fmt(state.usage?.calls),
            })}
            {state.usage?.byModel?.length
              ? t('ai_usage_top_model', {
                  defaultValue: '（最多 __model__）',
                  model: state.usage.byModel[0].model || '—',
                })
              : ''}
          </p>
        ) : state.balance ? (
          <>
            <p className="settings-ai-usage-line">
              <strong className="settings-ai-usage-value">
                {fmt(state.balance.remaining)}
              </strong>{' '}
              {t('ai_usage_remaining', { defaultValue: 'tokens 剩余' })}
            </p>
            <p className="settings-ai-usage-line settings-ai-usage-sub">
              {t('ai_usage_today', {
                // 注意：本项目 i18n 是 legacy v1 格式，插值是 __var__ 而不是 {{var}}
                // （见 frontend/js/i18n.js 的 interpolation.prefix/suffix）
                defaultValue: '今日 __tokens__ tokens · __calls__ 次调用',
                tokens: fmt(state.usage?.totalTokens),
                calls: fmt(state.usage?.calls),
              })}
              {state.usage?.bySource
                ? t('ai_usage_by_source', {
                    defaultValue: '（站内 AI __chat__ 次 · 白板 __relay__ 次）',
                    chat: fmt(state.usage.bySource['ft-ai']?.calls),
                    relay: fmt(state.usage.bySource.relay?.calls),
                  })
                : ''}
            </p>
          </>
        ) : (
          <p className="settings-ai-usage-line settings-ai-usage-sub">
            {state.reason === 'ne_not_linked' || state.reason === 'reauth_required'
              ? t('ai_usage_need_link', {
                  defaultValue: '额度需先连接账号，可在账号设置里查看',
                })
              : t('ai_usage_unavailable', {
                  defaultValue: '暂时读不到额度信息',
                })}
          </p>
        )}

        <p className="settings-ai-usage-line settings-ai-usage-sub">
          <a href={DETAIL_URL} target="_blank" rel="noreferrer noopener">
            {t('ai_usage_detail', { defaultValue: '查看详细用量与余额 →' })}
          </a>
          {' · '}
          <button
            type="button"
            className="btn-link settings-ai-usage-refresh"
            onClick={() => load(true)}
            disabled={state.refreshing}
          >
            {state.refreshing
              ? t('ai_usage_refreshing', { defaultValue: '刷新中…' })
              : t('ai_usage_refresh', { defaultValue: '刷新' })}
          </button>
        </p>
      </div>
    </div>
  )
}
