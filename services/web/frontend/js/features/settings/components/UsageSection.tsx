import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Chart, { type ChartConfiguration } from 'chart.js/auto'
import getMeta from '../../../utils/meta'
// FIXED: 2026-11-15 有效期不足 20 天时给一个续费提醒（复用统一下单地址）
import { VIP_ORDER_URL } from './vip-upsell-section'
// FIXED: 2026-11-15 【临时】?vipPreview=normal|soon|expired 预览非 VIP 界面
import { VipPreviewBanner, resolveVipPreview } from './vip-preview'

interface UserUsageData {
  totalSize: number
  totalSizeInMB: number
  // 分类明细：2.87 MB 这个数字本身没信息量，得说清它是"文字 + 附件"
  textSize?: number
  textSizeInMB?: number
  fileSize?: number
  fileSizeInMB?: number
  fileCount?: number
  fileSizeFailedCount?: number
  projectCount: number
  docCount: number
  trashedProjectCount?: number
  trashedDocCount?: number
  trashedSize?: number
  trashedSizeInMB?: number
  updatedAt: string
}

function UsageSection() {
  const { t, i18n } = useTranslation()
  const pieChartRef = useRef<HTMLCanvasElement>(null)
  const chartInstance = useRef<Chart<'pie', number[], string>>()
  const [isLoading, setIsLoading] = useState(false)
  const [usageData, setUsageData] = useState<UserUsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [useRealtime, setUseRealtime] = useState(false)
  // 额度数据来源：网关账本（/api/llm/balance），与 NE 账户页同一个数字
  const [llm, setLlm] = useState<{
    remaining: number
    totalIncome: number
    totalExpense: number
    totalWriteOff: number
    updatedAt: string | null
    todayTokens: number | null
    todayCalls: number | null
    // 站内 AI 助手 / 白板 分开计数，但共用同一本账
    bySource: Record<string, { calls: number; totalTokens: number }> | null
  } | null>(null)
  // 没有 NE 账号时也要说清楚发生了什么：这个页面本身只对已登录用户渲染，
  // 所以任何"未登录"的字样在这里都是错的。
  // FIXED: 2026-11-12 站内计费（海外站）下，LLM 额度来自本地账本，
  // 不再请求 NE 网关。之前不分模式，一律打 /api/llm/balance，
  // 结果页面上出现「NE 额度：暂时读取不到 / NE 网关本轮没有响应」，
  // 而用户刚刚充值成功、余额就在本地账本里 —— 自相矛盾。
  const exposed = getMeta('ol-ExposedSettings') as
    | {
        billing?: {
          ledgerEnabled?: boolean
          currency?: string
          enabled?: boolean
        }
      }
    | undefined
  // FIXED: 2026-11-15 sg 有站内充值（会员套餐与充值就在本页上方），续费链接指回本页的
  //   会员区块，不跳外部账户中心。cn 没有这个开关，
  //   行为完全不变。
  // OLD: <a href={VIP_ORDER_URL} target="_blank" rel="noopener noreferrer">
  const inSiteBilling = exposed?.billing?.enabled === true
  const renewHref = inSiteBilling ? '#fl-membership' : VIP_ORDER_URL
  const renewLinkProps = inSiteBilling
    ? {}
    : { target: '_blank', rel: 'noopener noreferrer' }
  const ledgerMode = Boolean(exposed?.billing?.ledgerEnabled)
  const [credit, setCredit] = useState<{
    balance: number
    currency: string
    todayTokens: number | null
    todayCalls: number | null
    // FIXED: 2026-11-25 summaryToday 一直带着按模型聚合，这里一直没用：
    // 海外站用户问的「额度到底被谁吃掉了」只能靠它回答
    byModel: Array<{
      model: string
      source: string
      calls: number
      totalTokens: number
    }>
  } | null>(null)

  const [llmUnavailable, setLlmUnavailable] = useState<{
    reason: string
    identifiers: string[]
    gatewayStatus: number | null
    todayTokens: number | null
    todayCalls: number | null
    bySource: Record<string, { calls: number; totalTokens: number }> | null
  } | null>(null)

  // FIXED: 2026-10-27 NE 连接的到期日。
  // FlyLaTeX 的 sid 是滚动会话（一直在用就永不过期），NE 会话却有绝对截止时间
  // （最长 30 天，刷新不延长）。两者会分叉，所以要在到期**之前**把日期说出来，
  // 而不是到期之后只说一句"已过期"。
  const [llmLink, setLlmLink] = useState<{
    linked: boolean
    sessionExpiresAt: string | null
    daysLeft: number | null
  } | null>(null)
  // 重新连接回来后的结果：ok / failed / account_mismatch / unavailable
  const [relinkResult, setRelinkResult] = useState<string | null>(null)

  // 从meta标签获取用户详情（缓存数据）
  const cachedUserDetail = getMeta('ol-userDetail')

  // FIXED: 2026-05-15 获取VIP状态和配额信息
  const user = getMeta('ol-user') || {}
  const features = user.features || {}
  // FIXED: 2026-11-15 统一走 resolveVipPreview：默认返回真实 vipStatus，
  // 只有地址栏带 ?vipPreview=... 时才被覆盖（临时调试用，见 vip-preview.tsx）
  // OLD: const vipStatus = user.vipStatus || {}
  // OLD: const isVip = vipStatus.isVip === true
  const preview = resolveVipPreview(user)
  const isVip = preview.isVip
  const isVipExpired = preview.isExpired
  const vipEndDate = preview.vipEndDate
  const vipDaysRemaining = preview.daysRemaining
  const compileTimeout =
    preview.compileTimeout ?? (features.compileTimeout || 300) // 默认5分钟
  // FIXED: 2026-11-15 普通用户协作者上限 5 人，VIP 不限制
  const rawCollaborators =
    typeof features.collaborators === 'number' ? features.collaborators : -1
  const collaborators = isVip
    ? rawCollaborators
    : Math.min(rawCollaborators === -1 ? 5 : rawCollaborators, 5)

  const compileTimeoutMinutes = Math.round(compileTimeout / 60)

  // 获取实时用户磁盘用量
  const fetchRealtimeUsage = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/user/usage', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const result = await response.json()
      if (result.success && result.data) {
        setUsageData(result.data)
        setUseRealtime(true)
        // 显示成功提示
        if (result.cacheUpdated) {
          setError(null) // 清除任何错误信息，改为显示成功
        }
      } else {
        throw new Error(result.message || 'Failed to fetch usage data')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setUseRealtime(false)
    } finally {
      setIsLoading(false)
    }
  }

  // 确定使用哪个数据源
  const userData = usageData || cachedUserDetail
  const usedSizeMB = usageData
    ? usageData.totalSizeInMB
    : parseFloat(cachedUserDetail.totalSizeInMB) || 0

  // FIXED: 2026-11-15 普通用户 256MB，VIP 2GB（与服务端 UserVip 上限一致）
  const totalSpaceBytes = isVip ? 2 * 1024 * 1024 * 1024 : 256 * 1024 * 1024

  const usedSpaceBytes = Math.round(usedSizeMB * 1024 * 1024)
  const usedPercentage = Math.min(
    Math.round((usedSpaceBytes / totalSpaceBytes) * 100),
    100
  )

  // 仅实时接口有分类明细；cachedUserDetail 只有总和，退回时明细显示为 —
  const textSizeBytes = usageData?.textSize ?? null
  const fileSizeBytes = usageData?.fileSize ?? null
  const fileCount = usageData?.fileCount ?? null
  const freeSpaceBytes = Math.max(totalSpaceBytes - usedSpaceBytes, 0)
  const pieUsage = {
    text: textSizeBytes ?? usedSpaceBytes,
    files: fileSizeBytes ?? 0,
    free: freeSpaceBytes,
  }

  // FIXED: 2026-05-18 额度口径改为 NE 网关账本。
  // 旧实现写死 `totalTokens = 2000000`，分子却是站内 AiChatHistory 聚合，两个数
  // 都不来自网关，所以和 NE 账户页永远对不上。现在：
  //   剩余 = remaining；总额度 = total_income；已用 = total_expense + total_write_off
  // （不能用 income - expense 反推余额：抹零与冲正负债会让它偏）
  const usedTokens = userData?.tokens || cachedUserDetail.tokens || 0
  const tokenTotal = llm?.totalIncome || 0
  const tokenUsed = llm ? llm.totalExpense + llm.totalWriteOff : 0
  const tokensPercentage =
    tokenTotal > 0
      ? Math.min(Math.round((tokenUsed / tokenTotal) * 100), 100)
      : 0

  // 没有 NE 账号时给用户看的说法。这个页面只对已登录用户渲染，
  // 所以这里绝不出现"未登录"三个字。
  const neUnavailableCopy = (reason: string) => {
    switch (reason) {
      case 'ne_not_linked':
        return {
          title: t('usage_ne_not_linked_title'),
          detail: t('usage_ne_not_linked_detail'),
        }
      case 'reauth_required':
        return {
          title: t('usage_ne_reauth_required_title'),
          detail: t('usage_ne_reauth_required_detail'),
        }
      // FIXED: 2026-10-27 会话到期不再复用 reauth_required：
      // 这是时间到了，不是凭据被拒，说清楚原因用户才不会觉得"我明明登录了"。
      case 'ne_session_expired':
        return {
          title: t('usage_ne_session_expired_title'),
          detail: t('usage_ne_session_expired_detail'),
        }
      case 'ne_credential_rejected':
        return {
          title: t('usage_ne_credential_rejected_title'),
          detail: t('usage_ne_credential_rejected_detail'),
        }
      case 'token_store_unavailable':
        return {
          title: t('usage_ne_token_store_title'),
          detail: t('usage_ne_token_store_detail'),
        }
      case 'not_logged_in':
        return {
          title: t('usage_ne_not_logged_in_title'),
          detail: t('usage_ne_not_logged_in_detail'),
        }
      default:
        return {
          title: t('usage_ne_unavailable_title'),
          detail: t('usage_ne_unavailable_detail'),
        }
    }
  }

  // 一键重新连接：浏览器顶层跳转，服务端走授权码流程（与 CARSI 共用回调）。
  // 之所以要有它：第 31 天必然出现"人登着、NE 会话到期"，纯服务端变不出新会话，
  // 必须让用户在 NE 那里点一次；这里把"点一次"压缩成点一个链接。
  const relinkHref = () => {
    const target =
      typeof window !== 'undefined'
        ? window.location.pathname
        : '/user/settings'
    return `/ne-relink?return=${encodeURIComponent(target)}`
  }

  const needsRelink = [
    'ne_not_linked',
    'reauth_required',
    'ne_session_expired',
  ].includes(llmUnavailable?.reason ?? '')

  // 站内账本余额（海外站）：金额单位是货币单位（元/美元），不是微单位
  const fetchCredit = async () => {
    try {
      const [ledgerRes, usageRes] = await Promise.all([
        fetch('/api/billing/ledger?limit=1', {
          headers: { Accept: 'application/json' },
        }),
        fetch('/api/llm/usage', { headers: { Accept: 'application/json' } }),
      ])
      const ledger = await ledgerRes.json()
      const usage = usageRes.ok ? (await usageRes.json()).usage : null
      setCredit({
        balance: typeof ledger.balance === 'number' ? ledger.balance : 0,
        currency: ledger.currency || exposed?.billing?.currency || 'CNY',
        todayTokens: usage?.totalTokens ?? null,
        todayCalls: usage?.calls ?? null,
        // 上游可能返回 null/缺字段：统一成数组，渲染处就不用再判空
        byModel: Array.isArray(usage?.byModel) ? usage.byModel : [],
      })
    } catch {
      // 读不到就保持 null，卡片显示「—」，不影响页面其余部分
    }
  }

  // 网关额度：同源 cookie 认证，失败只降级不报错
  const fetchLlmQuota = async () => {
    try {
      const [balanceRes, usageRes] = await Promise.all([
        fetch('/api/llm/balance', { headers: { Accept: 'application/json' } }),
        fetch('/api/llm/usage', { headers: { Accept: 'application/json' } }),
      ])
      if (!balanceRes.ok) return
      const balanceBody = await balanceRes.json()
      const balance = balanceBody.balance
      const usage = usageRes.ok ? (await usageRes.json()).usage : null
      // FIXED: 2026-10-27 无论额度能不能读，都记下 NE 连接的剩余天数
      setLlmLink(balanceBody.link ?? null)
      if (!balance) {
        // 额度不可用不是错误页：告诉用户原因，同时把能给的数字给足
        setLlmUnavailable({
          reason:
            typeof balanceBody.reason === 'string'
              ? balanceBody.reason
              : 'unavailable',
          identifiers: balanceBody.diagnostics?.identifiers ?? [],
          gatewayStatus: balanceBody.diagnostics?.gatewayStatus ?? null,
          todayTokens: usage?.totalTokens ?? null,
          todayCalls: usage?.calls ?? null,
          bySource: usage?.bySource ?? null,
        })
        return
      }
      setLlm({
        remaining: balance.remaining,
        totalIncome: balance.totalIncome,
        totalExpense: balance.totalExpense,
        totalWriteOff: balance.totalWriteOff,
        updatedAt: balance.updatedAt,
        todayTokens: usage?.totalTokens ?? null,
        todayCalls: usage?.calls ?? null,
        bySource: usage?.bySource ?? null,
      })
    } catch {
      // 网关不可达、或返回非 JSON（例如登录重定向的 HTML）：
      // 保持 llm 为 null，页面自动回退到站内历史用量
    }
  }

  // 页面加载时自动获取实时数据
  useEffect(() => {
    // FIXED: 2026-10-27 从 /ne-relink 授权回来时带一个结果参数，
    // 说明白到底成功了没有（否则用户只能看额度有没有出现来猜）。
    const params = new URLSearchParams(window.location.search)
    const result = params.get('ne-link')
    if (result) {
      setRelinkResult(result)
      params.delete('ne-link')
      const query = params.toString()
      window.history.replaceState(
        {},
        '',
        window.location.pathname + (query ? `?${query}` : '')
      )
    }

    const loadRealTimeData = async () => {
      // 海外站只读本地账本；国内站仍然读 NE 网关
      await Promise.all([
        fetchRealtimeUsage(),
        ledgerMode ? fetchCredit() : fetchLlmQuota(),
      ])
    }

    loadRealTimeData()
  }, [])

  useEffect(() => {
    if (pieChartRef.current) {
      const ctx = pieChartRef.current.getContext('2d')
      if (ctx) {
        // 销毁之前的图表实例
        if (chartInstance.current) {
          chartInstance.current.destroy()
        }

        // 创建饼图：按构成画（文字 / 附件 / 剩余）。
        // 原来是"已用 vs 可用"两段，占用率 0.14% 时整块是灰的，
        // 看上去像是统计没跑；按构成画才有信息量。
        const config: ChartConfiguration<'pie', number[], string> = {
          type: 'pie',
          data: {
            labels: [
              t('usage_label_text'),
              t('usage_label_files'),
              t('usage_label_remaining'),
            ],
            datasets: [
              {
                data: [pieUsage.text, pieUsage.files, pieUsage.free],
                backgroundColor: [
                  'rgba(54, 162, 235, 0.8)',
                  'rgba(255, 159, 64, 0.8)',
                  'rgba(211, 211, 211, 0.3)',
                ],
                borderColor: [
                  'rgba(54, 162, 235, 1)',
                  'rgba(255, 159, 64, 1)',
                  'rgba(211, 211, 211, 1)',
                ],
                borderWidth: 1,
              },
            ],
          },
          options: {
            responsive: true,
            plugins: {
              legend: {
                position: 'bottom',
              },
              title: {
                display: true,
                text: t('disk_usage_statistics'),
              },
            },
          },
        }
        chartInstance.current = new Chart(ctx, config)
      }
    }

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy()
      }
    }
  }, [pieUsage.text, pieUsage.files, pieUsage.free])

  // 格式化字节为可读的字符串
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  // 格式化更新时间
  const formatUpdateTime = (timestamp: string | undefined): string => {
    if (!timestamp) return ''
    try {
      const date = new Date(timestamp)
      return date.toLocaleTimeString()
    } catch {
      return ''
    }
  }

  const aiLabel = ledgerMode
    ? t('usage_quota_llm')
    : llm
    ? t('usage_quota_ne')
    : t('usage_ai_usage')
  const creditSymbol =
    credit?.currency === 'USD' ? '$' : credit?.currency === 'SGD' ? 'S$' : '¥'
  const aiReason = neUnavailableCopy(llmUnavailable?.reason ?? 'unavailable')

  return (
    <div className="settings-section fl-usage">
      <VipPreviewBanner preview={preview} />
      <div className="fl-usage__head">
        <h3 className="fl-usage__title">{t('usage_statistics')}</h3>
        <div className="fl-usage__head-right">
          {usageData?.updatedAt ? (
            <span className="fl-usage__meta">
              {useRealtime
                ? t('usage_updated_realtime')
                : t('usage_updated_cached')}
              {formatUpdateTime(usageData.updatedAt)}
              {useRealtime
                ? t('usage_suffix_realtime')
                : t('usage_suffix_cached')}
            </span>
          ) : null}
          <button
            type="button"
            className={`fl-usage__button${
              useRealtime ? ' fl-usage__button--saved' : ''
            }`}
            onClick={fetchRealtimeUsage}
            disabled={isLoading}
            title={
              useRealtime
                ? t('usage_save_title_saved')
                : t('usage_save_title_refresh')
            }
          >
            {isLoading
              ? t('usage_calculating')
              : useRealtime
              ? t('usage_saved')
              : t('usage_refresh')}
          </button>
        </div>
      </div>

      {(isVip || isVipExpired) && (
        <div className="fl-usage__status">
          <span
            className={`fl-usage__badge${
              isVip ? '' : ' fl-usage__badge--expired'
            }`}
          >
            {isVip ? 'VIP' : t('usage_vip_expired')}
          </span>
          <span className="fl-usage__note">
            {isVip ? (
              <>
                {vipEndDate
                  ? t('usage_vip_valid_until', {
                      date: new Date(vipEndDate).toLocaleDateString(
                        i18n.language
                      ),
                    })
                  : t('usage_vip_active')}
                {vipEndDate &&
                typeof vipDaysRemaining === 'number' &&
                vipDaysRemaining >= 0
                  ? t('usage_vip_days_left', { days: vipDaysRemaining })
                  : ''}
                {/* FIXED: 2026-11-15 不到 20 天就提醒续费，链接放句末，不打断原句 */}
                {typeof vipDaysRemaining === 'number' &&
                  vipDaysRemaining >= 0 &&
                  vipDaysRemaining < 20 && (
                    <>
                      {' '}
                      <a
                        className="fl-usage__renew"
                        href={renewHref}
                        {...renewLinkProps}
                      >
                        {t('usage_vip_renew_soon')}
                      </a>
                    </>
                  )}
              </>
            ) : (
              <>
                {vipEndDate
                  ? t('usage_vip_expired_at', {
                      date: new Date(vipEndDate).toLocaleDateString(
                        i18n.language
                      ),
                    })
                  : ''}
                {t('usage_vip_compile_restored')}
              </>
            )}
          </span>
        </div>
      )}

      {error && <div className="fl-usage__alert">{error}</div>}

      {/* FIXED: 2026-10-27 重新连接的结果必须说出来，不能靠猜 */}
      {relinkResult === 'ok' && (
        <div className="fl-usage__notice">{t('usage_relink_ok')}</div>
      )}
      {relinkResult === 'account_mismatch' && (
        <div className="fl-usage__alert">{t('usage_relink_mismatch')}</div>
      )}
      {(relinkResult === 'failed' || relinkResult === 'unavailable') && (
        <div className="fl-usage__alert">
          {t('usage_relink_failed', {
            reason:
              relinkResult === 'unavailable'
                ? t('usage_relink_reason_unavailable')
                : t('usage_relink_reason_no_auth'),
          })}
        </div>
      )}

      {/* 配额：每个数字一张卡，窄屏自动堆叠 */}
      <div className="fl-usage__cards">
        <div className="fl-usage__card">
          <div className="fl-usage__label">{t('usage_compile_time')}</div>
          <div className="fl-usage__value">
            {t('usage_minutes', { count: compileTimeoutMinutes })}
          </div>
          <div className="fl-usage__sub">
            {compileTimeoutMinutes >= 10
              ? t('usage_plan_pro')
              : t('usage_plan_standard')}
            {Number.isFinite(compileTimeout) && compileTimeout < 300
              ? t('usage_only_seconds', { seconds: compileTimeout })
              : ''}
          </div>
        </div>
        <div className="fl-usage__card">
          <div className="fl-usage__label">{t('usage_collaborators')}</div>
          <div className="fl-usage__value">
            {collaborators === -1 ? t('usage_unlimited_short') : collaborators}
          </div>
          <div className="fl-usage__sub">
            {collaborators === -1
              ? t('usage_unlimited')
              : t('usage_collaborator_count')}
          </div>
        </div>
        <div className="fl-usage__card">
          <div className="fl-usage__label">{t('usage_disk_usage')}</div>
          <div className="fl-usage__value">
            {formatBytes(usedSpaceBytes)}
            <span className="fl-usage__sub">
              {' '}
              / {formatBytes(totalSpaceBytes)}
            </span>
          </div>
          <div className="fl-usage__bar">
            <span style={{ width: `${Math.max(usedPercentage, 1)}%` }} />
          </div>
          <div className="fl-usage__sub">
            {t('usage_used_percent', { percent: usedPercentage })}
            {textSizeBytes != null && fileSizeBytes != null
              ? ` · ${t('usage_breakdown', {
                  text: formatBytes(textSizeBytes),
                  files: formatBytes(fileSizeBytes),
                })}`
              : ''}
          </div>
        </div>
      </div>

      <div className="fl-usage__split">
        {/* AI 额度：有 NE 账号才有余额，没有就说清楚为什么没有 */}
        <div className="fl-usage__card">
          <div className="fl-usage__label">{aiLabel}</div>
          {ledgerMode ? (
            <>
              <div className="fl-usage__value fl-usage__value--accent">
                {credit ? `${creditSymbol}${credit.balance.toFixed(2)}` : '—'}
              </div>
              <div className="fl-usage__sub">
                {credit?.todayTokens != null
                  ? t('usage_today_tokens', {
                      tokens: credit.todayTokens.toLocaleString(),
                    })
                  : t('usage_today_no_calls')}
                {credit?.todayCalls != null
                  ? ` · ${t('usage_calls', { count: credit.todayCalls })}`
                  : ''}
              </div>
              <div className="fl-usage__note">{t('usage_ledger_note')}</div>
              {/* 今日按模型：只列前三（按 token 降序，后端已排好），
                  更多去「用量明细」看；没有记录时整块不渲染，不给空表 */}
              {credit?.byModel?.length ? (
                <div className="fl-usage__note">
                  <div>{t('usage_by_model_heading')}</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: '16px' }}>
                    {credit.byModel.slice(0, 3).map(row => (
                      <li key={`${row.source}:${row.model}`}>
                        {t('usage_by_model_line', {
                          model: row.model || '—',
                          tokens: row.totalTokens.toLocaleString(),
                          calls: row.calls,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : llm ? (
            <>
              <div className="fl-usage__value fl-usage__value--accent">
                {llm.remaining.toLocaleString()}
              </div>
              <div className="fl-usage__sub">
                {t('usage_used_of_total', {
                  used: tokenUsed.toLocaleString(),
                  total: tokenTotal.toLocaleString(),
                })}
              </div>
              <div className="fl-usage__bar">
                <span style={{ width: `${tokensPercentage}%` }} />
              </div>
              <div className="fl-usage__sub">
                {t('usage_today_tokens', {
                  tokens:
                    llm.todayTokens !== null
                      ? llm.todayTokens.toLocaleString()
                      : t('usage_no_calls'),
                })}
                {llm.todayCalls !== null
                  ? ` · ${t('usage_calls', { count: llm.todayCalls })}`
                  : ''}
                {llm.bySource
                  ? ` ${t('usage_by_source', {
                      chat: llm.bySource['ft-ai']?.calls ?? 0,
                      whiteboard: llm.bySource.relay?.calls ?? 0,
                    })}`
                  : ''}
              </div>
              <div className="fl-usage__note">
                {llm.updatedAt
                  ? t('usage_from_ne_gateway_time', { time: llm.updatedAt })
                  : t('usage_from_ne_gateway')}
              </div>
              {/* FIXED: 2026-10-27 把到期日提到括号里来：sid 不会过期，
                  NE 会话会，所以只给余额不给期限就是等着第 31 天出事 */}
              {llmLink?.sessionExpiresAt ? (
                <div className="fl-usage__note">
                  {t('usage_ne_valid_until', {
                    date: new Date(llmLink.sessionExpiresAt).toLocaleDateString(
                      i18n.language
                    ),
                  })}
                  {typeof llmLink.daysLeft === 'number'
                    ? t('usage_days_left_short', { days: llmLink.daysLeft })
                    : ''}
                  {typeof llmLink.daysLeft === 'number' &&
                  llmLink.daysLeft <= 7 ? (
                    <>
                      {' · '}
                      <a className="fl-usage__link" href={relinkHref()}>
                        {t('usage_renew_now')}
                      </a>
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="fl-usage__value">
                {t('usage_today_tokens', {
                  tokens:
                    llmUnavailable?.todayTokens != null
                      ? llmUnavailable.todayTokens.toLocaleString()
                      : t('usage_no_calls'),
                })}
                {llmUnavailable?.todayCalls != null
                  ? ` · ${t('usage_calls', {
                      count: llmUnavailable.todayCalls,
                    })}`
                  : ''}
              </div>
              {llmUnavailable?.bySource ? (
                <div className="fl-usage__sub">
                  {t('usage_by_source_plain', {
                    chat: llmUnavailable.bySource['ft-ai']?.calls ?? 0,
                    whiteboard: llmUnavailable.bySource.relay?.calls ?? 0,
                  })}
                </div>
              ) : null}
              <div className="fl-usage__sub">
                {t('usage_ai_total_usage', {
                  tokens: usedTokens.toLocaleString(),
                })}
              </div>
              <div className="fl-usage__note">
                <strong>{aiReason.title}</strong>
                <br />
                {aiReason.detail}
              </div>
              {/* FIXED: 2026-10-27 如果 TokenCache 还记得截止时间，就把具体日期说出来。
                  "已过期"三个字无法核对；"已于 10 月 28 日 09:12 到期"能。 */}
              {llmLink &&
              llmLink.linked === false &&
              llmLink.sessionExpiresAt ? (
                <div className="fl-usage__note">
                  {t('usage_ne_expired_at', {
                    time: new Date(llmLink.sessionExpiresAt).toLocaleString(
                      i18n.language
                    ),
                  })}
                </div>
              ) : null}
              {/* FIXED: 2026-10-27 问题状态必须给一个可点的修修动作。
                  以前只说「用 NE 账号重新登录」，而用户看着自己的登录状态，
                  根本不知道还要做什么。 */}
              {needsRelink ? (
                <a
                  className="fl-usage__button fl-usage__button--cta"
                  href={relinkHref()}
                >
                  {t('usage_relink_cta')}
                </a>
              ) : null}
              <span className="fl-usage__diag">
                reason={llmUnavailable?.reason ?? 'unknown'}
                {llmUnavailable?.gatewayStatus != null
                  ? ` gateway=${llmUnavailable.gatewayStatus}`
                  : ''}
                {llmUnavailable?.identifiers?.length
                  ? ` id=${llmUnavailable.identifiers.join(',')}`
                  : ''}
              </span>
            </>
          )}
        </div>

        {/* 磁盘图 + 明细并排，宽屏两列、窄屏堆叠 */}
        <div className="fl-usage__card">
          <div className="fl-usage__label">{t('usage_disk_overview')}</div>
          <div className="fl-usage__chart">
            <canvas ref={pieChartRef} />
          </div>
        </div>
      </div>

      <div className="fl-usage__cards" style={{ marginTop: '12px' }}>
        <div className="fl-usage__card">
          <div className="fl-usage__label">{t('usage_account_login')}</div>
          <dl className="fl-usage__facts">
            <div>
              <dt>{t('latex_project_count')}</dt>
              <dd>
                {usageData?.projectCount ?? cachedUserDetail.projectCount}
              </dd>
            </div>
            <div>
              <dt>{t('document_count')}</dt>
              <dd>{usageData?.docCount ?? cachedUserDetail.documentCount}</dd>
            </div>
            <div>
              <dt>{t('last_login')}</dt>
              <dd>{cachedUserDetail.lastLogin}</dd>
            </div>
            <div>
              <dt>{t('last_login_ip')}</dt>
              <dd>{cachedUserDetail.lastLoginIp || t('unknown')}</dd>
            </div>
          </dl>
        </div>

        {/* 明细：总量是个数字，构成才回答"为什么是这个数字" */}
        <div className="fl-usage__card">
          <div className="fl-usage__label">{t('usage_disk_detail')}</div>
          <dl className="fl-usage__facts">
            <div>
              <dt>{t('usage_label_text_source')}</dt>
              <dd>
                {textSizeBytes != null ? formatBytes(textSizeBytes) : '—'}
              </dd>
            </div>
            <div>
              <dt>{t('usage_label_files')}</dt>
              <dd>
                {fileSizeBytes != null
                  ? `${formatBytes(fileSizeBytes)}${
                      fileCount != null
                        ? ` · ${t('usage_files_count', { count: fileCount })}`
                        : ''
                    }`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>{t('usage_label_total')}</dt>
              <dd>{formatBytes(usedSpaceBytes)}</dd>
            </div>
            {(usageData?.trashedProjectCount ?? 0) > 0 && (
              <div>
                <dt>{t('usage_label_trash')}</dt>
                <dd>
                  {t('usage_trash_summary', {
                    count: usageData?.trashedProjectCount,
                    size: formatBytes((usageData?.trashedSize ?? 0) || 0),
                  })}
                </dd>
              </div>
            )}
          </dl>
          <div className="fl-usage__note">{t('usage_disk_note')}</div>
          {(usageData?.fileSizeFailedCount ?? 0) > 0 && (
            <div className="fl-usage__note fl-usage__note--warn">
              {t('usage_disk_warn', { count: usageData?.fileSizeFailedCount })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default UsageSection
