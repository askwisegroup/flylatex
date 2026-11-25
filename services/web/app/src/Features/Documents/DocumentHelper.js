/* eslint-disable
    max-len,
    no-cond-assign,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let DocumentHelper
module.exports = DocumentHelper = {
  getTitleFromTexContent(content, maxContentToScan) {
    if (maxContentToScan == null) {
      maxContentToScan = 30000
    }
    const TITLE_WITH_CURLY_BRACES = /\\[tT]itle\*?\s*{([^}]+)}/
    const TITLE_WITH_SQUARE_BRACES = /\\[tT]itle\s*\[([^\]]+)\]/
    for (const line of Array.from(
      DocumentHelper._getLinesFromContent(content, maxContentToScan)
    )) {
      let match
      if (
        (match =
          line.match(TITLE_WITH_CURLY_BRACES) ||
          line.match(TITLE_WITH_SQUARE_BRACES))
      ) {
        return DocumentHelper.detex(match[1])
      }
    }

    return null
  },

  contentHasDocumentclass(content, maxContentToScan) {
    if (maxContentToScan == null) {
      maxContentToScan = 30000
    }
    for (const line of Array.from(
      DocumentHelper._getLinesFromContent(content, maxContentToScan)
    )) {
      // We've had problems with this regex locking up CPU.
      // Previously /.*\\documentclass/ would totally lock up on lines of 500kb (data text files :()
      // This regex will only look from the start of the line, including whitespace so will return quickly
      // regardless of line length.
      if (line.match(/^\s*\\documentclass/)) {
        return true
      }
    }

    return false
  },

  getCompilerFromTexContent(content, maxLinesToScan) {
    if (maxLinesToScan == null) {
      maxLinesToScan = 20
    }

    // 1) `% !TeX program = xxx` 魔数注释优先级最高（写在文件头 20 行内）
    const fromMagicComment = DocumentHelper._getCompilerFromMagicComment(
      content,
      maxLinesToScan
    )
    if (fromMagicComment) {
      return fromMagicComment
    }

    // 2) 没有魔数注释时，按导言区里用到的宏包/命令推断引擎
    // FIXED: 2026-11 原来这里只认魔数注释，没有注释的 LuaLaTeX 项目
    // （用了 \directlua / luacode / luatexja 之类）永远探测不到，
    // 导入后一律用 pdflatex 编译、然后必然失败，只能人工去切编译器。
    return DocumentHelper.getCompilerFromTexContents([content])
  },

  /**
   * 在「主文档 + 若干 include 文件」里推断编译器
   *
   * 先看每个文件的魔数注释（主文档优先），再汇总所有文件的引擎特征打分。
   * 之所以要看所有文件：LuaLaTeX 的 \directlua 经常写在章节子文件里，
   * 只看主文档的导言区会漏掉。
   *
   * @param {Array<string|Array<string>>} contents - 文件内容（主文档放在第一个）
   * @returns {'lualatex'|'xelatex'|'pdflatex'|'latex'|null}
   */
  getCompilerFromTexContents(contents) {
    const list = (contents || []).filter(Boolean)
    if (list.length === 0) {
      return null
    }

    // 魔数注释：任何文件里写了就听它的（主文档排在最前面，先命中）
    for (const content of list) {
      const compiler = DocumentHelper._getCompilerFromMagicComment(content, 20)
      if (compiler) {
        return compiler
      }
    }

    const scores = { lua: 0, xe: 0, unicode: 0 }
    for (const content of list) {
      DocumentHelper._scoreCompilerSignals(content, scores)
    }

    return DocumentHelper._decideCompilerFromScores(scores)
  },

  /**
   * 引擎特征打分（见 _decideCompilerFromScores 的判定顺序）
   */
  _scoreCompilerSignals(content, scores) {
    const text = DocumentHelper._getHeuristicText(content)
    if (!text) {
      return scores
    }

    // LuaLaTeX 专有（出现即基本可以确定）
    const LUA_STRONG = [
      /\\directlua\b/,
      /\\latelua\b/,
      /\\luaexec\b/,
      /\\luadirect\b/,
      /\\begin\s*\{luacode\*?\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{luacode\*?\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{luatexbase\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{luaotfload\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{luamplib\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{luatexja/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{luapstricks\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{luafontify\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{lua-?unicode\}/,
    ]

    // LuaLaTeX 相关但非专有
    const LUA_WEAK = [/\\ifluatex\b/, /\bLuaTeX\b/]

    // XeLaTeX 专有
    const XE_STRONG = [
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{xeCJK/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{xunicode\}/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{xltxtra\}/,
      /\\setCJKmainfont/,
      /\\setCJKsansfont/,
      /\\setCJKmonofont/,
      /\\setCJKfamilyfont/,
      /\\xeCJKsetup/,
    ]

    const XE_WEAK = [/\\XeTeX\b/, /\\ifxetex\b/]

    // 两个引擎都支持，但默认按 XeLaTeX 处理（更稳妥的一侧）
    const UNICODE = [
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{fontspec\}/,
      /\\setmainfont/,
      /\\setsansfont/,
      /\\setmonofont/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{unicode-math\}/,
      /\\setmathfont/,
      /\\usepackage\s*(?:\[[^\]]*\])?\s*\{polyglossia\}/,
      /\\setdefaultlanguage/,
    ]

    for (const pattern of LUA_STRONG) {
      if (pattern.test(text)) {
        scores.lua += 10
      }
    }
    for (const pattern of LUA_WEAK) {
      if (pattern.test(text)) {
        scores.lua += 2
      }
    }
    for (const pattern of XE_STRONG) {
      if (pattern.test(text)) {
        scores.xe += 10
      }
    }
    for (const pattern of XE_WEAK) {
      if (pattern.test(text)) {
        scores.xe += 2
      }
    }
    for (const pattern of UNICODE) {
      if (pattern.test(text)) {
        scores.unicode += 4
      }
    }

    return scores
  },

  /**
   * 打分 → 编译器
   *
   * 判定顺序（保守优先，宁可不动也别乱切）：
   *   1. 有 Lua 专有特征 → lualatex
   *   2. 有 XeLaTeX 专有特征 → xelatex
   *   3. 只有 fontspec / unicode-math / polyglossia → xelatex
   *   4. 只有 \ifluatex 这类弱特征 → lualatex
   *   5. 什么都没有 → null（保持项目默认，通常就是 pdflatex）
   */
  _decideCompilerFromScores(scores) {
    if (!scores) {
      return null
    }
    const { lua = 0, xe = 0, unicode = 0 } = scores

    if (lua >= 10 && lua >= xe) {
      return 'lualatex'
    }
    if (xe >= 10) {
      return 'xelatex'
    }
    if (unicode > 0) {
      return 'xelatex'
    }
    if (lua > 0 && xe === 0) {
      return 'lualatex'
    }
    if (xe > 0) {
      return 'xelatex'
    }
    return null
  },

  /**
   * 只在头部 20 行里找 `% !TeX program = xxx`
   */
  _getCompilerFromMagicComment(content, maxLinesToScan) {
    const lines = Array.isArray(content)
      ? content.slice(0, maxLinesToScan)
      : String(content || '')
          .split(/\r\n|\n|\r/)
          .slice(0, maxLinesToScan)
    const TEX_PROGRAM_MAGIC_COMMENT =
      /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)\s*$/i
    const COMPILER_BY_PROGRAM = {
      xelatex: 'xelatex',
      lualatex: 'lualatex',
      pdflatex: 'pdflatex',
      latex: 'latex',
      xetex: 'xelatex',
      luatex: 'lualatex',
      pdftex: 'pdflatex',
      tex: 'latex',
    }
    for (const line of lines) {
      const match = line.replace(/^\uFEFF/, '').match(TEX_PROGRAM_MAGIC_COMMENT)
      if (match) {
        const compiler = COMPILER_BY_PROGRAM[match[1].toLowerCase()]
        if (compiler) {
          return compiler
        }
      }
    }
    return null
  },

  /**
   * 取用于打分的文本片段（够看导言区，又不至于扫整篇几 MB 的正文）
   */
  _getHeuristicText(content) {
    const MAX_CHARS = 200000
    if (Array.isArray(content)) {
      return content.join('\n').slice(0, MAX_CHARS)
    }
    return String(content || '').slice(0, MAX_CHARS)
  },

  detex(string) {
    return string
      .replace(/\\LaTeX/g, 'LaTeX')
      .replace(/\\TeX/g, 'TeX')
      .replace(/\\TikZ/g, 'TikZ')
      .replace(/\\BibTeX/g, 'BibTeX')
      .replace(/\\\[[A-Za-z0-9. ]*\]/g, ' ') // line spacing
      .replace(/\\(?:[a-zA-Z]+|.|)/g, '')
      .replace(/{}|~/g, ' ')
      .replace(/[${}]/g, '')
      .replace(/ +/g, ' ')
      .trim()
  },

  _getLinesFromContent(content, maxContentToScan) {
    if (typeof content === 'string') {
      return content.substring(0, maxContentToScan).split('\n')
    } else {
      return content
    }
  },
}
