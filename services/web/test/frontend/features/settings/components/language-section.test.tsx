import { expect } from 'chai'
import { fireEvent, screen, render } from '@testing-library/react'
import LanguageSection from '../../../../../frontend/js/features/settings/components/language-section'

const OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'ja', label: '日本語' },
]

// jsdom 里 location.reload 是自有只读属性，stub 不了；这里只关心
// 「有没有把切换动作交给模板里的 setLanguage」
function stubSetLanguage() {
  const calls: string[] = []
  ;(window as any).flylatexSetLanguage = (code: string) => {
    calls.push(code)
  }
  return calls
}

describe('<LanguageSection />', function () {
  beforeEach(function () {
    window.metaAttributesCache = window.metaAttributesCache || new Map()
    window.metaAttributesCache.set('ol-languageOptions', OPTIONS)
    window.metaAttributesCache.set('ol-currentLanguage', 'zh-CN')
  })

  afterEach(function () {
    window.metaAttributesCache = new Map()
    delete (window as any).flylatexSetLanguage
  })

  it('lists every language and preselects the server-rendered one', function () {
    render(<LanguageSection />)

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).to.equal('zh-CN')
    screen.getByRole('option', { name: 'English' })
    screen.getByRole('option', { name: '日本語' })
    screen.getByText('Default language')
  })

  // FIXED: 2026-11-20 切换动作交给 layout-base.pug 的 setLanguage
  // （写 cookie + localStorage + reload 都在那里），页面不再自己拼一份。
  it('hands the switch over to the page setLanguage helper', function () {
    const calls = stubSetLanguage()
    render(<LanguageSection />)

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'ja' },
    })

    expect(calls).to.eql(['ja'])
  })

  it('falls back to the footer language link when the helper is missing', function () {
    const anchor = document.createElement('a')
    anchor.setAttribute('data-ol-set-lang', 'ja')
    let clicked = 0
    anchor.addEventListener('click', () => {
      clicked++
    })
    document.body.append(anchor)

    render(<LanguageSection />)
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'ja' },
    })

    expect(clicked).to.equal(1)
    anchor.remove()
  })

  it('tells the user where to switch when nothing can handle it', function () {
    render(<LanguageSection />)
    const select = screen.getByRole('combobox') as HTMLSelectElement

    fireEvent.change(select, { target: { value: 'ja' } })

    screen.getByText(
      'Could not switch language here. Please use the language menu in the footer.'
    )
    // 没有切换成功时下拉框保持原值，避免"看着切了其实没切"
    expect(select.value).to.equal('zh-CN')
  })

  it('renders nothing when the language list is missing', function () {
    window.metaAttributesCache.delete('ol-languageOptions')
    const { container } = render(<LanguageSection />)

    expect(container.querySelector('select')).to.equal(null)
  })
})
