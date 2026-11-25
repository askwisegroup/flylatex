// 独立运行的冒烟测试：node app/src/Features/Compile/CompilerAutoDetect.test.js
// 只依赖纯函数模块，不连 Mongo/Redis/CLSI。

const assert = require('assert')
const {
  detectCompilerFromLog,
  shouldSwitchCompiler,
  readStreamCapped,
  MAX_LOG_BYTES,
} = require('./CompilerAutoDetect')
const { Readable } = require('stream')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

async function checkAsync(name, fn) {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

async function main() {
  console.log('Compiler auto-detect')

  // ---- 日志识别 ----
  check('fontspec 在 pdflatex 下的报错 → xelatex', () => {
    assert.strictEqual(
      detectCompilerFromLog(
        '! Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.'
      ),
      'xelatex'
    )
  })

  check('ctex 在 pdflatex 下的报错 → xelatex', () => {
    assert.strictEqual(
      detectCompilerFromLog(
        '! Package ctex Error: CTeX package requires XeTeX or LuaLaTeX.'
      ),
      'xelatex'
    )
  })

  check('xeCJK / unicode-math 一类 "requires XeTeX" → xelatex', () => {
    assert.strictEqual(
      detectCompilerFromLog('! Package xeCJK Error: xeCJK requires XeTeX.'),
      'xelatex'
    )
  })

  check('luacode 的报错 → lualatex（优先于 xelatex）', () => {
    assert.strictEqual(
      detectCompilerFromLog(
        '! Package luacode Error: luacode requires LuaTeX.'
      ),
      'lualatex'
    )
  })

  // FIXED: 2026-11 pdflatex 编译 \directlua 项目时，日志里不会出现 "LuaTeX"
  // 字样，只有一句 Undefined control sequence —— 之前完全探测不到。
  check(
    'directlua 在 pdflatex 下报 Undefined control sequence → lualatex',
    () => {
      const log = [
        '! Undefined control sequence.',
        'l.12 \\directlua',
        '               {tex.print("hello")}',
      ].join('\n')
      assert.strictEqual(detectCompilerFromLog(log), 'lualatex')
    }
  )

  check('luatexja / luaotfload 一类包报错 → lualatex', () => {
    assert.strictEqual(
      detectCompilerFromLog(
        '! Package luatexja Error: LuaTeX is required for luatexja.'
      ),
      'lualatex'
    )
    assert.strictEqual(
      detectCompilerFromLog(
        '! Package luaotfload Error: luaotfload requires LuaTeX.'
      ),
      'lualatex'
    )
  })

  check('普通语法错误不触发', () => {
    assert.strictEqual(
      detectCompilerFromLog(
        '! Undefined control sequence.\nl.42 \\foo\n! Emergency stop.'
      ),
      null
    )
  })

  check('缺包（不是引擎问题）不触发', () => {
    assert.strictEqual(
      detectCompilerFromLog("! LaTeX Error: File `algorithm2e.sty' not found."),
      null
    )
  })

  check('空日志不触发', () => {
    assert.strictEqual(detectCompilerFromLog(''), null)
    assert.strictEqual(detectCompilerFromLog(null), null)
    assert.strictEqual(detectCompilerFromLog(undefined), null)
  })

  check('报错在日志中段也能识别', () => {
    const log =
      'This is pdfTeX, Version 3.141592653\n'.repeat(50) +
      '! Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.\n'
    assert.strictEqual(detectCompilerFromLog(log), 'xelatex')
  })

  check('Buffer 输入也能识别', () => {
    assert.strictEqual(
      detectCompilerFromLog(
        Buffer.from('requires either XeTeX or LuaTeX', 'utf8')
      ),
      'xelatex'
    )
  })

  // ---- 是否切换 ----
  check('pdflatex 失败 + 探测到 xelatex → 切', () => {
    assert.strictEqual(
      shouldSwitchCompiler({
        currentCompiler: 'pdflatex',
        detectedCompiler: 'xelatex',
      }),
      true
    )
  })

  check('latex(dvi) 失败 + 探测到 lualatex → 切', () => {
    assert.strictEqual(
      shouldSwitchCompiler({
        currentCompiler: 'latex',
        detectedCompiler: 'lualatex',
      }),
      true
    )
  })

  check('已经是 xelatex 就不再切（避免来回震荡）', () => {
    assert.strictEqual(
      shouldSwitchCompiler({
        currentCompiler: 'xelatex',
        detectedCompiler: 'xelatex',
      }),
      false
    )
    assert.strictEqual(
      shouldSwitchCompiler({
        currentCompiler: 'xelatex',
        detectedCompiler: 'lualatex',
      }),
      false
    )
  })

  check('没探测出结果就不切', () => {
    assert.strictEqual(
      shouldSwitchCompiler({
        currentCompiler: 'pdflatex',
        detectedCompiler: null,
      }),
      false
    )
  })

  check('项目没有编译器字段时按 pdflatex 兜底比较', () => {
    assert.strictEqual(
      shouldSwitchCompiler({
        currentCompiler: undefined,
        detectedCompiler: 'xelatex',
      }),
      false
    )
  })

  // ---- 读流截断 ----
  await checkAsync('readStreamCapped 正常读完', async () => {
    const text = await readStreamCapped(Readable.from(['abc', 'def']))
    assert.strictEqual(text, 'abcdef')
  })

  await checkAsync('readStreamCapped 超长会被截断', async () => {
    const big = 'x'.repeat(MAX_LOG_BYTES + 1024)
    const text = await readStreamCapped(Readable.from([big]))
    assert.ok(text.length <= MAX_LOG_BYTES + 1024)
    assert.ok(text.length > 0)
  })

  // ---- 真实场景串起来 ----
  check('真实 pdflatex 日志片段：整体判定为 xelatex', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653-2.6-1.40.25 (TeX Live 2023)',
      '(./main.tex',
      'LaTeX2e <2023-06-01>',
      '(/usr/share/texlive/texmf-dist/tex/latex/fontspec/fontspec.sty',
      '! Package fontspec Error: The fontspec package requires either XeTeX or',
      '(fontspec)                LuaTeX.',
      '(fontspec)',
      '(fontspec)  For more information, see the fontspec documentation',
      '!  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n')
    assert.strictEqual(detectCompilerFromLog(log), 'xelatex')
  })

  console.log(`\n${passed}/${passed} checks passed`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
