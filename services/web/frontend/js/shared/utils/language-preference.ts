// FIXED: 2026-11-20 语言切换**只保留一份实现**，前端不再自己抄一套。
//
// 踩过的坑：设置页原来自己拼 cookie 名 + localStorage key 列表去写，
// 而模板 layout-base.pug 里的页脚选择器写的是另一个 cookie 名
// （和服务端 Translations.js 实际读取的 `flylatex-lang` 对不上），
// 于是「切了语言、刷新回来还是原语言」——完全没反应。
//
// 现在：写 cookie / 写 localStorage / 刷新，全部走 layout-base.pug 里那份
// setLanguage（已挂到 window.flylatexSetLanguage），前端只负责调用。
// 这样页脚选择器、设置页「默认语言」、门户站三处不会各写一半。

export type SetLanguageFn = (code: string) => void

export function applyLanguagePreference(code: string): boolean {
  if (!code) return false

  const setLanguage = (window as any).flylatexSetLanguage as
    | SetLanguageFn
    | undefined
  if (typeof setLanguage === 'function') {
    setLanguage(code)
    return true
  }

  // 兜底：页脚语言菜单里同 code 的链接（点击监听也是 layout-base 绑的）
  const anchors = Array.from(
    document.querySelectorAll('[data-ol-set-lang]')
  ) as HTMLElement[]
  const anchor = anchors.find(
    el => el.getAttribute('data-ol-set-lang') === code
  )
  if (anchor) {
    anchor.click()
    return true
  }

  return false
}
