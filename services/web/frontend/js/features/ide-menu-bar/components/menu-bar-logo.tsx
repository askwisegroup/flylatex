import { useCallback } from 'react'
import getMeta from '../../../utils/meta'
import * as eventTracking from '../../../infrastructure/event-tracking'

/**
 * FIXED: 2026-11-07 导航栏左侧第一个位置的产品 LOGO（云朵图标，同 /favicon.ico）
 *
 * 行为：点击回到 /project（项目列表）；和「文件 → 返回我的项目」是同一条路径，
 * 只是多了一个一眼能看到的入口。用 <a href="/project"> 而不是 JS 跳转，
 * 这样中键 / Cmd+点击还能按浏览器习惯新标签打开。
 *
 * 尺寸由 ide-menu-bar.less 的 .ide-menu-logo 固定（20x20 图标 + 菜单栏等高），
 * 不随窗口缩放变形，和左侧菜单项在同一基线上。
 */
function MenuBarLogo() {
  const baseAssetPath = getMeta('ol-baseAssetPath', '/') as string

  const handleClick = useCallback(() => {
    eventTracking.sendMB('navigation-clicked-logo')
  }, [])

  return (
    <a
      href="/project"
      className="ide-menu-logo"
      title="FlyLaTeX"
      aria-label="FlyLaTeX"
      onClick={handleClick}
    >
      <img
        src={`${baseAssetPath}favicon.ico`}
        alt="FlyLaTeX"
        className="ide-menu-logo-img"
        width={20}
        height={20}
      />
    </a>
  )
}

export default MenuBarLogo
