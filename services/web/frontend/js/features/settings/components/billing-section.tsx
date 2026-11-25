import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import getMeta from '../../../utils/meta'
import { ExposedSettings } from '../../../../../types/exposed-settings'

/**
 * 设置页「账户充值 / 充值记录」。
 *
 * FIXED: 2026-11-12 交互改成「先弹窗确认，再下单」。
 *   之前点一下 50/100 这种按钮就等价于「选定金额」，再点「去支付」直接跳收银台，
 *   用户根本分不清「选金额」和「付钱」是两步，也不知道自己选了哪一档 ——
 *   等于一点就扣钱。现在的路径是：
 *     点「充值」→ 弹窗里选金额 → 点「确认支付」→ 才创建订单并跳转。
 *
 * 与会员套餐（membership-section.tsx）是两件事：
 *   这里的钱只用于 LLM 调用额度，按 token 扣减；会员卖的是能力（编译时长/VIP）。
 *
 * FIXED: 2026-11-24 全部文案走 i18n（key 前缀 billing_ / settings_billing_）。
 *   之前是写死的中文，en / es / fr / ja / pt / ru / zh-TW 界面上都显示中文。
 *   新增文案时**不要**再往这个文件里写中文 —— 加 key 到 locales/en.json 与
 *   locales/zh-CN.json，再跑 scripts/i18n-llm/translate.js 补其它语言。
 *
 * 记录分页：一页 10 条，翻页走 /api/billing/ledger?page=N。
 */

const PAGE_SIZE = 10
const AMOUNT_OPTIONS = [50, 100, 200, 500, 1000]
// 自定义金额区间：与后端 BillingController.MIN_TOPUP/MAX_TOPUP 保持一致
const MIN_TOPUP = 5
const MAX_TOPUP = 100000

interface LedgerEntry {
  id: string
  kind: string
  amount: number
  balanceAfter: number | null
  at: string
  note?: string | null
  model?: string | null
}

interface LedgerResponse {
  ok: boolean
  enabled: boolean
  currency: string
  balance: number | null
  entries: LedgerEntry[]
  page?: number
  pageSize?: number
  total?: number
  totalPages?: number
  reason?: string
}

const KIND_LABEL_KEYS: Record<string, string> = {
  grant: 'billing_kind_grant',
  topup: 'billing_kind_topup',
  charge: 'billing_kind_charge',
  refund: 'billing_kind_refund',
  adjust: 'billing_kind_adjust',
}

function formatAmount(value: number, currency: string, digits = 2) {
  const symbol =
    currency === 'USD' ? '$' : currency === 'SGD' ? 'S$' : currency === 'EUR' ? '€' : '¥'
  return `${symbol}${value.toFixed(digits)}`
}

function BillingSection() {
  const { t, i18n } = useTranslation()
  const settings = getMeta('ol-ExposedSettings') as ExposedSettings
  const billing = settings?.billing
  const topupUrl = billing?.topupUrl || null
  const topupAvailable = Boolean(billing?.topupAvailable)
  // 币种要在「自定义金额校验」之前定下来：校验文案里要显示 ¥/$ 符号。
  // （先用在 165 行、再 const 声明在下面会直接 TDZ 报错，别调换顺序）
  const currency = billing?.currency || 'CNY'

  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [data, setData] = useState<LedgerResponse | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)

  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [amount, setAmount] = useState(100)
  // 自定义金额：空字符串表示「没在自定义」，否则用它校验
  const [customValue, setCustomValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const loadPage = useCallback(
    async (targetPage: number) => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await fetch(
          `/api/billing/ledger?page=${targetPage}&limit=${PAGE_SIZE}`,
          { headers: { Accept: 'application/json' } }
        )
        const body: LedgerResponse = await response.json()
        setData(body)
        setPage(body.page ?? targetPage)
      } catch {
        setError(t('billing_err_load'))
      } finally {
        setIsLoading(false)
      }
    },
    [t]
  )

  const openDialog = () => {
    setDialogError(null)
    setDialogOpen(true)
  }

  // 自定义金额校验：不能为空、不能是负数/非数字、下限 5、上限 100000
  const customParsed = Number(customValue)
  const customError =
    customValue.trim() === ''
      ? null
      : !Number.isFinite(customParsed)
      ? t('billing_err_not_number')
      : customParsed <= 0
      ? t('billing_err_positive')
      : customParsed < MIN_TOPUP
      ? t('billing_err_min', { amount: formatAmount(MIN_TOPUP, currency, 0) })
      : customParsed > MAX_TOPUP
      ? t('billing_err_max', { amount: formatAmount(MAX_TOPUP, currency, 0) })
      : null
  const customValid = customValue.trim() !== '' && !customError
  // 生效金额：自定义合法就用自定义，否则用选中的快捷档
  const effectiveAmount = customValid ? customParsed : amount
  const canConfirm = !customError && effectiveAmount >= MIN_TOPUP && effectiveAmount <= MAX_TOPUP

  /** 确认后才创建订单：金额来自弹窗里选中的值，区间由后端再校验一次。 */
  const confirmTopup = async () => {
    setBusy(true)
    setDialogError(null)
    try {
      const response = await fetch('/billing/topup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Csrf-Token': (window as any).csrfToken,
        },
        body: JSON.stringify({ amount: effectiveAmount }),
      })
      const body = await response.json()
      if (!body.ok || !body.checkoutUrl) {
        setDialogError(
          body.reason === 'unsupported_amount'
            ? t('billing_err_unsupported')
            : t('billing_err_create')
        )
        return
      }
      window.location.href = body.checkoutUrl
    } catch {
      setDialogError(t('billing_err_network'))
    } finally {
      setBusy(false)
    }
  }

  const toggleRecords = () => {
    if (isOpen) {
      setIsOpen(false)
      return
    }
    setIsOpen(true)
    if (!data) loadPage(1)
  }

  const entries = data?.entries ?? []
  // 流水里的币种以接口返回为准（历史记录可能跨币种）
  const listCurrency = data?.currency || currency
  const totalPages = data?.totalPages ?? 1
  const balance = data?.balance
  // 时间/金额按当前界面语言排版，不再固定 zh-CN
  const locale = i18n.language || 'en'

  return (
    <div className="settings-section">
      <h3>{t('billing_title')}</h3>
      <p className="text-muted small">{t('billing_lead')}</p>

      {/* FIXED: 2026-11-15 本区块是 LLM 额度充值，不是会员充值；
          顺带交代 VIP 与免费版的权益差异，具体数字与 UserVip.js 保持一致。 */}
      <div className="text-muted small" style={{ marginBottom: 10 }}>
        <strong>{t('billing_vip_benefits_title')}</strong>
        <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
          <li>{t('billing_vip_benefit_1')}</li>
          <li>{t('billing_vip_benefit_2')}</li>
          <li>{t('billing_vip_benefit_3')}</li>
          <li>{t('billing_vip_benefit_4')}</li>
          <li>{t('billing_vip_benefit_5')}</li>
        </ul>
      </div>

      {balance != null && (
        <p className="text-muted small">
          {t('billing_balance', { amount: formatAmount(balance, currency) })}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {topupUrl ? (
          <a
            className="btn btn-primary"
            href={topupUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('billing_topup_cta')}
          </a>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={openDialog}
            disabled={!topupAvailable}
          >
            {t('billing_topup_cta')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-default"
          onClick={toggleRecords}
          aria-expanded={isOpen}
        >
          {isOpen ? t('billing_records_hide') : t('billing_records_show')}
        </button>
      </div>

      {/* ---------- 充值弹窗：先确认金额，再下单 ---------- */}
      {dialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('billing_dialog_aria')}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 3000,
          }}
          onClick={event => {
            if (event.target === event.currentTarget && !busy) setDialogOpen(false)
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 14,
              padding: '24px 26px',
              width: 'min(460px, 92vw)',
              boxShadow: '0 24px 60px rgba(0,0,0,.24)',
            }}
          >
            <h4 style={{ margin: '0 0 6px', fontSize: 18 }}>
              {t('billing_dialog_title')}
            </h4>
            <p className="text-muted small" style={{ marginTop: 0 }}>
              {t('billing_dialog_lead')}
            </p>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
                margin: '14px 0 6px',
              }}
            >
              {AMOUNT_OPTIONS.map(option => {
                const selected = !customValid && option === amount
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setCustomValue('')
                      setAmount(option)
                    }}
                    disabled={busy}
                    style={{
                      padding: '14px 8px',
                      borderRadius: 10,
                      cursor: 'pointer',
                      textAlign: 'center',
                      fontSize: 15,
                      fontWeight: selected ? 700 : 500,
                      border: selected
                        ? '2px solid #0b6bcb'
                        : '1px solid rgba(0,0,0,.16)',
                      background: selected ? 'rgba(11,107,203,.08)' : '#fff',
                      color: '#1f2937',
                    }}
                  >
                    {formatAmount(option, currency, 0)}
                  </button>
                )
              })}
              {/* 自定义金额：直接输入，区间 5 ~ 100000 */}
              <input
                type="number"
                inputMode="decimal"
                min={MIN_TOPUP}
                max={MAX_TOPUP}
                step="1"
                value={customValue}
                onChange={event => {
                  const next = event.target.value
                  setCustomValue(next)
                  const parsed = Number(next)
                  if (next.trim() !== '' && Number.isFinite(parsed) && parsed >= MIN_TOPUP && parsed <= MAX_TOPUP) {
                    setAmount(parsed)
                  }
                }}
                placeholder={t('billing_custom_placeholder')}
                aria-label={t('billing_custom_aria')}
                disabled={busy}
                style={{
                  padding: '14px 8px',
                  borderRadius: 10,
                  textAlign: 'center',
                  fontSize: 15,
                  fontWeight: customValid ? 700 : 500,
                  border: customValid
                    ? '2px solid #0b6bcb'
                    : '1px solid rgba(0,0,0,.16)',
                  background: customValid ? 'rgba(11,107,203,.08)' : '#fff',
                  color: '#1f2937',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <p className="text-muted small" style={{ marginTop: 0 }}>
              {t('billing_custom_range', {
                min: formatAmount(MIN_TOPUP, currency, 0),
                max: formatAmount(MAX_TOPUP, currency, 0),
              })}
            </p>
            {customError && (
              <p className="text-danger small" role="alert">
                {customError}
              </p>
            )}

            {dialogError && (
              <p className="text-danger small" role="alert">
                {dialogError}
              </p>
            )}

            <p className="text-muted small">
              {t('billing_confirm_summary', {
                amount: formatAmount(effectiveAmount, currency, 2),
              })}
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn btn-default"
                onClick={() => setDialogOpen(false)}
                disabled={busy}
              >
                {t('billing_cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={confirmTopup}
                disabled={busy || !canConfirm}
              >
                {busy
                  ? t('billing_redirecting')
                  : t('billing_confirm_pay', {
                      amount: formatAmount(effectiveAmount, currency, 2),
                    })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 充值记录（分页，一页 10 条） ---------- */}
      {isOpen && (
        <div style={{ marginTop: 12 }}>
          {isLoading && (
            <p className="text-muted small">{t('billing_loading_records')}</p>
          )}
          {!isLoading && error && (
            <p className="text-danger small" role="alert">
              {error}
            </p>
          )}
          {!isLoading && !error && data && (
            <>
              {entries.length === 0 ? (
                <p className="text-muted small">
                  {t('billing_empty')}
                  {!data.enabled && ` ${t('billing_empty_ledger_disabled')}`}
                </p>
              ) : (
                <>
                  <table className="table table-condensed">
                    <thead>
                      <tr>
                        <th>{t('billing_col_time')}</th>
                        <th>{t('billing_col_kind')}</th>
                        <th style={{ textAlign: 'right' }}>{t('billing_col_amount')}</th>
                        <th style={{ textAlign: 'right' }}>{t('billing_col_balance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map(entry => (
                        <tr key={entry.id}>
                          <td>{new Date(entry.at).toLocaleString(locale)}</td>
                          <td>
                            {KIND_LABEL_KEYS[entry.kind]
                              ? t(KIND_LABEL_KEYS[entry.kind])
                              : entry.kind}
                            {entry.model ? (
                              <span className="text-muted small"> · {entry.model}</span>
                            ) : null}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {entry.amount > 0 ? '+' : ''}
                            {formatAmount(entry.amount, listCurrency, entry.amount === 0 ? 2 : 4)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {entry.balanceAfter != null
                              ? formatAmount(entry.balanceAfter, listCurrency)
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      justifyContent: 'flex-end',
                    }}
                  >
                    <span className="text-muted small">
                      {t('billing_page_info', {
                        page,
                        totalPages,
                        total: data.total ?? entries.length,
                      })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      onClick={() => loadPage(page - 1)}
                      disabled={page <= 1 || isLoading}
                    >
                      {t('billing_prev')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      onClick={() => loadPage(page + 1)}
                      disabled={page >= totalPages || isLoading}
                    >
                      {t('billing_next')}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default BillingSection
