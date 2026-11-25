import { expect } from 'chai'

import {
  MAX_ERRORS,
  collectErrors,
} from '@/features/compile-error-fix/collect-errors'

/**
 * FIXED: 2026-11-16 回归测试（线上事故）：
 * compile context 里的 logEntries 是
 *   { errors: [], warnings: [], typesetting: [], all: [] }
 * 不是数组。早先组件直接把整个对象当数组扫，永远得到空数组，
 * 于是「AI 修复」每次都回「这次编译没有可定位到源码文件的错误」。
 */

const errorEntry = (overrides = {}) => ({
  level: 'error',
  message: 'Undefined control sequence.',
  file: 'main.tex',
  line: 12,
  key: Math.random().toString(36).slice(2),
  ...overrides,
})

describe('collectErrors（AI 修复的入参）', function () {
  it('吃 { all } 结构（真实形状）', function () {
    const errors = collectErrors({
      errors: [errorEntry()],
      warnings: [],
      typesetting: [],
      all: [errorEntry({ key: 'a' })],
    })

    expect(errors).to.deep.equal([
      { file: 'main.tex', line: 12, message: 'Undefined control sequence.' },
    ])
  })

  it('也吃纯数组（防止上游改结构）', function () {
    expect(collectErrors([errorEntry()])).to.have.length(1)
  })

  it('只有 errors 数组时也能用', function () {
    expect(collectErrors({ errors: [errorEntry()] })).to.have.length(1)
  })

  it('error 全收；warning 只收「带文件+行号」的；typesetting 不收', function () {
    const errors = collectErrors({
      all: [
        // 没有行号的 warning（Overfull hbox 这种）→ 不收
        errorEntry({ level: 'warning', message: 'Overfull hbox', line: 0 }),
        // FIXED: 2026-11-16 带位置的 warning（Citation undefined 常见）→ 收
        errorEntry({
          level: 'warning',
          message: "Citation '' on page 17 undefined on input line 318.",
          file: './main.tex',
          line: 318,
        }),
        errorEntry({ level: 'typesetting', message: 'Underfull' }),
        errorEntry({ level: 'error', file: 'chapters/a.tex', line: 7 }),
      ],
    })

    expect(errors).to.have.length(2)
    expect(errors[0].file).to.equal('chapters/a.tex')
    expect(errors[1]).to.deep.equal({
      file: 'main.tex',
      line: 318,
      message: "Citation '' on page 17 undefined on input line 318.",
    })
  })

  it('message 是组件时退回 content；两者都没有则跳过', function () {
    const errors = collectErrors({
      all: [
        errorEntry({
          message: undefined,
          messageComponent: () => null,
          content: 'LaTeX Error: X',
        }),
        errorEntry({
          message: undefined,
          content: undefined,
          messageComponent: () => null,
        }),
      ],
    })

    expect(errors).to.have.length(1)
    expect(errors[0].message).to.equal('LaTeX Error: X')
  })

  it('去掉 ./. 前缀、去重、上限 6 条', function () {
    const many = Array.from({ length: 20 }, (_, i) =>
      errorEntry({ file: './main.tex', line: 1, message: `err ${i}` })
    )
    const errors = collectErrors({ all: [...many, errorEntry()] })

    expect(errors.length).to.equal(MAX_ERRORS)
    expect(errors[0].file).to.equal('main.tex')
    // 同一条重复的只留一份
    const dup = collectErrors({
      all: [errorEntry(), errorEntry()],
    })
    expect(dup).to.have.length(1)
  })

  it('空/null/怪结构不炸', function () {
    expect(collectErrors(undefined)).to.deep.equal([])
    expect(collectErrors(null)).to.deep.equal([])
    expect(collectErrors({})).to.deep.equal([])
  })
})
