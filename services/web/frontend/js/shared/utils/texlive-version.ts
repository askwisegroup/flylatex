// FIXED: 2026-11-05 About System 的 TeX Live 版本号不再写死在代码里
//
// 后端 GET /system/texlive-version 会跑一次 `tlmgr --version`（结果在服务端
// 缓存 10 分钟），这里只负责取回来 + 缓存到页面生命周期内，避免每次开弹窗
// 都发请求。探测失败时返回 null，调用方退回到不带年份的 `TeXLive`。
//
// 注意：响应体是 `available` / `version` / `raw`。`raw` 是后端**已脱敏**的
// `tlmgr --version` 输出（去掉了 `tlmgr using installation: /usr/local/texlive/2023`
// 这类安装树信息），只用来做悬停提示，不要在页面上直接渲染。
import { getJSON } from '../../infrastructure/fetch-json'

export type TeXLiveVersionInfo = {
  available: boolean
  version: string | null
  raw: string | null
}

let cached: Promise<TeXLiveVersionInfo | null> | null = null

export function fetchTeXLiveVersion(): Promise<TeXLiveVersionInfo | null> {
  if (!cached) {
    cached = getJSON<TeXLiveVersionInfo>('/system/texlive-version')
      .then(info => (info && info.version ? info : null))
      .catch(() => {
        // 失败不进缓存：下次开弹窗再试一次（服务端那边有自己的失败缓存）
        cached = null
        return null
      })
  }
  return cached
}

export function texLiveVersionLabel(info: TeXLiveVersionInfo | null): string {
  return info && info.version ? `TeXLive ${info.version}` : 'TeXLive'
}

// 悬停提示：后端脱敏后的 tlmgr 原文（revision + version，不含安装树路径）。
// 合成**单行**：原生 title 里的换行在部分浏览器上会整条 tooltip 都不显示，
// 用 ` · ` 连接最稳。探测失败时返回 undefined，浏览器不会弹空白提示框。
export function texLiveVersionTitle(
  info: TeXLiveVersionInfo | null
): string | undefined {
  if (!info || !info.raw) {
    return undefined
  }
  return info.raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' · ')
}
