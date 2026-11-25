import { expect } from 'chai'
import sinon from 'sinon'
import { screen, render, waitFor } from '@testing-library/react'
import * as eventTracking from '../../../../../frontend/js/infrastructure/event-tracking'
import SettingsPageRoot from '../../../../../frontend/js/features/settings/components/root'

describe('<SettingsPageRoot />', function () {
  let sendMBSpy: sinon.SinonSpy
  beforeEach(function () {
    window.metaAttributesCache = new Map()
    window.metaAttributesCache.set('ol-usersEmail', 'foo@bar.com')
    window.metaAttributesCache.set('ol-ExposedSettings', { isOverleaf: true })
    window.metaAttributesCache.set('ol-hasPassword', true)
    window.metaAttributesCache.set('ol-ExposedSettings', {
      hasAffiliationsFeature: true,
      isOverleaf: true,
    })
    // FIXED: 2026-11-20 设置页新增「默认语言」，语言清单由 settings.pug 渲染过来
    window.metaAttributesCache.set('ol-languageOptions', [
      { code: 'en', label: 'English' },
      { code: 'zh-CN', label: '简体中文' },
    ])
    window.metaAttributesCache.set('ol-currentLanguage', 'en')
    window.metaAttributesCache.set('ol-user', {
      features: { github: true, dropbox: true, mendeley: true, zotero: true },
      refProviders: {
        mendeley: true,
        zotero: true,
      },
    })
    window.metaAttributesCache.set('ol-github', { enabled: true })
    window.metaAttributesCache.set('ol-dropbox', { registered: true })
    window.metaAttributesCache.set('ol-oauthProviders', {})
    sendMBSpy = sinon.spy(eventTracking, 'sendMB')
  })

  afterEach(function () {
    window.metaAttributesCache = new Map()
    sendMBSpy.restore()
  })

  it('displays page for Overleaf', async function () {
    render(<SettingsPageRoot />)

    await waitFor(() => {
      screen.getByText('Account Settings')
    })
    screen.getByText('Emails and Affiliations')
    screen.getByText('Update Account Info')
    // 2026-11-12 「修改密码」已暂时下线，换成充值入口
    screen.getByText('账户充值')
    // FIXED: 2026-11-20 另加「默认语言」区块
    expect(screen.queryByText('Change Password')).to.not.exist
    screen.getByText('Default language')
    screen.getByText('Integrations')
    screen.getByText('Overleaf Beta Program')
    screen.getByText('Sessions')
    screen.getByText('Newsletter')
    screen.getByRole('button', {
      name: 'Delete your account',
    })
  })

  it('keeps the password section available behind its switch', async function () {
    // FIXED: 2026-11-12 改密入口默认下线（换成充值），开关打开时原样恢复
    window.metaAttributesCache.set('ol-ExposedSettings', {
      isOverleaf: true,
      passwordChangeEnabled: true,
    })
    render(<SettingsPageRoot />)

    await waitFor(() => {
      screen.getByText('Account Settings')
    })
    screen.getByText('Change Password')
    expect(screen.queryByText('账户充值')).to.not.exist
  })

  it('displays page for non-Overleaf', async function () {
    window.metaAttributesCache.set('ol-ExposedSettings', {
      hasAffiliationsFeature: false,
      isOverleaf: false,
    })
    render(<SettingsPageRoot />)

    await waitFor(() => {
      screen.getByText('Account Settings')
    })
    expect(screen.queryByText('Emails and Affiliations')).to.not.exist
    screen.getByText('Update Account Info')
    // 2026-11-12 「修改密码」已暂时下线，换成充值入口
    screen.getByText('账户充值')
    // FIXED: 2026-11-20 另加「默认语言」区块
    expect(screen.queryByText('Change Password')).to.not.exist
    screen.getByText('Default language')
    screen.getByText('Integrations')
    expect(screen.queryByText('Overleaf Beta Program')).to.not.exist
    screen.getByText('Sessions')
    expect(screen.queryByText('Newsletter')).to.not.exist
    expect(
      screen.queryByRole('button', {
        name: 'Delete your account',
      })
    ).to.not.exist
  })

  it('sends tracking event on load', async function () {
    render(<SettingsPageRoot />)

    sinon.assert.calledOnce(sendMBSpy)
    sinon.assert.calledWith(sendMBSpy, 'settings-view')
  })
})
