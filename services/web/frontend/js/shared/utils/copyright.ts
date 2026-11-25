import getMeta from '../../utils/meta'
import type { ExposedSettings } from '../../../../types/exposed-settings'

/**
 * 关于弹窗（编辑器 Help → About）里的版权行。
 *
 * FIXED: 2026-11-24 「© 年份 + 持有方」原来在 help-menu.tsx 和
 * toolbar-header.jsx 里各写死一份公司名。
 * 不同部署要显示不同主体 —— 但组件里**不判断部署档位**，只读
 * `Settings.copyrightHolder`（默认值来自 internal-values / COPYRIGHT_HOLDER）。
 *
 * 年份每次渲染取当前年，跨年不用改代码。
 */
const DEFAULT_COPYRIGHT_HOLDER = 'FlyLaTeX'

export function copyrightHolder(): string {
  const exposed = getMeta('ol-ExposedSettings') as ExposedSettings | undefined
  const holder = exposed?.copyrightHolder
  return typeof holder === 'string' && holder.trim()
    ? holder.trim()
    : DEFAULT_COPYRIGHT_HOLDER
}

export function copyrightLine(): string {
  return `© ${new Date().getFullYear()} ${copyrightHolder()}`
}
