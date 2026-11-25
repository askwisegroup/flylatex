import { render, screen } from '@testing-library/react'
import HotkeysModal from '../../../../../frontend/js/features/hotkeys-modal/components/hotkeys-modal'
import { expect } from 'chai'
import sinon from 'sinon'

const modalProps = {
  show: true,
  handleHide: sinon.stub(),
  trackChangesVisible: false,
}

describe('<HotkeysModal />', function () {
  it('renders the translated modal title on cm6', async function () {
    const { baseElement } = render(
      <HotkeysModal {...modalProps} newSourceEditor />
    )

    expect(baseElement.querySelector('.modal-title').textContent).to.equal(
      'Hotkeys (Source editor)'
    )
  })

  it('renders the translated modal title on ace', async function () {
    const { baseElement } = render(
      <HotkeysModal {...modalProps} newSourceEditor={false} />
    )

    expect(baseElement.querySelector('.modal-title').textContent).to.equal(
      'Hotkeys (Legacy source editor)'
    )
  })

  it('renders translated heading with embedded code', function () {
    const { baseElement } = render(<HotkeysModal {...modalProps} />)

    const results = baseElement.querySelectorAll('h3 code')
    expect(results).to.have.length(1)
  })

  it('renders the hotkey descriptions', function () {
    const { baseElement } = render(<HotkeysModal {...modalProps} />)

    const hotkeys = baseElement.querySelectorAll(
      '[data-test-selector="hotkey"]'
    )
    // FIXED: 2026-11-19 条目数随新增的全局键位同步更新
    // （设置 / AI 对话 / 聊天 / 共享 / 参考文献 / 快捷命令 / 符号表 / 全项目搜索，共 27 条）
    expect(hotkeys).to.have.length(27)
  })

  it('adds extra hotkey descriptions when Track Changes is enabled', function () {
    const { baseElement } = render(
      <HotkeysModal {...modalProps} trackChangesVisible />
    )

    const hotkeys = baseElement.querySelectorAll(
      '[data-test-selector="hotkey"]'
    )
    // 27 + 审阅组的 3 条（Ctrl+J / Ctrl+Shift+A / Ctrl+Shift+C）
    expect(hotkeys).to.have.length(30)
  })

  it('uses Ctrl for non-macOS', function () {
    render(<HotkeysModal {...modalProps} />)

    expect(screen.getAllByText(/Ctrl/)).to.have.length(24)
    expect(screen.queryByText(/Cmd/)).to.not.exist
  })

  it('uses Cmd for macOS', function () {
    render(<HotkeysModal {...modalProps} isMac />)

    expect(screen.getAllByText(/Cmd/)).to.have.length(20)
    expect(screen.getAllByText(/Ctrl/)).to.have.length(4)
  })
})
