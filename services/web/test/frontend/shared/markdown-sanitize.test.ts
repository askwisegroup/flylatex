import { expect } from 'chai'
import { renderMarkdown } from '../../../frontend/js/shared/utils/markdown'
import { isMarkdownFile } from '../../../frontend/js/shared/utils/is-markdown-file'

/**
 * FIXED: 2026-11-08 `.md` 可以进「可视化编辑器」后新增的回归用例。
 *
 * 预览渲染的是**项目文件**（协作者/导入/AI 生成），属于不可信输入，
 * 所以必须走 sanitize 白名单；同时表格、链接、公式这些 Markdown 核心语法
 * 不能被消毒顺手删掉。
 */
describe('renderMarkdown(sanitize)', () => {
  const render = (md: string) => renderMarkdown(md, { sanitize: true })

  it('保留表格', () => {
    const html = render('| 工具 | 作用 |\n|---|---|\n| `read` | 读文件 |')
    expect(html).to.include('<table>')
    expect(html).to.include('<th>工具</th>')
    expect(html).to.include('<td>读文件</td>')
  })

  it('保留链接，外链强制新标签页', () => {
    expect(render('[a](https://example.com)')).to.include('target="_blank"')
    expect(render('[b](relative/path.tex)')).to.include(
      '<a href="relative/path.tex"'
    )
  })

  it('保留行内与独立公式，交给 MathJax 排版', () => {
    expect(render('斜体 $x$')).to.include('$x$')
    expect(render('行内 \\(o_t = h_t\\)')).to.include('\\(o_t = h_t\\)')
    expect(render('$$\n\\frac{a}{b}\n$$')).to.include('\\frac{a}{b}')
  })

  it('清除脚本、事件属性、style 与 javascript: 协议', () => {
    const html = render(
      [
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(2)">',
        '<style>body{display:none}</style>',
        '<a href="javascript:alert(3)">x</a>',
        '<div style="position:fixed;inset:0">y</div>',
      ].join('\n')
    )
    expect(html).to.not.match(/<script/i)
    expect(html).to.not.match(/onerror/i)
    expect(html).to.not.match(/<style/i)
    expect(html).to.not.match(/javascript:/i)
    expect(html).to.not.match(/position:\s*fixed/i)
  })

  it('默认不消毒（AI 面板行为不变）', () => {
    expect(renderMarkdown('<b>hi</b>')).to.include('<b>hi</b>')
  })
})

describe('isMarkdownFile', () => {
  it('识别 .md / .markdown，大小写不敏感', () => {
    expect(isMarkdownFile('NOTES.md')).to.equal(true)
    expect(isMarkdownFile('docs/a.markdown')).to.equal(true)
    expect(isMarkdownFile('README.MD')).to.equal(true)
  })

  it('.txt 与 LaTeX 文件不算（纯文本按 Markdown 渲染会显示错）', () => {
    expect(isMarkdownFile('TODO.txt')).to.equal(false)
    expect(isMarkdownFile('main.tex')).to.equal(false)
    expect(isMarkdownFile(null)).to.equal(false)
  })
})
