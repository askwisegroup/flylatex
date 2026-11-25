/* eslint-disable
    max-len,
    no-return-assign,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const sinon = require('sinon')
const { expect } = require('chai')
const modulePath = '../../../../app/src/Features/Documents/DocumentHelper.js'
const SandboxedModule = require('sandboxed-module')

describe('DocumentHelper', function () {
  beforeEach(function () {
    return (this.DocumentHelper = SandboxedModule.require(modulePath))
  })

  describe('getTitleFromTexContent', function () {
    it('should return the title', function () {
      const document = '\\begin{document}\n\\title{foo}\n\\end{document}'
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.equal('foo')
    })

    it('should return the title if surrounded by space', function () {
      const document = '\\begin{document}\n   \\title{foo}   \n\\end{document}'
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.equal('foo')
    })

    it('should return null if there is no title', function () {
      const document = '\\begin{document}\n\\end{document}'
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.eql(null)
    })

    it('should accept an array', function () {
      const document = ['\\begin{document}', '\\title{foo}', '\\end{document}']
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.equal('foo')
    })

    it('should parse out formatting elements from the title', function () {
      const document = '\\title{\\textbf{\\large{Second Year LaTeX Exercise}}}'
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.equal('Second Year LaTeX Exercise')
    })

    it('should ignore junk after the title', function () {
      const document = '\\title{wombat} potato'
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.equal('wombat')
    })

    it('should ignore junk before the title', function () {
      const document =
        '% this is something that v1 relied on, even though it seems odd \\title{wombat}'
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.equal('wombat')
    })

    // NICETOHAVE: Current implementation doesn't do this
    // it "should keep content that surrounds formatting elements", ->
    //	document = "\\title{Second Year \\large{LaTeX} Exercise}"
    //	expect(@DocumentHelper.getTitleFromTexContent(document)).to.equal "Second Year LaTeX Exercise"

    it('should collapse whitespace', function () {
      const document = '\\title{Second    Year  LaTeX     Exercise}'
      return expect(
        this.DocumentHelper.getTitleFromTexContent(document)
      ).to.equal('Second Year LaTeX Exercise')
    })
  })

  describe('detex', function () {
    // note, there are a number of tests for getTitleFromTexContent that also test cases here
    it('leaves a non-TeX string unchanged', function () {
      expect(this.DocumentHelper.detex('')).to.equal('')
      expect(this.DocumentHelper.detex('a')).to.equal('a')
      return expect(this.DocumentHelper.detex('a a')).to.equal('a a')
    })

    it('collapses spaces', function () {
      expect(this.DocumentHelper.detex('a  a')).to.equal('a a')
      return expect(this.DocumentHelper.detex('a \n a')).to.equal('a \n a')
    })

    it('replaces named commands', function () {
      expect(this.DocumentHelper.detex('\\LaTeX')).to.equal('LaTeX')
      expect(this.DocumentHelper.detex('\\TikZ')).to.equal('TikZ')
      expect(this.DocumentHelper.detex('\\TeX')).to.equal('TeX')
      return expect(this.DocumentHelper.detex('\\BibTeX')).to.equal('BibTeX')
    })

    it('removes general commands', function () {
      expect(this.DocumentHelper.detex('\\foo')).to.equal('')
      expect(this.DocumentHelper.detex('\\foo{}')).to.equal('')
      expect(this.DocumentHelper.detex('\\foo~Test')).to.equal('Test')
      expect(this.DocumentHelper.detex('\\"e')).to.equal('e')
      return expect(this.DocumentHelper.detex('\\textit{e}')).to.equal('e')
    })

    it('leaves basic math', function () {
      return expect(this.DocumentHelper.detex('$\\cal{O}(n^2)$')).to.equal(
        'O(n^2)'
      )
    })

    it('removes line spacing commands', function () {
      return expect(this.DocumentHelper.detex('a \\\\[1.50cm] b')).to.equal(
        'a b'
      )
    })
  })

  describe('getCompilerFromTexContent', function () {
    it('should parse % !TeX program', function () {
      const document = '% !TeX program = xelatex\n\\documentclass{article}'
      expect(this.DocumentHelper.getCompilerFromTexContent(document)).to.equal(
        'xelatex'
      )
    })

    it('should parse TeXShop TS-program and ignore case/spacing', function () {
      const document =
        '  %!TEX TS-program = LuaLaTeX  \n\\documentclass{article}'
      expect(this.DocumentHelper.getCompilerFromTexContent(document)).to.equal(
        'lualatex'
      )
    })

    it('should accept an array and a BOM', function () {
      const document = [
        '\uFEFF% !TEX program = pdflatex',
        '\\documentclass{article}',
      ]
      expect(this.DocumentHelper.getCompilerFromTexContent(document)).to.equal(
        'pdflatex'
      )
    })

    it('should map lower-level engines to the supported compilers', function () {
      expect(
        this.DocumentHelper.getCompilerFromTexContent('% !TeX program = xetex')
      ).to.equal('xelatex')
      expect(
        this.DocumentHelper.getCompilerFromTexContent('% !TeX program = luatex')
      ).to.equal('lualatex')
    })

    it('should ignore unsupported programs', function () {
      expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '% !TeX program = context'
        )
      ).to.equal(null)
    })

    it('should ignore other magic comments', function () {
      const document = '% !TeX encoding = utf8\n% !TEX root = main.tex'
      expect(this.DocumentHelper.getCompilerFromTexContent(document)).to.equal(
        null
      )
    })

    it('should only scan the first 20 lines', function () {
      const lines = new Array(20).fill('% filler')
      lines.push('% !TeX program = xelatex')
      expect(this.DocumentHelper.getCompilerFromTexContent(lines)).to.equal(
        null
      )
    })
  })

  describe('getCompilerFromTexContent - engine heuristics', function () {
    // FIXED: 2026-11 没有 `% !TeX program` 时按宏包/命令特征推断引擎。
    // 之前只认魔数注释，LuaLaTeX 项目导入后一律 pdflatex 编译，必然失败。
    it('detects LuaLaTeX from luacode / directlua', function () {
      return expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '\\documentclass{article}\n\\usepackage{luacode}\n\\begin{luacode}\nx=1\n\\end{luacode}'
        )
      ).to.equal('lualatex')
    })

    it('detects LuaLaTeX from luatexja', function () {
      return expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '\\documentclass{article}\n\\usepackage{luatexja-fontspec}'
        )
      ).to.equal('lualatex')
    })

    it('detects XeLaTeX from xeCJK', function () {
      return expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '\\documentclass{article}\n\\usepackage{xeCJK}\n\\setCJKmainfont{Songti SC}'
        )
      ).to.equal('xelatex')
    })

    it('treats fontspec / unicode-math as XeLaTeX', function () {
      expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '\\documentclass{article}\n\\usepackage{fontspec}'
        )
      ).to.equal('xelatex')
      expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '\\documentclass{article}\n\\usepackage{unicode-math}'
        )
      ).to.equal('xelatex')
    })

    it('keeps plain documents on the default engine', function () {
      return expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '\\documentclass{article}\n\\usepackage{amsmath}'
        )
      ).to.equal(null)
    })

    it('lets % !TeX program win over heuristics', function () {
      return expect(
        this.DocumentHelper.getCompilerFromTexContent(
          '% !TeX program = pdflatex\n\\documentclass{article}\n\\directlua{1}'
        )
      ).to.equal('pdflatex')
    })

    it('finds engine signals in included files', function () {
      return expect(
        this.DocumentHelper.getCompilerFromTexContents([
          '\\documentclass{article}\n\\begin{document}\\input{ch1}\\end{document}',
          '\\usepackage{luacode}',
        ])
      ).to.equal('lualatex')
    })
  })

  describe('contentHasDocumentclass', function () {
    it('should return true if the content has a documentclass', function () {
      const document = ['% line', '% line', '% line', '\\documentclass']
      return expect(
        this.DocumentHelper.contentHasDocumentclass(document)
      ).to.equal(true)
    })

    it('should allow whitespace before the documentclass', function () {
      const document = ['% line', '% line', '% line', '        \\documentclass']
      return expect(
        this.DocumentHelper.contentHasDocumentclass(document)
      ).to.equal(true)
    })

    it('should not allow non-whitespace before the documentclass', function () {
      const document = [
        '% line',
        '% line',
        '% line',
        '    asdf \\documentclass',
      ]
      return expect(
        this.DocumentHelper.contentHasDocumentclass(document)
      ).to.equal(false)
    })

    it('should return false when there is no documentclass', function () {
      const document = ['% line', '% line', '% line']
      return expect(
        this.DocumentHelper.contentHasDocumentclass(document)
      ).to.equal(false)
    })
  })
})
