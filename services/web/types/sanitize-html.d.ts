/**
 * FIXED: 2026-11-08 sanitize-html 的最小类型声明。
 *
 * 上游包没有自带 .d.ts，`@types/sanitize-html` 也没有装。这里只声明我们在
 * frontend/js/shared/utils/markdown.ts 用到的那一个签名（HTML 字符串进、字符串出），
 * 不去猜它的完整选项类型 —— 选项本身是数据，写错也是运行时才该发现的事。
 */
declare module 'sanitize-html' {
  export interface SanitizeHtmlOptions {
    allowedTags?: string[]
    allowedAttributes?: Record<string, string[]>
    allowedSchemes?: string[]
    allowedSchemesByTag?: Record<string, string[]>
    allowedStyles?: Record<string, unknown>
    allowProtocolRelative?: boolean
    transformTags?: Record<
      string,
      (
        tagName: string,
        attribs: Record<string, string>
      ) => { tagName: string; attribs: Record<string, string> }
    >
  }

  export default function sanitizeHtml(
    html: string,
    options?: SanitizeHtmlOptions
  ): string
}
