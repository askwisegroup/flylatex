import { expect } from 'chai'
import sinon from 'sinon'

import customLocalStorage from '@/infrastructure/local-storage'
import {
  closeTab,
  getTabs,
  initEditorTabs,
  isTabsEnabled,
  openTab,
  pruneTabs,
  resetTabsForTests,
  setTabsEnabled,
  subscribeTabs,
} from '@/features/editor-tabs/editor-tabs-store'

describe('editor-tabs-store', function () {
  let getItemStub: sinon.SinonStub
  let setItemStub: sinon.SinonStub

  beforeEach(function () {
    getItemStub = sinon.stub(customLocalStorage, 'getItem').returns(null)
    setItemStub = sinon.stub(customLocalStorage, 'setItem')
    resetTabsForTests()
  })

  afterEach(function () {
    sinon.restore()
    resetTabsForTests()
  })

  it('初始为空', function () {
    initEditorTabs('p1')
    expect(getTabs()).to.deep.equal([])
  })

  it('按项目恢复已保存的页签，并过滤掉坏数据/重复项', function () {
    getItemStub.returns([
      { id: 'a', name: 'main.tex' },
      { id: 'a', name: 'dup.tex' },
      { id: '', name: 'empty' },
      { name: 'no-id' },
      null,
      { id: 'b', name: 'refs.bib' },
    ])

    initEditorTabs('p1')

    expect(getTabs()).to.deep.equal([
      { id: 'a', name: 'main.tex' },
      { id: 'b', name: 'refs.bib' },
    ])
    expect(customLocalStorage.getItem).to.have.been.calledWith('editor.tabs.p1')
  })

  it('openTab 去重、改名、并按顺序追加', function () {
    initEditorTabs('p1')
    openTab('a', 'main.tex')
    openTab('b', 'refs.bib')
    openTab('a', 'main.tex')
    openTab('b', 'references.bib')

    expect(getTabs()).to.deep.equal([
      { id: 'a', name: 'main.tex' },
      { id: 'b', name: 'references.bib' },
    ])
  })

  it('超过上限时挤掉最旧的页签', function () {
    initEditorTabs('p1')
    for (let index = 0; index < 14; index++) {
      openTab(`doc-${index}`, `chapter-${index}.tex`)
    }

    const tabs = getTabs()
    expect(tabs).to.have.length(12)
    expect(tabs[0].id).to.equal('doc-2')
    expect(tabs[tabs.length - 1].id).to.equal('doc-13')
  })

  it('closeTab 移除指定页签并持久化', function () {
    initEditorTabs('p1')
    openTab('a', 'main.tex')
    openTab('b', 'refs.bib')
    closeTab('a')

    expect(getTabs()).to.deep.equal([{ id: 'b', name: 'refs.bib' }])
    expect(setItemStub).to.have.been.called
  })

  it('pruneTabs 剔除已不存在的文档', function () {
    initEditorTabs('p1')
    openTab('a', 'main.tex')
    openTab('b', 'refs.bib')
    openTab('c', 'old.tex')

    pruneTabs(id => id !== 'c')

    expect(getTabs().map(tab => tab.id)).to.deep.equal(['a', 'b'])
  })

  it('页签栏开关默认开启，可以关掉并持久化', function () {
    initEditorTabs('p1')
    expect(isTabsEnabled()).to.equal(true)

    setTabsEnabled(false)
    expect(isTabsEnabled()).to.equal(false)
    expect(setItemStub).to.have.been.calledWith('editor.tabs.enabled', false)

    setTabsEnabled(true)
    expect(isTabsEnabled()).to.equal(true)
  })

  it('关掉页签栏不影响已记录的页签（重新打开还能恢复）', function () {
    initEditorTabs('p1')
    openTab('a', 'main.tex')
    setTabsEnabled(false)
    openTab('b', 'refs.bib')

    expect(getTabs().map(tab => tab.id)).to.deep.equal(['a', 'b'])
  })

  it('状态变化会通知订阅者', function () {
    initEditorTabs('p1')
    const listener = sinon.spy()
    const unsubscribe = subscribeTabs(listener)

    openTab('a', 'main.tex')
    expect(listener).to.have.been.calledOnce

    closeTab('a')
    expect(listener).to.have.been.calledTwice

    unsubscribe()
    openTab('b', 'refs.bib')
    expect(listener).to.have.been.calledTwice
  })
})
