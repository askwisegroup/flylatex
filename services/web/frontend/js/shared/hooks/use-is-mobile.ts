import { useEffect, useState } from 'react'

// FIXED: 2026-11-11 移动端判定（<= 767px）。
//
// 与 mobile-tabs / ide.js 用的是同一条 query，保持「手机」只有一个定义。
// 这里抽成 hook 是因为文件树工具条也要按端决定是否渲染「项目设置」齿轮：
// 桌面端已经有 设置 → 编译与项目，没必要再多一颗按钮改变现有布局。
const MOBILE_QUERY = '(max-width: 767px)'

function getIsMobile() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(MOBILE_QUERY).matches
  )
}

export default function useIsMobile() {
  const [isMobile, setIsMobile] = useState(getIsMobile)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
