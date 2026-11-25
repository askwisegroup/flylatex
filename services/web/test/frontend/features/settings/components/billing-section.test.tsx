import { expect } from 'chai'
import { fireEvent, screen, render, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import BillingSection from '../../../../../frontend/js/features/settings/components/billing-section'

const LEDGER_URL = '/api/billing/ledger'

function setExposedSettings(overrides = {}) {
  window.metaAttributesCache.set('ol-ExposedSettings', {
    adminEmail: 'support@example.com',
    billing: {
      enabled: true,
      ledgerEnabled: true,
      currency: 'SGD',
      topupUrl: null,
      ...overrides,
    },
  })
}

describe('<BillingSection />', function () {
  beforeEach(function () {
    window.metaAttributesCache = window.metaAttributesCache || new Map()
    setExposedSettings()
  })

  afterEach(function () {
    window.metaAttributesCache = new Map()
    fetchMock.reset()
  })

  it('keeps the top-up button disabled without a payment page', function () {
    render(<BillingSection />)

    screen.getByText('账户充值')
    const topup = screen.getByRole('button', { name: '充值' })
    // 没有 BILLING_TOPUP_URL 时不能把用户送进一个不存在的收银台
    expect(topup.hasAttribute('disabled')).to.be.true
    screen.getByText('充值通道正在开通中。如需充值或对账，请联系客服处理。')
  })

  it('links to the payment page when one is configured', function () {
    setExposedSettings({ topupUrl: 'https://pay.example/checkout' })
    render(<BillingSection />)

    const link = screen.getByRole('link', { name: '充值' })
    expect(link.getAttribute('href')).to.equal('https://pay.example/checkout')
  })

  it('fetches the ledger only when the records are opened', async function () {
    fetchMock.get(LEDGER_URL, {
      ok: true,
      enabled: true,
      currency: 'SGD',
      balance: 87.5,
      entries: [
        {
          id: 'e2',
          kind: 'charge',
          amount: -2.5,
          balanceAfter: 87.5,
          at: '2026-11-12T02:00:00.000Z',
          note: '',
          status: 'applied',
        },
        {
          id: 'e1',
          kind: 'grant',
          amount: 100,
          balanceAfter: 100,
          at: '2026-11-10T02:00:00.000Z',
          note: '',
          status: 'applied',
        },
      ],
    })
    render(<BillingSection />)

    expect(fetchMock.called(LEDGER_URL)).to.be.false

    fireEvent.click(screen.getByRole('button', { name: '充值记录' }))

    await waitFor(() => {
      screen.getByText('注册赠送')
    })
    expect(fetchMock.called(LEDGER_URL)).to.be.true
    screen.getByText('消费')
    // 余额只出现在展开后的面板里（顶部摘要 + 每行结余各一处），未展开时不显示
    expect(screen.getAllByText('S$87.50')).to.have.length(2)
    screen.getByText('-S$2.50')
    expect(screen.getAllByText('S$100.00')).to.have.length(2)
  })

  it('keeps sub-cent charges visible instead of rounding them to zero', async function () {
    // 一次 deepseek 调用大约 1309 微单位（¥0.0013）；toFixed(2) 会变成 ¥0.00
    fetchMock.get(LEDGER_URL, {
      ok: true,
      enabled: true,
      currency: 'CNY',
      balance: 99.998691,
      entries: [
        {
          id: 'e1',
          kind: 'charge',
          amount: -0.001309,
          balanceAfter: 99.998691,
          at: '2026-11-12T02:00:00.000Z',
          note: '',
          status: 'applied',
        },
      ],
    })
    render(<BillingSection />)

    fireEvent.click(screen.getByRole('button', { name: '充值记录' }))

    await waitFor(() => {
      screen.getByText('-¥0.001309')
    })
    // 余额仍然只保留两位（顶部摘要 + 该行结余各一处）
    expect(screen.getAllByText('¥100.00')).to.have.length(2)
  })

  it('says the ledger is not enabled instead of showing an error', async function () {
    fetchMock.get(LEDGER_URL, {
      ok: true,
      enabled: false,
      currency: 'CNY',
      balance: null,
      entries: [],
    })
    render(<BillingSection />)

    fireEvent.click(screen.getByRole('button', { name: '充值记录' }))

    await waitFor(() => {
      screen.getByText(/还没有充值记录/)
    })
    screen.getByText(/本站尚未开启计费账本/)
  })

  it('reports a failed read without breaking the section', async function () {
    fetchMock.get(LEDGER_URL, { ok: false, enabled: true, entries: [] })
    render(<BillingSection />)

    fireEvent.click(screen.getByRole('button', { name: '充值记录' }))

    await waitFor(() => {
      screen.getByRole('alert')
    })
    screen.getByText('充值记录读取失败，请稍后重试。')
    // 失败后按钮仍然可以再次点击重试
    expect(
      screen.getByRole('button', { name: '收起充值记录' }).hasAttribute('disabled')
    ).to.be.false
  })
})
