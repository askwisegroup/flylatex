// FIXED: 2026-11-15 【临时调试开关 —— 整个文件可以整体删除】
//
// 需求：测试阶段所有账号都是 VIP，没法在设置页看到「普通用户」长什么样。
// 这里给一个**只在浏览器地址栏**生效的预览开关：
//
//   /user/settings?vipPreview=normal              普通用户：无 VIP 徽标 + 显示升级区块
//   /user/settings?vipPreview=soon                还剩 14 天的续费提醒
//   /user/settings?vipPreview=soon&vipPreviewDays=3   还剩 3 天（可以任意改）
//   /user/settings?vipPreview=expired             VIP 已过期
//
// 边界（重要）：
//   - 只改**前端展示**用的判定，不改服务端真实限额。别人猜到这个参数也只能看，
//     看不到任何别人数据，也拿不到任何权限。
//   - 只作用于 /user/settings 这一页的两个组件；不带参数时行为与改动前完全一致。
//   - 预览生效时页面顶部会有一条明显的「预览模式」提示，避免被误当成真实状态。
//
// 撤掉的方法：删掉本文件，并把 UsageSection.tsx / vip-upsell-section.tsx 里
// `resolveVipPreview(...)` 那一行换回读 user.vipStatus 的三行即可。

export interface VipPreviewState {
  /** 预览是否生效（地址栏带了合法参数） */
  active: boolean
  /** 顶部提示文案，active 为 false 时是空串 */
  label: string
  isVip: boolean
  isExpired: boolean
  vipEndDate: Date | string | null
  daysRemaining: number | null
  /** null 表示「用真实 features.compileTimeout」 */
  compileTimeout: number | null
}

const DEFAULT_SOON_DAYS = 14

function readParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name)
  } catch (e) {
    return null
  }
}

export function resolveVipPreview(user: any): VipPreviewState {
  const vipStatus = user?.vipStatus || {}
  const real: VipPreviewState = {
    active: false,
    label: '',
    isVip: vipStatus.isVip === true,
    isExpired: vipStatus.isExpired === true,
    vipEndDate: vipStatus.vipEndDate ?? null,
    daysRemaining:
      typeof vipStatus.daysRemaining === 'number'
        ? vipStatus.daysRemaining
        : null,
    compileTimeout: null,
  }

  const mode = readParam('vipPreview')
  if (!mode) {
    return real
  }

  const addDays = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

  if (mode === 'normal') {
    return {
      ...real,
      active: true,
      label: '普通用户（非 VIP）',
      isVip: false,
      isExpired: false,
      vipEndDate: null,
      daysRemaining: null,
      // 普通用户的编译时长是标准版 5 分钟，别把 VIP 的 600 秒显示出来
      compileTimeout: 300,
    }
  }

  if (mode === 'expired') {
    return {
      ...real,
      active: true,
      label: 'VIP 已过期',
      isVip: false,
      isExpired: true,
      vipEndDate: real.vipEndDate || addDays(-1),
      daysRemaining: null,
      compileTimeout: 300,
    }
  }

  if (mode === 'soon') {
    const raw = Number(readParam('vipPreviewDays'))
    const days =
      Number.isFinite(raw) && raw >= 0 && raw < 20 ? raw : DEFAULT_SOON_DAYS
    return {
      ...real,
      active: true,
      label: `VIP 还剩 ${days} 天`,
      isVip: true,
      isExpired: false,
      vipEndDate: addDays(days),
      daysRemaining: days,
    }
  }

  // 认不出的值就当没写，避免把线上正常状态弄坏
  return real
}

export function VipPreviewBanner({ preview }: { preview: VipPreviewState }) {
  if (!preview.active) {
    return null
  }
  return (
    <div className="fl-usage__preview">
      预览模式：<strong>{preview.label}</strong>
      —— 仅本 URL 生效，只改页面显示，不影响真实额度与他人。去掉地址栏参数即可恢复。
    </div>
  )
}
