const sinon = require('sinon')
const { expect } = require('chai')
const SandboxedModule = require('sandboxed-module')

const modulePath =
  '../../../../app/src/Features/DesktopSync/DesktopSyncUpload.js'
const ArchiveErrors = require('../../../../app/src/Features/Uploads/ArchiveErrors')
const Errors = require('../../../../app/src/Features/Errors/Errors')

function dirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  }
}

// FIXED: 2026-11-11 mocha 传给 beforeEach 与 test 的上下文不是同一个对象，
// mock 闭包里读 this.readdirResult 永远拿到 beforeEach 时那个空数组，
// 导致「zip 里有文件」的用例全部被当成空 zip 报 EmptyZipFileError。
// 把会被测试重新赋值状态放到模块级共享对象里。
const shared = {}

describe('DesktopSyncUpload', function () {
  beforeEach(function () {
    this.userId = 'user-id'
    this.projectId = 'project-id'

    // 只读的假文件系统：readdir 结果决定「期望文件集」
    this.readdirResult = []
    shared.readdirResult = this.readdirResult
    this.fsPromises = {
      mkdir: sinon.stub().resolves(),
      rm: sinon.stub().resolves(),
      unlink: sinon.stub().resolves(),
      readFile: sinon.stub().resolves('changed content'),
      readdir: sinon.stub().callsFake(async () => shared.readdirResult),
    }

    // 让 it 里的 `this.readdirResult = [...]` 同步到共享对象
    Object.defineProperty(this, 'readdirResult', {
      configurable: true,
      get: () => shared.readdirResult,
      set: value => {
        shared.readdirResult = value
      },
    })

    this.entities = { docs: [], files: [], folders: [] }
    this.ProjectEntityHandler = {
      promises: {
        getAllEntities: sinon.stub().callsFake(async () => this.entities),
        getDoc: sinon.stub().resolves({ lines: ['original'] }),
      },
    }
    this.EditorController = {
      promises: { deleteEntityWithPath: sinon.stub().resolves() },
    }
    this.UpdateMerger = {
      promises: { _mergeUpdate: sinon.stub().resolves({}) },
    }
    this.ProjectUpdateHandler = {
      promises: { markAsUpdated: sinon.stub().resolves() },
    }

    this.DesktopSyncUpload = SandboxedModule.require(modulePath, {
      requires: {
        '@overleaf/settings': { path: { uploadFolder: '/tmp/uploads' } },
        '@overleaf/promise-utils': { expressify: fn => fn },
        'fs/promises': this.fsPromises,
        '../Project/ProjectEntityHandler': this.ProjectEntityHandler,
        '../Project/ProjectUpdateHandler': this.ProjectUpdateHandler,
        '../Project/ProjectRootDocManager': {
          promises: { ensureRootDocumentIsValid: sinon.stub().resolves() },
        },
        '../DocumentUpdater/DocumentUpdaterHandler': {
          promises: { flushProjectToMongo: sinon.stub().resolves() },
        },
        '../Editor/EditorController': this.EditorController,
        '../ThirdPartyDataStore/UpdateMerger': this.UpdateMerger,
        '../Uploads/ArchiveManager': {
          promises: {
            extractZipArchive: sinon.stub().resolves(),
            findTopLevelDirectory: sinon.stub().resolves('/tmp/root'),
          },
        },
        '../Uploads/FileTypeManager': {
          promises: { getType: sinon.stub().resolves({ binary: false }) },
        },
        '../Uploads/ArchiveErrors': ArchiveErrors,
        '../Errors/Errors': Errors,
        './DesktopSyncLastModified': {
          getProjectLastModified: sinon.stub().resolves({ lastModified: 1 }),
        },
      },
    })

    this.deletedPaths = () =>
      this.EditorController.promises.deleteEntityWithPath.args.map(a => a[1])
  })

  describe('_reconcileFromZip', function () {
    it('keeps entities whose path is present in the zip (leading-slash path domain)', async function () {
      // 项目实体路径带前导 '/'，zip 解压后的 relPath 不带
      this.entities.docs = [{ path: '/main.tex', doc: { _id: 'doc-1' } }]
      this.entities.folders = [{ path: '/', folder: { _id: 'root' } }]
      this.readdirResult = [dirent('main.tex', 'file')]

      await this.DesktopSyncUpload._reconcileFromZip(
        this.userId,
        this.projectId,
        '/tmp/zip.zip'
      )

      expect(this.deletedPaths()).to.deep.equal([])
      expect(
        this.UpdateMerger.promises._mergeUpdate.args[0].slice(0, 3)
      ).to.deep.equal([this.userId, this.projectId, '/main.tex'])
      expect(
        this.ProjectUpdateHandler.promises.markAsUpdated.calledOnce
      ).to.equal(true)
    })

    it('deletes entities that the zip no longer contains', async function () {
      this.entities.docs = [
        { path: '/main.tex', doc: { _id: 'doc-1' } },
        { path: '/gone.tex', doc: { _id: 'doc-2' } },
      ]
      this.entities.folders = [{ path: '/', folder: { _id: 'root' } }]
      this.readdirResult = [dirent('main.tex', 'file')]

      await this.DesktopSyncUpload._reconcileFromZip(
        this.userId,
        this.projectId,
        '/tmp/zip.zip'
      )

      expect(this.deletedPaths()).to.deep.equal(['/gone.tex'])
    })

    it('rejects a zip that contains no syncable file instead of emptying the project', async function () {
      this.entities.docs = [{ path: '/main.tex', doc: { _id: 'doc-1' } }]
      this.entities.folders = [{ path: '/', folder: { _id: 'root' } }]
      // 仅含被忽略文件 -> 期望集为空
      this.readdirResult = [dirent('.DS_Store', 'file')]

      await expect(
        this.DesktopSyncUpload._reconcileFromZip(
          this.userId,
          this.projectId,
          '/tmp/zip.zip'
        )
      ).to.be.rejectedWith(ArchiveErrors.EmptyZipFileError)

      expect(this.deletedPaths()).to.deep.equal([])
      expect(this.UpdateMerger.promises._mergeUpdate.called).to.equal(false)
    })
  })

  describe('_pruneEmptyFolders', function () {
    it('never deletes the root folder', async function () {
      // 根目录的 path 是 '/'，早期实现用 `!folder.path` 判断，导致根目录被删
      this.entities.docs = []
      this.entities.files = []
      this.entities.folders = [
        { path: '/', folder: { _id: 'root' } },
        { path: '/contents', folder: { _id: 'sub' } },
        { path: '/contents/chapter', folder: { _id: 'subsub' } },
      ]

      await this.DesktopSyncUpload._pruneEmptyFolders(
        this.projectId,
        this.userId
      )

      expect(this.deletedPaths()).to.deep.equal([
        '/contents/chapter',
        '/contents',
      ])
      expect(this.deletedPaths()).to.not.include('/')
    })
  })

  // FIXED: 2026-11-11 新增。_reconcileFromDirectory 是从 _reconcileFromZip 抽出的
  // 核心对账逻辑，「回滚到某版本」直接复用它（快照目录 → 覆盖项目），
  // 所以它本身必须有独立覆盖，不能只靠 zip 那条路径间接验证。
  describe('_reconcileFromDirectory', function () {
    it('deletes entities missing from the source directory', async function () {
      this.entities.docs = [
        { path: '/main.tex', doc: { _id: 'doc-1' } },
        { path: '/gone.tex', doc: { _id: 'doc-2' } },
      ]
      this.entities.folders = [{ path: '/', folder: { _id: 'root' } }]
      this.readdirResult = [dirent('main.tex', 'file')]

      await this.DesktopSyncUpload._reconcileFromDirectory(
        this.userId,
        this.projectId,
        '/tmp/snapshot'
      )

      expect(this.deletedPaths()).to.deep.equal(['/gone.tex'])
    })

    it('refuses an empty directory instead of emptying the project', async function () {
      this.entities.docs = [{ path: '/main.tex', doc: { _id: 'doc-1' } }]
      this.entities.folders = [{ path: '/', folder: { _id: 'root' } }]
      this.readdirResult = [dirent('.DS_Store', 'file')]

      await expect(
        this.DesktopSyncUpload._reconcileFromDirectory(
          this.userId,
          this.projectId,
          '/tmp/snapshot'
        )
      ).to.be.rejectedWith(ArchiveErrors.EmptyZipFileError)

      expect(this.deletedPaths()).to.deep.equal([])
    })

    it('walks nested directories and keeps their files', async function () {
      this.entities.docs = [{ path: '/chapters/intro.tex', doc: { _id: 'd1' } }]
      this.entities.folders = [
        { path: '/', folder: { _id: 'root' } },
        { path: '/chapters', folder: { _id: 'sub' } },
      ]
      // 根目录先返回子目录，子目录再返回文件
      this.fsPromises.readdir = sinon.stub().callsFake(async dirPath => {
        if (dirPath === '/tmp/snapshot') {
          return [dirent('chapters', 'dir')]
        }
        return [dirent('intro.tex', 'file')]
      })

      await this.DesktopSyncUpload._reconcileFromDirectory(
        this.userId,
        this.projectId,
        '/tmp/snapshot'
      )

      // 嵌套文件在期望集里，因此不能被当作"缺失"删除
      expect(this.deletedPaths()).to.deep.equal([])
    })
  })
})
