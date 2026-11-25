import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import SelectMainFileModal from '../../../../../frontend/js/features/editor-left-menu/components/select-main-file-modal'
import { renderWithEditorContext } from '../../../helpers/render-with-context'

// rootDoc = null：就是「导入的项目没有主文件」那个死局场景
const docsScope = {
  docs: [
    {
      path: '/paper/chapter1.tex',
      doc: { id: 'doc-chapter', name: 'chapter1.tex', type: 'doc' },
    },
    {
      path: '/main.tex',
      doc: { id: 'doc-main', name: 'main.tex', type: 'doc' },
    },
    {
      path: '/notes.txt',
      doc: { id: 'doc-notes', name: 'notes.txt', type: 'doc' },
    },
  ],
}

describe('<SelectMainFileModal />', function () {
  beforeEach(function () {
    // isValidTeXFile 读的是 window.ExposedSettings，测试环境默认没带这个字段
    window.ExposedSettings.validRootDocExtensions = ['tex', 'latex']
  })

  afterEach(function () {
    fetchMock.reset()
  })

  type RenderProps = {
    rootDocId?: string | null
    onHide?: sinon.SinonStub
    onSelected?: (docId: string) => void
  }

  function renderModal(props: RenderProps = {}) {
    return renderWithEditorContext(
      <SelectMainFileModal
        show
        onHide={props.onHide ?? sinon.stub()}
        onSelected={props.onSelected}
      />,
      {
        rootDocId: props.rootDocId ?? null,
        scope: docsScope,
      }
    )
  }

  it('只列出 .tex 文件，并把 main.tex 排在第一位', function () {
    renderModal()

    const radios = screen.getAllByRole('radio')
    expect(radios).to.have.length(2)

    const labels = radios.map(radio =>
      radio.closest('label')!.textContent!.trim()
    )
    expect(labels[0]).to.contain('main.tex')
    expect(labels[1]).to.contain('paper/chapter1.tex')
    expect(screen.queryByText('/notes.txt')).to.equal(null)
  })

  it('建议项带标记，没有主文件时默认选中建议项', function () {
    renderModal()

    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios[0].checked).to.equal(true)
    expect(radios[1].checked).to.equal(false)
    expect(screen.getByText('Suggested')).to.exist
  })

  it('有主文件时默认选中当前主文件，而不是建议项', function () {
    renderModal({ rootDocId: 'doc-chapter' })

    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios[0].checked).to.equal(false)
    expect(radios[1].checked).to.equal(true)
  })

  it('确认后写回 rootDocId 并回调', async function () {
    fetchMock.post(`express:/project/:projectId/settings`, 204)
    const onSelected = sinon.stub()
    const onHide = sinon.stub()

    renderModal({ onSelected, onHide })

    fireEvent.click(screen.getByText('Set as main file and compile'))

    await waitFor(() => expect(onHide.called).to.equal(true))
    expect(onSelected.calledWith('doc-main')).to.equal(true)

    // fetch-mock 记录的是 [url, options] 两个元素的数组
    await waitFor(() => {
      const calls = fetchMock.calls() as unknown as Array<[string, RequestInit]>
      expect(calls).to.have.length(1)
      expect(String(calls[0][0])).to.contain('/project/project123/settings')
      expect(JSON.parse(String(calls[0][1].body))).to.deep.equal({
        rootDocId: 'doc-main',
      })
    })
  })

  it('保存失败时给出提示，不关闭弹窗', async function () {
    fetchMock.post(`express:/project/:projectId/settings`, 500)
    const onSelected = sinon.stub()
    const onHide = sinon.stub()

    renderModal({ onSelected, onHide })

    fireEvent.click(screen.getByText('Set as main file and compile'))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).to.contain(
        "Couldn't update the main file"
      )
    )
    expect(onHide.called).to.equal(false)
    expect(onSelected.called).to.equal(false)
  })
})
