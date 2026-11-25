// FIXED: 2026-11-10 拆分部署时，web 容器里那个 clsi 要能被关掉
//
// 现状是一个容器跑全部服务（web / clsi / filestore … 由 runit 各起一个进程）。
// 要拆成「web 容器 + clsi 容器」时，web 容器里那一份 clsi 就没用了：
// 它不接请求（web 的 Settings.apis.clsi.url 指向 clsi 容器），白占内存，还会
// 在启动时跑 StaleCompileReaper 去扫 /proc（和 clsi 容器的清道夫互相看不见，无害但多余）。
//
// 关掉的方式必须是「配置开关」，不能靠改镜像或删 runit 脚本 —— 那会让两个
// 部署模式不再共用同一个镜像，也就没法一键切回来。
//
// 两条等价入口：
//   CLSI_ENABLED=false                      （env，推荐：compose 里一行）
//   Settings.clsi.enabled = false           （settings.js）
// 默认（都不配）与现在完全一致：照常启动。
function isEnabled(env, settings) {
  const envValue = String((env && env.CLSI_ENABLED) || '')
    .trim()
    .toLowerCase()
  if (envValue === 'false' || envValue === '0' || envValue === 'off') {
    return false
  }
  if (settings && settings.clsi && settings.clsi.enabled === false) {
    return false
  }
  return true
}

module.exports = { isEnabled }
