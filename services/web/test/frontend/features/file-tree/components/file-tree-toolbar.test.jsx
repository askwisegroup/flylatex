import { expect } from 'chai'
import sinon from 'sinon'
import { screen } from '@testing-library/react'
import renderWithContext from '../helpers/render-with-context'

import FileTreeToolbar from '../../../../../frontend/js/features/file-tree/components/file-tree-toolbar'

describe('<FileTreeToolbar/>', function () {
  let originalMatchMedia

  beforeEach(function () {
    global.localStorage.clear()
    originalMatchMedia = window.matchMedia
  })

  afterEach(function () {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    } else {
      delete window.matchMedia
    }
  })

  it('without selected files', function () {
    renderWithContext(<FileTreeToolbar />)

    screen.getByRole('button', { name: 'New File' })
    screen.getByRole('button', { name: 'New Folder' })
    screen.getByRole('button', { name: 'Upload' })
    expect(screen.queryByRole('button', { name: 'Rename' })).to.not.exist
    expect(screen.queryByRole('button', { name: 'Delete' })).to.not.exist
    // FIXED: 2026-11-11 桌面端不出现「项目设置」齿轮
    expect(screen.queryByRole('button', { name: 'Project settings' })).to.not
      .exist
  })

  it('read-only', function () {
    renderWithContext(<FileTreeToolbar />, {
      contextProps: { permissionsLevel: 'readOnly' },
    })

    expect(screen.queryByRole('button')).to.not.exist
  })

  it('with one selected file', function () {
    renderWithContext(<FileTreeToolbar />, {
      contextProps: {
        rootDocId: '456def',
        rootFolder: [
          {
            _id: 'root-folder-id',
            name: 'rootFolder',
            docs: [{ _id: '456def', name: 'main.tex' }],
            folders: [],
            fileRefs: [],
          },
        ],
      },
    })

    screen.getByRole('button', { name: 'New File' })
    screen.getByRole('button', { name: 'New Folder' })
    screen.getByRole('button', { name: 'Upload' })
    screen.getByRole('button', { name: 'Rename' })
    screen.getByRole('button', { name: 'Delete' })
  })

  // FIXED: 2026-11-11 手机端多一颗齿轮：设置编译器 + 主目录
  it('with mobile viewport', function () {
    window.matchMedia = sinon.stub().returns({
      matches: true,
      addEventListener: sinon.stub(),
      removeEventListener: sinon.stub(),
    })

    renderWithContext(<FileTreeToolbar />)

    screen.getByRole('button', { name: 'Project settings' })
  })
})
