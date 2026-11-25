const { expect } = require('chai')
const LatexLogParser = require('../../../../app/src/Features/Compile/LatexLogParser')

describe('LatexLogParser', function () {
  describe('missing character', function () {
    // FIXED: 2026-11-11 pdfTeX/xeTeX 缺字时不会让编译失败（latexmk 退出码 0），
    // 只在日志里留一行 "Missing character"。解析器必须把它暴露成 warning，
    // 否则调用方只能看到 status=success + errors=[]，误判「排版正确」。
    it('reports missing characters as warnings', function () {
      const log = [
        'This is XeTeX, Version 3.141592653',
        '(./main.tex',
        'Missing character: There is no 浥 (U+6D65) in font [FandolSong-Regular.otf]/OT:s',
        'Missing character: There is no 篲 (U+7BF2) in font [FandolSong-Regular.otf]/OT:s',
        ')',
      ].join('\n')

      const parsed = new LatexLogParser(log, {
        ignoreDuplicates: true,
      }).parse()

      expect(parsed.errors).to.have.length(0)
      expect(parsed.warnings).to.have.length(2)
      expect(parsed.warnings[0].message).to.equal(
        'Missing character: "浥" (U+6D65) not found in font [FandolSong-Regular.otf]/OT:s'
      )
      expect(parsed.warnings[1].message).to.include('U+7BF2')
    })

    it('does not let the missing-character line pollute the file stack', function () {
      // 该行含括号，若未被单独识别会落进 parseParensForFilenames 污染文件栈
      const log = [
        'Missing character: There is no 浥 (U+6D65) in font [FandolSong-Regular.otf]/OT:s',
        './main.tex:7: Undefined control sequence.',
      ].join('\n')

      const parsed = new LatexLogParser(log, {
        ignoreDuplicates: true,
      }).parse()

      expect(parsed.errors).to.have.length(1)
      expect(parsed.errors[0].file).to.equal('./main.tex')
      expect(parsed.errors[0].line).to.equal('7')
    })
  })
})
