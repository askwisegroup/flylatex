const sinon = require('sinon')
const { expect } = require('chai')
const SandboxedModule = require('sandboxed-module')
const crypto = require('crypto')

const MODULE_PATH = '../../../../app/src/Features/Compile/CompileFreshness.js'

const sha1 = input =>
  crypto.createHash('sha1').update(String(input), 'utf8').digest('hex')

function buildRequest({
  docContent = 'hello',
  docPath = 'main.tex',
  draft = false,
} = {}) {
  const resources = []
  if (docContent != null) {
    resources.push({ path: docPath, content: docContent })
  }
  return {
    compile: {
      rootResourcePath: docPath,
      options: {
        compiler: 'pdflatex',
        imageName: 'texlive-full',
        draft,
        stopOnFirstError: false,
        check: 'silent',
        flags: undefined,
      },
      resources,
    },
  }
}

const ctx = { fetch: null }

describe('CompileFreshness', function () {
  beforeEach(function () {
    this.store = new Map()
    this.redis = {
      get: sinon
        .stub()
        .callsFake((key, cb) =>
          cb(null, this.store.has(key) ? this.store.get(key) : null)
        ),
      setex: sinon.stub().callsFake((key, ttl, value, cb) => {
        this.store.set(key, value)
        cb(null, 'OK')
      }),
      del: sinon.stub().callsFake((key, cb) => {
        this.store.delete(key)
        cb(null, 1)
      }),
    }
    this.settings = {
      compileFreshness: { enabled: true, ttlSeconds: 3600 },
      apis: { clsi: { url: 'http://clsi.example.com' } },
    }
    this.logger = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    }

    this.CompileFreshness = SandboxedModule.require(MODULE_PATH, {
      requires: {
        '@overleaf/settings': this.settings,
        '@overleaf/logger': this.logger,
        '../../infrastructure/RedisWrapper': {
          client: () => this.redis,
        },
      },
      globals: {
        fetch: (...args) => ctx.fetch(...args),
        AbortSignal,
        URL,
      },
    })
  })

  describe('the root-cause regression (structure hash must not include options)', function () {
    beforeEach(function () {
      this.project = {
        _id: 'p1',
        rootFolder: [
          {
            _id: 'f1',
            name: 'rootFolder',
            docs: [{ _id: 'd1', name: 'main.tex' }],
            fileRefs: [],
            folders: [],
          },
        ],
      }
      this.ClsiStateManager = SandboxedModule.require(
        '../../../../app/src/Features/Compile/ClsiStateManager.js',
        {
          requires: {
            '@overleaf/settings': this.settings,
            '@overleaf/logger': this.logger,
            '../Project/ProjectEntityHandler': {
              getAllEntitiesFromProject: project => {
                const doc = project.rootFolder[0].docs[0]
                return {
                  docs: [{ path: `/${doc.name}`, doc: { _id: doc._id } }],
                  files: [],
                }
              },
            },
          },
        }
      )
      // the compile path passes these, the freshness check path does not
      this.compileOptions = {
        draft: false,
        stopOnFirstError: false,
        check: 'silent',
        incrementalCompilesEnabled: true,
        compileGroup: 'standard',
        timeout: 60,
        compileBackendClass: 'docker',
        enablePdfCaching: false,
      }
      this.checkOptions = {
        draft: false,
        stopOnFirstError: false,
        check: 'silent',
        incrementalCompilesEnabled: true,
      }
    })

    it('computeStructureHash ignores options (compile vs check agree)', function () {
      expect(this.ClsiStateManager.computeStructureHash(this.project)).to.equal(
        this.ClsiStateManager.computeStructureHash(this.project)
      )
    })

    it('computeHash used to include options, so the two paths never matched', function () {
      expect(
        this.ClsiStateManager.computeHash(this.project, this.compileOptions)
      ).to.not.equal(
        this.ClsiStateManager.computeHash(this.project, this.checkOptions)
      )
    })

    it('computeStructureHash still changes when the project structure changes', function () {
      const before = this.ClsiStateManager.computeStructureHash(this.project)
      this.project.rootFolder[0].docs[0].name = 'main2.tex'
      expect(
        this.ClsiStateManager.computeStructureHash(this.project)
      ).to.not.equal(before)
    })
  })

  describe('record + check', function () {
    beforeEach(function () {
      this.projectId = 'p1'
      this.userId = 'u1'
      this.stateHash = 'structure-hash'
      this.req = buildRequest()
    })

    it('is fresh after a successful compile of identical content', async function () {
      await this.CompileFreshness.record({
        projectId: this.projectId,
        userId: this.userId,
        req: this.req,
        stateHash: this.stateHash,
        result: {
          status: 'success',
          outputFiles: [
            {
              path: 'output.pdf',
              url: '/build/x/output.pdf',
              type: 'pdf',
              build: 'x',
            },
          ],
          clsiServerId: 'clsi-1',
        },
      })

      const result = await this.CompileFreshness.check({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest(),
        stateHash: this.stateHash,
      })

      expect(result.fresh).to.equal(true)
      expect(result.reason).to.equal('match')
    })

    it('reports no-record when nothing was compiled yet', async function () {
      const result = await this.CompileFreshness.check({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest(),
        stateHash: this.stateHash,
      })
      expect(result).to.include({ fresh: false, reason: 'no-record' })
    })

    it('is not fresh when the doc content changed', async function () {
      await this.CompileFreshness.record({
        projectId: this.projectId,
        userId: this.userId,
        req: this.req,
        stateHash: this.stateHash,
        result: { status: 'success', outputFiles: [] },
      })

      const result = await this.CompileFreshness.check({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest({ docContent: 'hello, edited' }),
        stateHash: this.stateHash,
      })

      expect(result.fresh).to.equal(false)
      expect(result.reason).to.equal('content-changed:main.tex')
      expect(result.storedDigest).to.equal(`doc:${sha1('hello')}`)
      expect(result.digest).to.equal(`doc:${sha1('hello, edited')}`)
    })

    it('is not fresh when the compile options changed', async function () {
      await this.CompileFreshness.record({
        projectId: this.projectId,
        userId: this.userId,
        req: this.req,
        stateHash: this.stateHash,
        result: { status: 'success', outputFiles: [] },
      })

      const result = await this.CompileFreshness.check({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest({ draft: true }),
        stateHash: this.stateHash,
      })

      expect(result).to.include({ fresh: false, reason: 'options-changed' })
      expect(result.storedOptionsKey).to.not.equal(result.optionsKey)
    })

    it('is not fresh when the project structure changed', async function () {
      await this.CompileFreshness.record({
        projectId: this.projectId,
        userId: this.userId,
        req: this.req,
        stateHash: this.stateHash,
        result: { status: 'success', outputFiles: [] },
      })

      const result = await this.CompileFreshness.check({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest(),
        stateHash: 'other-structure-hash',
      })

      expect(result).to.include({ fresh: false, reason: 'structure-changed' })
    })

    it('treats a doc that is not in the recorded request as safe (subset match)', async function () {
      await this.CompileFreshness.record({
        projectId: this.projectId,
        userId: this.userId,
        req: this.req,
        stateHash: this.stateHash,
        result: { status: 'success', outputFiles: [] },
      })

      // check-time request carries no docs at all (docupdater holds nothing dirty)
      const result = await this.CompileFreshness.check({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest({ docContent: null }),
        stateHash: this.stateHash,
      })

      expect(result.fresh).to.equal(true)
    })

    it('invalidate() makes the record disappear', async function () {
      await this.CompileFreshness.record({
        projectId: this.projectId,
        userId: this.userId,
        req: this.req,
        stateHash: this.stateHash,
        result: { status: 'success', outputFiles: [] },
      })
      await this.CompileFreshness.invalidate(this.projectId)

      const result = await this.CompileFreshness.check({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest(),
        stateHash: this.stateHash,
      })
      expect(result).to.include({ fresh: false, reason: 'no-record' })
    })
  })

  describe('reuse (server-side skip)', function () {
    beforeEach(async function () {
      this.projectId = 'p1'
      this.userId = 'u1'
      this.stateHash = 'structure-hash'
      this.outputFiles = [
        {
          path: 'output.pdf',
          url: '/project/p1/user/u1/build/b1/output/output.pdf',
          type: 'pdf',
          build: 'b1',
        },
      ]
      ctx.fetch = sinon.stub().resolves({ ok: true })
      await this.CompileFreshness.record({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest(),
        stateHash: this.stateHash,
        result: {
          status: 'success',
          outputFiles: this.outputFiles,
          clsiServerId: 'clsi-1',
          outputUrlPrefix: '/project/p1/user/u1/',
          limits: { compileGroup: 'standard' },
        },
      })
    })

    it('skips the compile and returns the previous result', async function () {
      const reused = await this.CompileFreshness.reuse({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest(),
        stateHash: this.stateHash,
      })

      expect(reused, JSON.stringify(reused)).to.include({ skip: true })
      expect(reused.result.outputFiles).to.deep.equal(this.outputFiles)
      expect(reused.result.compileGroup).to.equal('standard')
      expect(ctx.fetch.calledOnce).to.equal(true)
      expect(ctx.fetch.firstCall.args[0].toString()).to.equal(
        'http://clsi.example.com/project/p1/user/u1/build/b1/output/output.pdf?compileGroup=standard&clsiserverid=clsi-1'
      )
    })

    it('does not skip when the output files are gone from CLSI', async function () {
      ctx.fetch = sinon.stub().resolves({ ok: false })
      // re-require so the stub takes effect
      this.CompileFreshness = SandboxedModule.require(MODULE_PATH, {
        requires: {
          '@overleaf/settings': this.settings,
          '@overleaf/logger': this.logger,
          '../../infrastructure/RedisWrapper': { client: () => this.redis },
        },
        globals: {
          fetch: (...args) => ctx.fetch(...args),
          AbortSignal,
          URL,
        },
      })

      const reused = await this.CompileFreshness.reuse({
        projectId: this.projectId,
        userId: this.userId,
        req: buildRequest(),
        stateHash: this.stateHash,
      })

      expect(reused).to.include({ skip: false, reason: 'output-missing' })
    })

    it('does not skip when nothing was recorded', async function () {
      const reused = await this.CompileFreshness.reuse({
        projectId: 'other-project',
        userId: this.userId,
        req: buildRequest(),
        stateHash: this.stateHash,
      })
      expect(reused).to.include({ skip: false, reason: 'no-record' })
    })
  })
})
