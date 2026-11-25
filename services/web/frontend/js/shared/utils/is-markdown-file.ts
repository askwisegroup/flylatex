/**
 * FIXED: 2026-11-08 判断文件是否可以用「预览」方式查看（Markdown）。
 *
 * 与 isValidTeXFile 同一位置、同一风格：只按扩展名判断，不解析内容。
 * .md / .markdown 是 Markdown；.txt 不算 —— 纯文本按 Markdown 渲染会把
 * 星号、井号之类当成标记，反而把原内容显示错，还是老实看源码。
 */
const MARKDOWN_FILE_REGEXP = /\.(md|markdown)$/i

export function isMarkdownFile(filename: string | null | undefined): boolean {
  if (!filename) return false
  return MARKDOWN_FILE_REGEXP.test(filename)
}

export default isMarkdownFile
