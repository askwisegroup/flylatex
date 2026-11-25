import { fireEvent, screen, act } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import MobileTabs from '../../../../frontend/js/features/mobile-tabs/components/mobile-tabs'
import { renderWithEditorContext } from '../../helpers/render-with-context'

/**
 * 移动端四档 Tab（文件 / 源码 / 预览 / AI 助手）。
 *
 * 这里只测「组件该做什么」：渲染门槛、默认档位、点击后写进 Angular scope 的值、
 * 以及 Agent 档与 AI 浮层的事件协议。布局效果（哪一栏占满屏）由 ide.js 的
 * applyMobileTab + CSS 负责，不在 DOM 测试范围内。
 */

const MOBILE_QUERY = '(max-width: 767px)'

// 测试骨架里 $scope.$applyAsync 是个 sinon stub，AngularScopeValueStore.set()
// 把写操作塞进它的回调里 —— stub 不执行回调，所以 scope 永远写不进去。
// 这里换成同步执行，保证点击 -> scope 的链路是真实跑通的。
const scopeProps = { scope: { $applyAsync: (fn: () => void) => fn() } }

// window._ide.$scope 在类型上是 unknown，统一从这里读，避免 4 处 as any 散落
function currentTab(): unknown {
  const ide = window._ide as any
  return ide?.$scope?.ui?.mobileTab
}

function stubMatchMedia(matches: boolean) {
  // jsdom 没有 window.matchMedia，组件与 AI 面板都靠它判定手机宽度
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

describe('<MobileTabs />', function () {
  afterEach(function () {
    sinon.restore()
    // @ts-ignore
    delete window.matchMedia
  })

  it('桌面宽度下什么都不渲染', function () {
    stubMatchMedia(false)
    renderWithEditorContext(<MobileTabs />, scopeProps)
    expect(screen.queryByRole('tablist')).to.be.null
  })

  it('手机上渲染四档，没有 mobileTab 时默认停在「预览」', function () {
    stubMatchMedia(true)
    renderWithEditorContext(<MobileTabs />, scopeProps)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).to.have.length(4)
    expect(tabs.map(tab => tab.textContent)).to.deep.equal([
      'Files',
      'Source',
      'Preview',
      'AI',
    ])
    expect(screen.getByRole('tablist').getAttribute('aria-label')).to.equal(
      'Editor view'
    )
    expect(
      screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')
    ).to.equal('true')
  })

  it('点「源码」把 ui.mobileTab 写成 source（ide.js 据此切到编辑器那栏）', function () {
    stubMatchMedia(true)
    renderWithEditorContext(<MobileTabs />, scopeProps)

    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))

    expect(currentTab()).to.equal('source')
    expect(
      screen.getByRole('tab', { name: 'Source' }).getAttribute('aria-selected')
    ).to.equal('true')
  })

  it('点「AI 助手」走已有的 editor:toggle-ai-chat 协议打开浮层', function () {
    stubMatchMedia(true)
    const toggle = sinon.stub()
    window.addEventListener('editor:toggle-ai-chat', toggle)
    renderWithEditorContext(<MobileTabs />, scopeProps)

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    expect(currentTab()).to.equal('agent')
    expect(toggle.calledOnce).to.be.true
    window.removeEventListener('editor:toggle-ai-chat', toggle)
  })

  it('浮层被关掉时，Agent 这一档退回「预览」，不留一个空档位', async function () {
    stubMatchMedia(true)
    renderWithEditorContext(<MobileTabs />, scopeProps)

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    expect(currentTab()).to.equal('agent')

    // 面板关掉时自己会广播（codemirror-ai-chat.tsx 的 editor:ai-chat-state）
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('editor:ai-chat-state', { detail: { open: false } })
      )
    })

    expect(currentTab()).to.equal('preview')
  })
})
