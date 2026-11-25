import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import SyncKeysSection from '../../../../../frontend/js/features/settings/components/SyncKeysSection'

const keyEntry = {
  id: '670e00000000000000000001',
  name: 'MacBook Pro',
  key_prefix: 'flysync_a1b2c3d4…',
  created_at: '2026-10-15T08:00:00.000Z',
  last_used_at: null,
}

describe('<SyncKeysSection />', function () {
  beforeEach(function () {
    fetchMock.reset()
  })

  afterEach(function () {
    fetchMock.restore()
  })

  it('renders the list of keys', async function () {
    fetchMock.get('/api/sync/keys', {
      status: 200,
      body: { keys: [keyEntry] },
    })
    render(<SyncKeysSection />)

    await waitFor(() => {
      screen.getByText('MacBook Pro')
    })
    screen.getByText('flysync_a1b2c3d4…')
    screen.getByText('Never used')
    screen.getByRole('button', { name: 'Revoke' })
  })

  it('creates a key and shows the one-time plaintext', async function () {
    fetchMock.get('/api/sync/keys', { status: 200, body: { keys: [] } })
    fetchMock.post('/api/sync/keys', {
      status: 201,
      body: {
        id: '670e00000000000000000002',
        key: 'flysync_deadbeefdeadbeef',
        name: 'Mac mini',
        key_prefix: 'flysync_deadbeef…',
        created_at: '2026-10-15T09:00:00.000Z',
      },
    })
    render(<SyncKeysSection />)

    await waitFor(() => {
      screen.getByText('No API keys yet.')
    })

    const input = screen.getByPlaceholderText('e.g. MacBook Pro')
    await userEvent.type(input, 'Mac mini')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create new key' })
    )

    await waitFor(() => {
      screen.getByDisplayValue('flysync_deadbeefdeadbeef')
    })
    screen.getByRole('button', { name: 'Copy' })
  })

  it('hides itself when the sync service is disabled (404)', async function () {
    fetchMock.get('/api/sync/keys', { status: 404, body: {} })
    const { container } = render(<SyncKeysSection />)

    await waitFor(() => {
      expect(container.querySelector('.settings-section')).to.not.exist
    })
    expect(screen.queryByText('API keys')).to.not.exist
  })
})
