import { expect } from 'chai'

import {
  detectBibliographySetup,
  normalizeBibPath,
} from '@/features/source-editor/aegeanexts/CrosRefSearch/bib-setup'

/**
 * FIXED: 2026-11-16 回归：参考文献数据源探测。
 *
 * 线上事故：ECNU 学位论文模板写的是
 *     \ecnuSetup{ style = { bibResource = {./bib/thesis-ref.bib} } }
 * 旧逻辑只认 \bibliography{}，于是「导入本分类到 .bib」直接提示
 * 「请先在文档末尾加 \bibliography{...}」——明明 .bib 挂着。
 */

describe('normalizeBibPath', function () {
  it('补 .bib、去 ./ 前缀', function () {
    expect(normalizeBibPath('refs')).to.equal('refs.bib')
    expect(normalizeBibPath('./bib/thesis-ref.bib')).to.equal(
      'bib/thesis-ref.bib'
    )
    expect(normalizeBibPath('bib/thesis-ref')).to.equal('bib/thesis-ref.bib')
    expect(normalizeBibPath('"refs.bib"')).to.equal('refs.bib')
  })
})

describe('detectBibliographySetup', function () {
  it('传统 \\bibliography（多个、带路径、带/不带 .bib）', function () {
    const setup = detectBibliographySetup(
      '\\bibliography{refs,bib/second,./bib/third.bib}'
    )
    expect(setup.hasBibliography).to.equal(true)
    expect(setup.usesBibTeX).to.equal(true)
    expect(setup.bibFiles).to.deep.equal([
      'refs.bib',
      'bib/second.bib',
      'bib/third.bib',
    ])
    expect(setup.bibNames).to.deep.equal(['refs', 'second', 'third'])
  })

  it('biblatex \\addbibresource[opts]{path}', function () {
    const setup = detectBibliographySetup(
      '\\addbibresource[location=local]{./bib/thesis-ref.bib}'
    )
    expect(setup.bibFiles).to.deep.equal(['bib/thesis-ref.bib'])
  })

  it('ECNU 模板的 bibResource keyval（线上踩到的那份）', function () {
    const doc = `
\\ecnuSetup{
  info = { title = {基于微信小程序的线下课程考勤系统的设计与实现} },
  style = {
    bibResource = {./bib/thesis-ref.bib},
    bibStyle = ieee,
  }
}
\\printbibliography
`
    const setup = detectBibliographySetup(doc)
    expect(setup.hasBibliography).to.equal(true)
    expect(setup.usesBibTeX).to.equal(true)
    expect(setup.bibFiles).to.deep.equal(['bib/thesis-ref.bib'])
    expect(setup.bibNames).to.deep.equal(['thesis-ref'])
    expect(setup.hasPrintBibliography).to.equal(true)
  })

  it('只有 thebibliography 环境：算有数据源，但不是 BibTeX 文件', function () {
    const setup = detectBibliographySetup(
      '\\begin{thebibliography}{99}\\bibitem{a} A\\end{thebibliography}'
    )
    expect(setup.hasBibliography).to.equal(true)
    expect(setup.usesBibTeX).to.equal(false)
    expect(setup.bibFiles).to.deep.equal([])
  })

  it('什么都没有时不该误判', function () {
    const setup = detectBibliographySetup('\\documentclass{article}')
    expect(setup.hasBibliography).to.equal(false)
    expect(setup.usesBibTeX).to.equal(false)
    expect(setup.bibFiles).to.deep.equal([])
  })

  it('同一路径重复出现只留一份', function () {
    const setup = detectBibliographySetup(
      '\\addbibresource{./bib/x.bib}\n\\bibliography{bib/x}'
    )
    expect(setup.bibFiles).to.deep.equal(['bib/x.bib'])
  })
})
