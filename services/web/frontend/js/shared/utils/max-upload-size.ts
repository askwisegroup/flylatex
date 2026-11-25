import getMeta from '@/utils/meta'

// FIXED: 2026-11-15 普通用户单个文件 10MB，VIP 沿用服务端全局上限。
// 服务端已经按用户强制校验；前端这里只负责把选择器/提示的上限对齐，
// 避免用户选完 30MB 文件才在提交时被拒。
const NORMAL_MAX_FILE_SIZE = 10 * 1024 * 1024
const FALLBACK_MAX_FILE_SIZE = 50 * 1024 * 1024

export type UserWithVip = {
  vipStatus?: { isVip?: boolean }
  vipEndDate?: string | Date | null
  vipExpired?: boolean
}

export function isVipUser(user?: UserWithVip | null): boolean {
  if (!user) return false
  if (user.vipStatus?.isVip === true) return true
  if (!user.vipEndDate || user.vipExpired === true) return false
  return new Date(user.vipEndDate).getTime() > Date.now()
}

export function getMaxUploadSize(): number {
  const exposed =
    window.ExposedSettings?.maxUploadSize || FALLBACK_MAX_FILE_SIZE
  const user = getMeta('ol-user') as UserWithVip | undefined
  return isVipUser(user) ? exposed : Math.min(exposed, NORMAL_MAX_FILE_SIZE)
}
