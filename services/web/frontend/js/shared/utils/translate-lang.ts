// 翻译目标语言：源语言一律交给模型自动判断，用户只管选要翻成什么语言。
//
// 注意：AI 菜单有两份实现
//   - features/editor-navigation-toolbar/components/toolbar-header.jsx（旧版 Angular 编辑器，实际在用）
//   - features/ide-menu-bar/components/ai-menu.tsx（新版 React IDE）
// 两边都要能用，所以常量与 localStorage 读写放在这里，不要各写一份。

// FIXED: 2026-11-09 新增日文 / 西班牙文（老板需求）。
// 后端白名单在 overleaf-ne-login/translate-lang.js，两边必须一致。
export type TargetLang = 'en' | 'zh' | 'fr' | 'de' | 'ru' | 'ja' | 'es' | 'pt'

export const TARGET_LANGS: TargetLang[] = [
  'en',
  'zh',
  'fr',
  'de',
  'ru',
  'ja',
  'es',
  // FIXED: 2026-11-10 补葡萄牙语（后端白名单同步改）
  'pt',
]

export const TARGET_LANG_LABEL_KEY: Record<TargetLang, string> = {
  en: 'lang_english',
  zh: 'lang_chinese',
  fr: 'lang_french',
  de: 'lang_german',
  ru: 'lang_russian',
  ja: 'lang_japanese',
  es: 'lang_spanish',
  pt: 'lang_portuguese',
}

export const TRANSLATE_TARGET_STORAGE_KEY = 'fl-translate-target'

// FIXED: 2026-11-09 两个入口都改成「默认不预选」，等用户选了目标语言再翻译，
// 所以 readStoredTargetLang() 现在没有调用方（保留导出，避免影响历史调用；
// 需要恢复"记住上次选择"时直接用它即可）。
export const DEFAULT_TARGET_LANG: TargetLang = 'en'

export function readStoredTargetLang(): TargetLang {
  try {
    const value = window.localStorage.getItem(TRANSLATE_TARGET_STORAGE_KEY)
    return TARGET_LANGS.includes(value as TargetLang)
      ? (value as TargetLang)
      : DEFAULT_TARGET_LANG
  } catch {
    return DEFAULT_TARGET_LANG
  }
}

export function storeTargetLang(lang: TargetLang) {
  try {
    window.localStorage.setItem(TRANSLATE_TARGET_STORAGE_KEY, lang)
  } catch {
    // 忽略：不记忆不影响翻译
  }
}
