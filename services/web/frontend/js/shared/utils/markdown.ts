import { marked, Renderer } from 'marked'
import sanitizeHtml from 'sanitize-html'

/**
 * FIXED: 2026-10-16 统一 Markdown 渲染，外链强制新标签页打开
 *
 * 问题：AI 面板直接使用 marked() 渲染，生成的 <a> 没有 target，
 *       用户点击链接会直接覆盖当前 Web 应用（丢失编辑现场）。
 * 方案：覆盖 marked 的 link 渲染器，为 http(s)/协议相对地址补上
 *       target="_blank" rel="noopener noreferrer"；站内锚点/相对链接保持原行为。
 */

// 项目依赖 marked ^4.1.0，使用 marked.use + renderer 覆盖，向后兼容性最好
const defaultRenderer = new Renderer()

marked.setOptions({
  breaks: true,
  gfm: true,
})

marked.use({
  renderer: {
    link(href: string | null, title: string | null, text: string): string {
      const html = defaultRenderer.link.call(defaultRenderer, href, title, text)
      // 仅对绝对外链（http/https/协议相对）新开标签，避免影响站内锚点
      if (href && /^(https?:)?\/\//i.test(href)) {
        return html.replace(
          '<a ',
          '<a target="_blank" rel="noopener noreferrer" '
        )
      }
      return html
    },
  },
})

const MATH_TOKEN_PREFIX = 'FLYLATEXMATHPLACEHOLDER'
const MATH_TOKEN_SUFFIX = 'END'
const MATH_TOKEN_RE = new RegExp(
  `${MATH_TOKEN_PREFIX}(\\d+)${MATH_TOKEN_SUFFIX}`,
  'g'
)

/**
 * FIXED: 2026-10-23 保护 LaTeX 数学分隔符
 *
 * 问题：marked 会把 `\(` 当作转义括号处理，输出成 `(`，
 *       导致 MathJax 找不到公式边界，只能显示 `(o_t = ...)` 这样的源码。
 * 方案：渲染前把数学片段替换成占位符，渲染后再还原；数学片段内部
 *       的 `_`、`*`、`\` 等也不会被 Markdown 误解析。
 */
function protectMath(markdown: string): { text: string; math: string[] } {
  const math: string[] = []
  const protect = (text: string, pattern: RegExp) =>
    text.replace(pattern, match => {
      const token = `${MATH_TOKEN_PREFIX}${math.length}${MATH_TOKEN_SUFFIX}`
      math.push(match)
      return token
    })

  let text = markdown
  // 独立公式：\[...\] / $$...$$ / LaTeX 环境
  text = protect(text, /\\\[[\s\S]*?\\\]/g)
  text = protect(text, /\$\$[\s\S]*?\$\$/g)
  text = protect(text, /\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\}/g)
  // 行内公式：\(...\)
  text = protect(text, /\\\([\s\S]*?\\\)/g)
  return { text, math }
}

function escapeMathHtml(math: string): string {
  return math
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * FIXED: 2026-11-08 Markdown 预览用的 HTML 白名单。
 *
 * AI 消息是模型自己说的话，风险相对可控；但 `.md` 是**项目里的文件**
 * （可能是协作者写的、从别处导入的、AI 从网上抄的），属于不可信输入，
 * 直接 dangerouslySetInnerHTML 等于开一个存储型 XSS 入口。
 * 这里只放行排版需要的标签/属性：脚本、事件属性、style、iframe、form 全部不给。
 *
 * 数学公式以 `\(...\)` 这类**文本**形式存在，sanitize 不会动它，
 * 之后由 MathJax 在 DOM 里二次排版。
 */
const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'strong',
    'b',
    'em',
    'i',
    'del',
    's',
    'ins',
    'mark',
    'sub',
    'sup',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
    'img',
    'code',
    'pre',
    'kbd',
    'samp',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'div',
    'span',
    // GFM 任务列表 - [ ] / - [x]
    'input',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel', 'name'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    div: ['class'],
    li: ['class'],
    // 任务列表的复选框：只允许只读态（下面 transformTags 会强制 disabled）
    input: ['type', 'checked', 'disabled'],
    '*': ['id'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  // 不保留 style：否则 md 里一句 style="position:fixed;inset:0" 就能盖住整个 IDE
  allowedStyles: {},
  transformTags: {
    input: (tagName: string, attribs: Record<string, string>) => ({
      tagName,
      attribs: { type: 'checkbox', disabled: 'disabled', ...attribs },
    }),
  },
}

/**
 * 将 Markdown 文本渲染为 HTML 字符串（已配置 marked，外链新标签打开）。
 * 数学公式以 LaTeX 分隔符形式保留，由调用方用 MathJax 做最终排版。
 *
 * @param options.sanitize 是否用 sanitize-html 过一遍白名单。
 *   默认 false —— 保持 AI 面板原有行为不变；渲染**项目文件**时必须传 true。
 */
export function renderMarkdown(
  markdown: string | undefined | null,
  options?: { sanitize?: boolean }
): string {
  if (!markdown) return ''
  const { text, math } = protectMath(markdown)
  const raw = marked(text) as string
  const html = raw.replace(MATH_TOKEN_RE, (_, index) => {
    const value = math[Number(index)]
    return value === undefined ? '' : escapeMathHtml(value)
  })
  if (!options?.sanitize) return html
  return sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS)
}

export { marked }
