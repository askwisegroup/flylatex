const { expect } = require('chai')
const {
  collectFileRefs,
} = require('../../../../app/src/Features/User/usageFileRefs')

describe('usageFileRefs', function () {
  // Project 模型里 rootFolder 是 [FolderSchema]（数组）。上一版实现直接读
  // rootFolder.fileRefs，对数组读出 undefined，于是「附件」永远 0 个 0 字节，
  // 而用户明明传了 PNG 插图。这个用例就是钉住这个形状。
  it('accepts the array shape used by project.rootFolder', function () {
    const root = [
      {
        name: 'root',
        fileRefs: [{ _id: 'a', name: 'logo.png' }],
        folders: [],
      },
    ]
    expect(collectFileRefs(root).map(f => f.name)).to.deep.equal(['logo.png'])
  })

  it('accepts a plain folder object too', function () {
    const root = {
      name: 'root',
      fileRefs: [{ _id: 'a', name: 'logo.png' }],
    }
    expect(collectFileRefs(root)).to.have.length(1)
  })

  it('walks nested folders to any depth', function () {
    const root = [
      {
        name: 'root',
        fileRefs: [{ _id: 'a', name: 'a.png' }],
        folders: [
          {
            name: 'img',
            fileRefs: [{ _id: 'b', name: 'b.png' }],
            folders: [
              {
                name: 'deep',
                fileRefs: [{ _id: 'c', name: 'c.png' }],
                folders: [],
              },
            ],
          },
        ],
      },
    ]
    expect(collectFileRefs(root).map(f => f.name)).to.deep.equal([
      'a.png',
      'b.png',
      'c.png',
    ])
  })

  it('ignores entries without an id and empty input', function () {
    expect(collectFileRefs(undefined)).to.deep.equal([])
    expect(collectFileRefs([])).to.deep.equal([])
    expect(
      collectFileRefs([{ fileRefs: [null, {}, { name: 'x' }] }])
    ).to.deep.equal([])
  })
})
