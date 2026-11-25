import { useTranslation } from 'react-i18next'
import getMeta from '../../../utils/meta'
// FIXED: 2026-11-15 【临时】与 UsageSection 共用同一套 ?vipPreview 覆盖
import { resolveVipPreview } from './vip-preview'

// FIXED: 2026-11-15 设置页「升级为 VIP」引导（仅 cn / master 使用）。
//
// 需求：/user/settings 里没有 VIP 徽标的普通用户，要有一个人能看懂的入口 ——
// 一个跳到 NE 用户中心下单页的外链，外加一张「普通用户 vs VIP」的对比表，
// 让人知道差在哪、为什么要升。
//
// 刻意**不**做成套餐卡片（月付/季付/年付 + 价格 + 当前计划按钮那种）：
//   1. 那套 UI 属于海外站的站内充值（sg 的 Billing/membership 组件），
//      国内站走的是 NE 用户中心下单，价格和周期都不在本站，抄个价格表会立刻对不上；
//   2. 这里只需要「说明 + 一个出口」，用设置页现有的 settings-section + 表格即可，
//      和其它区块视觉一致。
//
// 数据来源：ol-user.vipStatus（UserVip.getVipStatus 写入）；限额口径与
// UsageSection / UserVip.FALLBACK_*_LIMITS / Settings.compileTimeouts 保持一致，
// 不另造一套数字。
export const VIP_ORDER_URL = ''

type Row = { label: string; normal: string; vip: string }

// FIXED: 2026-11-20 这张对比表原来整块是写死的中文，切语言时纹丝不动。
// 现在每一行都走 i18n（key 前缀 vip_cmp_<row>_label/_normal/_vip）。
const ROW_IDS = [
  'projects',
  'collaborators',
  'storage',
  'file_size',
  'compile_time',
  'ai_compile',
  'mcp_services',
  'mcp_config',
  'vip_badge',
  'support',
] as const

export default function VipUpsellSection() {
  const { t } = useTranslation()
  const rows: Row[] = ROW_IDS.map(id => ({
    label: t(`vip_cmp_${id}_label`),
    normal: t(`vip_cmp_${id}_normal`),
    vip: t(`vip_cmp_${id}_vip`),
  }))
  const user = getMeta('ol-user') || {}
  const { isVip, isExpired } = resolveVipPreview(user)
  // FIXED: 2026-11-15 sg 有站内充值（ExposedSettings.billing.enabled）时不显示这个外链，
  // 否则以后把 master 合进 sg 会出现「两套充值入口」。cn 没有 billing 字段，照常显示。
  const exposedSettings = getMeta('ol-ExposedSettings') || {}
  const hasInSiteBilling = exposedSettings.billing?.enabled === true

  if (isVip || hasInSiteBilling) {
    return null
  }

  return (
    <div className="settings-section vip-upsell">
      <h3>
        {isExpired ? t('vip_upsell_title_expired') : t('vip_upsell_title')}
      </h3>

      <p className="text-muted vip-upsell__lead">{t('vip_upsell_lead')}</p>

      <table className="table table-condensed vip-upsell__table">
        <thead>
          <tr>
            <th>{t('vip_upsell_col_benefit')}</th>
            <th>{t('vip_upsell_col_normal')}</th>
            <th>
              VIP
              <span className="vip-upsell__tag">
                {t('vip_upsell_badge_recommended')}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="text-muted">{row.normal}</td>
              <td className="vip-upsell__vip">{row.vip}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        <a
          className="btn btn-primary btn-sm"
          href={VIP_ORDER_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {isExpired ? t('vip_upsell_cta_renew') : t('vip_upsell_cta')}
        </a>{' '}
        <small className="text-muted">{t('vip_upsell_order_note')}</small>
      </p>
    </div>
  )
}
