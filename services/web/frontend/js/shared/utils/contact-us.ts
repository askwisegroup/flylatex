import getMeta from '../../utils/meta'

/**
 * 「帮助 - 联系我们」点下去要打开的地址。
 *
 * FIXED: 2026-11-01
 * 原来三处入口各写各的：新 IDE 菜单开 `/contact`（这个 fork 没有这条路由，
 * 点了跟没反应一样），老编辑器菜单写死 `mailto:support@example.com`，
 * 左侧面板走一个本 fork 里并不存在的 contactUsModal 模块（也是点了没反应）。
 * 现在统一到服务端配置 `contactUsUrl`（环境变量 CONTACT_US_URL）。
 *
 * 环境变量可以给：
 *   - http(s) 地址，例如 https://example.com/contact
 *   - mailto: 地址，例如 mailto:support@example.com?subject=问题咨询
 *   - tel: 电话
 * 没配的时候回落到下面的论坛地址（服务端 `config/settings.defaults.js` 里也有同一份默认值，
 * 这里只是 meta 缺失时的兜底）。
 */
export const FALLBACK_CONTACT_US_URL =
  ''

export function getContactUsUrl(): string {
  const url = getMeta('ol-contactUsUrl')
  return typeof url === 'string' && url.trim() ? url.trim() : FALLBACK_CONTACT_US_URL
}

/**
 * 打开「联系我们」。
 *
 * mailto: / tel: 这类协议如果走 window.open，浏览器会先开一个空白页再交给系统处理，
 * 还会被当成弹窗拦掉，所以直接用 location.href；普通链接按需求以 _blank 打开。
 */
export function openContactUs() {
  const url = getContactUsUrl()

  if (/^(mailto|tel):/i.test(url)) {
    window.location.href = url
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}
