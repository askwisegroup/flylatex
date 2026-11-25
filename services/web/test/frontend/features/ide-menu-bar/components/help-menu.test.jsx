import { expect } from 'chai'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fetchMock from 'fetch-mock'

import HelpMenu from '../../../../../frontend/js/features/ide-menu-bar/components/help-menu'
import { renderWithEditorContext } from '../../../helpers/render-with-context'

// FIXED: 2026-11-10 「帮助 → 关于系统」改版：
// 标题从「favicon + FlyLaTeX」换成多语言的「关于系统」，
// 品牌标记（复用系统加载页的 FlyLaTeX 字标动画）放到正文、TeXLive 版本号上方。
//
// 注意：这里断言的是「元素真的会显示」，不只是「元素存在」。
// 之前的一版因为用 <span> 承载 .loading-screen-brand（inline 元素会让
// padding-top / height 失效，算出来是 0x0），浏览器里整个字标都看不见，
// 而当时只断言了类名存在，所以测试照样通过 —— 这是个教训。
// jsdom 不做布局计算（getBoundingClientRect 恒为 0），所以这里退而断言
// 计算样式：display 不能是 none / inline，否则 padding-top 撑不开高度。
describe('<HelpMenu /> (IDE menu bar)', function () {
  beforeEach(function () {
    window.metaAttributesCache = new Map()
    window.metaAttributesCache.set('ol-showSupport', false)
    window.metaAttributesCache.set('ol-showIdeMenuBar', true)
    fetchMock.get(
      'express:/system/texlive-version',
      { available: true, version: '2026', raw: 'TeX Live 2026' },
      { overwriteRoutes: true }
    )
  })

  afterEach(function () {
    window.metaAttributesCache = new Map()
    fetchMock.reset()
  })

  // 打开弹窗，返回弹窗容器（.modal），后续查询都在它里面做作用域
  async function openAboutModal() {
    renderWithEditorContext(<HelpMenu />)
    userEvent.click(screen.getByText('About System'))
    const modal = await screen.findByRole('document')
    return { modal }
  }

  it('titles the modal with the localised "About System" label', async function () {
    const { modal } = await openAboutModal()
    const title = modal.querySelector('.modal-title')
    expect(title.textContent.trim()).to.equal('About System')
    // 旧标题里的产品名 / favicon 图片不该再出现在弹窗标题上
    expect(title.querySelector('img')).to.equal(null)
  })

  it('shows the brand mark above the TeXLive version', async function () {
    const { modal } = await openAboutModal()

    const mark = await within(modal).findByTestId('about-brand-mark')
    // 复用系统加载页的字标动画类，而不是自己画的 SVG
    expect(mark.classList.contains('loading-screen-brand')).to.equal(true)
    expect(mark.getAttribute('aria-label')).to.equal('FlyLaTeX')
    // 不该再出现任何自绘的图标
    expect(modal.querySelector('svg')).to.equal(null)

    const version = await within(modal).findByText('TeXLive 2026')
    // 标记必须排在版本号之前（视觉上在 TeXLive 上方）
    expect(
      mark.compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING
    ).to.be.ok
  })

  it('renders the brand mark as a block so the padding-top can size it', async function () {
    const { modal } = await openAboutModal()
    const mark = await within(modal).findByTestId('about-brand-mark')

    const display = window.getComputedStyle(mark).display
    // inline 元素会忽略 width / height / padding-top 的垂直影响，
    // 容器算出 0x0，::before / ::after 的 inset:0 也跟着变成零尺寸，
    // 结果就是字标完全不显示（线上真实出过这个 bug）
    expect(display).to.not.equal('inline')
    expect(display).to.not.equal('none')
    expect(display).to.equal('block')
  })

  it('keeps the copyright line', async function () {
    const { modal } = await openAboutModal()
    await within(modal).findByText(
      new RegExp(`© ${new Date().getFullYear()} \\S`)
    )
  })
})
