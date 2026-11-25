// DesktopSync —— FlyLaTeX 桌面端项目同步接口的独立模块。
//
// FIXED: 2026-10-15 默认启用（v5.2）：无需配置即开。
// 如需关闭：环境变量 DESKTOP_SYNC_ENABLED=false。
// 关闭时：Router 不挂载、Key 集合不初始化、中间件不注册，零副作用。
const ENABLED = process.env.DESKTOP_SYNC_ENABLED !== 'false'

module.exports = {
  isEnabled: () => ENABLED,
  Router: require('./DesktopSyncRouter'),
}
