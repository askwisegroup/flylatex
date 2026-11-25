import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import ProjectSettingsModal from '../../../../../frontend/js/features/editor-left-menu/components/project-settings-modal'
import { renderWithEditorContext } from '../../../helpers/render-with-context'

/**
 * 移动端「项目设置」弹窗。
 *
 * 它自己不做保存，只把系统已有的 SettingsCompiler / SettingsDocument 装进
 * 一个弹窗。所以这里测的是「装进来了、且写回走的是同一套 project settings」，
 * 不去重复测试两个设置组件自己的选项列表。
 */
describe('<ProjectSettingsModal />', function () {
  const docsScope = {
    docs: [
      {
        path: '/main.tex',
        doc: { id: 'doc-main', name: 'main.tex', type: 'doc' },
      },
    ],
  }

  beforeEach(function () {
    // isValidTeXFile 读的是 window.ExposedSettings
    window.ExposedSettings.validRootDocExtensions = ['tex', 'latex']
  })

  afterEach(function () {
    fetchMock.reset()
  })

  function renderModal() {
    return renderWithEditorContext(
      <ProjectSettingsModal show onHide={sinon.stub()} />,
      {
        rootDocId: 'doc-other',
        scope: docsScope,
      }
    )
  }

  it('只包含编译器与主目录两项', function () {
    renderModal()

    expect(screen.getByText('Project settings')).to.exist
    expect(screen.getByLabelText('Compiler')).to.exist
    expect(screen.getByLabelText('Main document')).to.exist
  })

  it('切换编译器时走已有的项目设置接口', async function () {
    fetchMock.post(`express:/project/:projectId/settings`, 204)

    renderModal()

    fireEvent.change(screen.getByLabelText('Compiler'), {
      target: { value: 'xelatex' },
    })

    await waitFor(() => {
      const calls = fetchMock.calls() as unknown as Array<[string, RequestInit]>
      expect(calls).to.have.length(1)
      expect(String(calls[0][0])).to.contain('/project/project123/settings')
      expect(JSON.parse(String(calls[0][1].body))).to.deep.equal({
        compiler: 'xelatex',
      })
    })
  })

  it('切换主目录时改的是同一个 rootDocId', async function () {
    fetchMock.post(`express:/project/:projectId/settings`, 204)

    renderModal()

    fireEvent.change(screen.getByLabelText('Main document'), {
      target: { value: 'doc-main' },
    })

    await waitFor(() => {
      const calls = fetchMock.calls() as unknown as Array<[string, RequestInit]>
      expect(calls).to.have.length(1)
      expect(JSON.parse(String(calls[0][1].body))).to.deep.equal({
        rootDocId: 'doc-main',
      })
    })
  })
})
