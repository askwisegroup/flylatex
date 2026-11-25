const { Readable } = require('stream')
const sinon = require('sinon')
const { expect } = require('chai')
const SandboxedModule = require('sandboxed-module')
const path = require('path')
const crypto = require('crypto')

const modulePath = '../../../../app/src/Features/DesktopSync/DesktopSyncApi.js'
const moduleDir = path.dirname(require.resolve(modulePath))
// sandboxed-module 对 relative require 的注入同时支持相对键与绝对键，
// 这里统一用解析后的绝对路径，避免不同版本行为差异。
const srcPath = relativePath => path.resolve(moduleDir, relativePath)

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function streamOf(text) {
  return Readable.from([Buffer.from(text, 'utf8')])
}

// 注意：mocha 传给 hook 与 test 的上下文不是同一个对象，
// 所以「会被测试重新赋值」的状态必须放在模块级共享对象里，不能挂 this。
const state = {}

describe('DesktopSyncApi', function () {
  beforeEach(function () {
    this.projectId = 'project-id'
    this.userId = 'user-id'

    state.docs = {}
    state.files = {}
    state.tags = []
    state.project = {
      name: 'My Paper',
      lastUpdated: new Date('2026-04-26T00:00:00Z'),
      rootDoc_id: 'doc-1',
      compiler: 'xelatex',
      owner_ref: 'owner-id',
    }

    this.ProjectGetter = {
      promises: {
        getProject: sinon.stub().callsFake(async () => state.project),
      },
    }
    this.ProjectEntityHandler = {
      promises: {
        getAllDocs: sinon.stub().callsFake(async () => state.docs),
        getAllFiles: sinon.stub().callsFake(async () => state.files),
      },
    }
    this.FileStoreHandler = {
      promises: {
        getFileStream: sinon.stub().resolves(streamOf('file-bytes')),
      },
    }
    this.CompileManager = { compile: sinon.stub() }
    this.ClsiManager = {
      promises: { getOutputFileStream: sinon.stub() },
    }
    this.ProjectOptionsHandler = {
      promises: { setCompiler: sinon.stub().resolves() },
    }
    this.TagsHandler = {
      promises: {
        getTagsForProject: sinon.stub().callsFake(async () => state.tags),
        createTag: sinon.stub(),
        addProjectToTag: sinon.stub(),
        removeProjectFromTag: sinon.stub().resolves(),
      },
    }
    this.CompileController = {
      downloadPdf: sinon.stub(),
      getFileFromClsi: sinon.stub(),
    }

    // 相对键与绝对键同时注入：仓库里的 sandboxed-module 是 Overleaf fork，
    // 不同版本对 key 的匹配方式不同，两套都提供最稳。
    const mocks = {
      '../../infrastructure/RateLimiter': {
        RateLimiter: class {
          constructor() {
            this.consume = sinon.stub().resolves()
          }
        },
      },
      '../Project/ProjectGetter': this.ProjectGetter,
      '../Project/ProjectEntityHandler': this.ProjectEntityHandler,
      '../Project/ProjectOptionsHandler': this.ProjectOptionsHandler,
      '../Tags/TagsHandler': this.TagsHandler,
      '../FileStore/FileStoreHandler': this.FileStoreHandler,
      '../Compile/CompileManager': this.CompileManager,
      '../Compile/ClsiManager': this.ClsiManager,
      '../Compile/CompileController': this.CompileController,
      '../Authentication/SessionManager': {
        getLoggedInUserId: () => 'user-id',
      },
      '../Errors/Errors': {
        NotFoundError: class NotFoundError extends Error {},
      },
      './DesktopSyncLastModified': {
        toMillis: d => (d ? new Date(d).getTime() : 0),
      },
    }
    const requires = {
      '@overleaf/promise-utils': { expressify: fn => fn },
      '@overleaf/logger': {
        warn: sinon.stub(),
        err: sinon.stub(),
        debug: sinon.stub(),
        info: sinon.stub(),
      },
    }
    for (const [request, mock] of Object.entries(mocks)) {
      requires[request] = mock
      requires[srcPath(request)] = mock
    }

    this.DesktopSyncApi = SandboxedModule.require(modulePath, { requires })
  })

  describe('parseLatexLog', function () {
    it('extracts TeX errors with line numbers', function () {
      const log = [
        'This is pdfTeX, Version 3.141592653',
        '(./main.tex',
        '! Undefined control sequence.',
        'l.12 \\foo',
        '                {bar}',
        '',
        './main.tex:20: LaTeX Error: Environment itemize undefined.',
        '',
        "LaTeX Warning: Reference `fig1' on input line 30 undefined.",
        '',
        '! Emergency stop.',
        'l.99 ',
      ].join('\n')

      const entries = this.DesktopSyncApi.parseLatexLog(log)

      expect(entries).to.deep.include({
        level: 'error',
        message: 'Undefined control sequence.',
        file: null,
        line: 12,
      })
      expect(entries).to.deep.include({
        level: 'error',
        message: 'LaTeX Error: Environment itemize undefined.',
        file: 'main.tex',
        line: 20,
      })
      expect(entries).to.deep.include({
        level: 'error',
        message: 'Emergency stop.',
        file: null,
        line: 99,
      })
      expect(entries).to.deep.include({
        level: 'warning',
        message: "Reference `fig1' undefined.",
        file: null,
        line: 30,
      })
    })

    it('deduplicates identical entries and caps the list', function () {
      const log = Array.from({ length: 200 }, () => '! Same error.\nl.1 ').join(
        '\n'
      )
      const entries = this.DesktopSyncApi.parseLatexLog(log)
      expect(entries).to.have.length(1)
    })

    it('reports missing font characters as warnings', function () {
      // FIXED: 2026-11-11 缺字不会让 latexmk 失败，必须靠日志解析暴露出来。
      const log = [
        'This is XeTeX, Version 3.141592653',
        'Missing character: There is no 浥 (U+6D65) in font [FandolSong-Regular.otf]/OT:s',
        'Missing character: There is no 浥 (U+6D65) in font [FandolSong-Regular.otf]/OT:s',
        'Missing character: There is no 篲 (U+7BF2) in font [FandolSong-Regular.otf]/OT:s',
      ].join('\n')

      const entries = this.DesktopSyncApi.parseLatexLog(log)

      expect(entries).to.have.length(2)
      expect(entries[0]).to.deep.equal({
        level: 'warning',
        message:
          'Missing character: "浥" (U+6D65) not found in font [FandolSong-Regular.otf]/OT:s',
        file: null,
        line: null,
      })
    })
  })

  describe('getMeta', function () {
    it('returns project metadata and the root doc path', async function () {
      state.docs = {
        '/chapters/intro.tex': { _id: 'doc-2', lines: [] },
        '/main.tex': { _id: 'doc-1', lines: [] },
      }
      const req = { params: { project_id: 'project-id' } }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.getMeta(req, res)

      expect(res.json).to.have.been.calledWith({
        id: 'project-id',
        name: 'My Paper',
        lastModified: state.project.lastUpdated.getTime(),
        rootDoc: 'main.tex',
        compiler: 'xelatex',
        owner: 'owner-id',
        tags: [],
      })
    })
  })

  describe('setCompiler', function () {
    it('persists a valid compiler', async function () {
      const req = {
        params: { project_id: 'project-id' },
        body: { compiler: 'XeLaTeX' },
        session: {},
      }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.setCompiler(req, res)

      expect(
        this.ProjectOptionsHandler.promises.setCompiler
      ).to.have.been.calledWith('project-id', 'xelatex')
      expect(res.json).to.have.been.calledWith({ compiler: 'xelatex' })
    })

    it('rejects an unsupported compiler', async function () {
      const req = {
        params: { project_id: 'project-id' },
        body: { compiler: 'tectonic' },
        session: {},
      }
      const res = { status: sinon.stub().returnsThis(), json: sinon.stub() }

      await this.DesktopSyncApi.setCompiler(req, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(this.ProjectOptionsHandler.promises.setCompiler).not.to.have.been
        .called
    })
  })

  describe('tags', function () {
    const tag = {
      _id: '507f1f77bcf86cd799439011',
      name: '测试',
      color: '#ff0000',
    }

    it('lists tags for the current user', async function () {
      state.tags = [tag]
      const req = { params: { project_id: 'project-id' }, session: {} }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.listProjectTags(req, res)

      expect(res.json).to.have.been.calledWith({
        tags: [{ id: tag._id, name: '测试', color: '#ff0000' }],
      })
    })

    it('creates a tag if needed and adds the project to it', async function () {
      state.tags = [tag]
      this.TagsHandler.promises.createTag.resolves(tag)
      this.TagsHandler.promises.addProjectToTag.resolves(tag)
      const req = {
        params: { project_id: 'project-id' },
        body: { name: ' 测试 ', color: '#ff0000' },
        session: {},
      }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.addProjectTag(req, res)

      expect(this.TagsHandler.promises.createTag).to.have.been.calledWith(
        'user-id',
        '测试',
        '#ff0000'
      )
      expect(this.TagsHandler.promises.addProjectToTag).to.have.been.calledWith(
        'user-id',
        tag._id,
        'project-id'
      )
      expect(res.json.firstCall.args[0].tag).to.deep.equal({
        id: tag._id,
        name: '测试',
        color: '#ff0000',
      })
    })

    it('rejects a tag name longer than 50 characters', async function () {
      const req = {
        params: { project_id: 'project-id' },
        body: { name: 'x'.repeat(51) },
        session: {},
      }
      const res = { status: sinon.stub().returnsThis(), json: sinon.stub() }

      await this.DesktopSyncApi.addProjectTag(req, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(this.TagsHandler.promises.createTag).not.to.have.been.called
    })

    it('removes a tag from the project', async function () {
      const req = {
        params: { project_id: 'project-id', tag_id: tag._id },
        session: {},
      }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.removeProjectTag(req, res)

      expect(
        this.TagsHandler.promises.removeProjectFromTag
      ).to.have.been.calledWith('user-id', tag._id, 'project-id')
      expect(res.json).to.have.been.calledWith({ tags: [] })
    })

    it('rejects an invalid tag id', async function () {
      const req = {
        params: { project_id: 'project-id', tag_id: 'not-an-object-id' },
        session: {},
      }
      const res = { status: sinon.stub().returnsThis(), json: sinon.stub() }

      await this.DesktopSyncApi.removeProjectTag(req, res)

      expect(res.status).to.have.been.calledWith(400)
      expect(this.TagsHandler.promises.removeProjectFromTag).not.to.have.been
        .called
    })
  })

  describe('getManifest', function () {
    beforeEach(function () {
      state.docs = {
        '/main.tex': { _id: 'doc-1', lines: ['hello', 'world'] },
      }
      state.files = {
        '/figures/plot.png': { _id: 'file-1' },
      }
    })

    it('returns paths only when hashes are not requested', async function () {
      const req = { params: { project_id: 'project-id' }, query: {} }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.getManifest(req, res)

      const body = res.json.firstCall.args[0]
      expect(body.hashes).to.equal(false)
      expect(body.entries).to.deep.equal([
        { path: 'figures/plot.png', type: 'file' },
        { path: 'main.tex', type: 'doc' },
      ])
      expect(this.FileStoreHandler.promises.getFileStream).not.to.have.been
        .called
    })

    it('returns sha256 hashes matching the zipped bytes', async function () {
      const req = {
        params: { project_id: 'project-id' },
        query: { hash: '1' },
      }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.getManifest(req, res)

      const body = res.json.firstCall.args[0]
      const doc = body.entries.find(entry => entry.path === 'main.tex')
      const file = body.entries.find(entry => entry.path === 'figures/plot.png')
      expect(doc.sha256).to.equal(sha256('hello\nworld'))
      expect(doc.size).to.equal(Buffer.byteLength('hello\nworld'))
      expect(file.sha256).to.equal(sha256('file-bytes'))
      expect(file.size).to.equal(Buffer.byteLength('file-bytes'))
    })
  })

  describe('compile', function () {
    beforeEach(function () {
      this.log = [
        '(./main.tex',
        './main.tex:7: Undefined control sequence.',
        '! Emergency stop.',
        'l.9 ',
      ].join('\n')
      this.CompileManager.compile.callsFake(
        (projectId, userId, options, callback) =>
          callback(
            null,
            'success',
            [
              { path: 'output.pdf', type: 'pdf', build: 'build-1' },
              { path: 'output.log', type: 'log', build: 'build-1' },
            ],
            'clsi-1',
            { compileGroup: 'standard', compileBackendClass: 'default' },
            null,
            { latexmk: 1 },
            { compile: 1000 }
          )
      )
      this.CompileManager.deleteAuxFiles = sinon
        .stub()
        .callsFake((projectId, userId, clsiServerId, callback) => callback())
      this.ClsiManager.promises.getOutputFileStream.resolves(streamOf(this.log))
    })

    it('returns status, errors and log tail', async function () {
      const req = {
        params: { project_id: 'project-id' },
        session: {},
        body: { stopOnFirstError: true },
      }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.compile(req, res)

      const body = res.json.firstCall.args[0]
      expect(body.status).to.equal('success')
      expect(body.buildId).to.equal('build-1')
      expect(body.outputs).to.deep.equal([
        { path: 'output.pdf', type: 'pdf', build: 'build-1' },
        { path: 'output.log', type: 'log', build: 'build-1' },
      ])
      expect(body.errors).to.have.length(2)
      expect(body.log).to.equal(this.log)
      expect(body.logTruncated).to.equal(false)
      expect(this.CompileManager.compile.firstCall.args[2]).to.include({
        stopOnFirstError: true,
        fileLineErrors: true,
      })
    })

    it('cleans aux files before compiling when clean is true', async function () {
      const req = {
        params: { project_id: 'project-id' },
        session: {},
        body: { clean: true },
      }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.compile(req, res)

      expect(this.CompileManager.deleteAuxFiles).to.have.been.calledBefore(
        this.CompileManager.compile
      )
      expect(this.CompileManager.deleteAuxFiles).to.have.been.calledWith(
        'project-id',
        'user-id'
      )
    })

    it('still returns the compile status when the log is unavailable', async function () {
      this.ClsiManager.promises.getOutputFileStream.rejects(new Error('boom'))
      const req = {
        params: { project_id: 'project-id' },
        session: {},
        body: {},
      }
      const res = { json: sinon.stub() }

      await this.DesktopSyncApi.compile(req, res)

      const body = res.json.firstCall.args[0]
      expect(body.status).to.equal('success')
      expect(body.log).to.equal(null)
      expect(body.errors).to.deep.equal([])
    })
  })
})
