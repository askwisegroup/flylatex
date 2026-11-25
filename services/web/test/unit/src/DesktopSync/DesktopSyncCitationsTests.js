const sinon = require('sinon')
const { expect } = require('chai')
const SandboxedModule = require('sandboxed-module')
const path = require('path')

const modulePath =
  '../../../../app/src/Features/DesktopSync/DesktopSyncCitations.js'
const moduleDir = path.dirname(require.resolve(modulePath))
const srcPath = relativePath => path.resolve(moduleDir, relativePath)

describe('DesktopSyncCitations', function () {
  // 模块级状态：mocha 的 hook 与 test 拿到的上下文不是同一个对象
  const state = {}

  beforeEach(function () {
    state.docs = {}
    state.project = { name: 'My Paper', rootDoc_id: 'doc-1' }

    this.ProjectGetter = {
      promises: {
        getProject: sinon.stub().callsFake(async () => state.project),
      },
    }
    this.ProjectEntityHandler = {
      promises: {
        getAllEntities: sinon.stub().callsFake(async () => ({
          docs: Object.entries(state.docs).map(([docPath, doc]) => ({
            path: docPath,
            doc: { _id: doc.id },
          })),
          files: [],
          folders: [],
        })),
        getDoc: sinon.stub().callsFake(async (projectId, docId) => {
          const match = Object.values(state.docs).find(
            doc => String(doc.id) === String(docId)
          )
          return { lines: (match && match.lines) || [] }
        }),
      },
    }
    this.EditorController = {
      promises: {
        upsertDocWithPath: sinon.stub().resolves({ doc: { _id: 'x' } }),
      },
    }

    const mocks = {
      '../Project/ProjectGetter': this.ProjectGetter,
      '../Project/ProjectEntityHandler': this.ProjectEntityHandler,
      '../Editor/EditorController': this.EditorController,
      '../Authentication/SessionManager': {
        getLoggedInUserId: () => 'user-id',
      },
      '../Errors/Errors': {
        NotFoundError: class NotFoundError extends Error {},
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

    this.Citations = SandboxedModule.require(modulePath, { requires })
    this.utils = this.Citations._internals
  })

  afterEach(function () {
    sinon.restore()
  })

  const he2016 = {
    title: 'Deep Residual Learning for Image Recognition',
    authors: ['Kaiming He', 'Xiangyu Zhang'],
    year: '2016',
    venue: 'CVPR',
    doi: '10.1109/CVPR.2016.90',
    type: 'conference',
  }

  describe('makeCiteKey', function () {
    it('uses first author surname plus year', function () {
      expect(this.utils.makeCiteKey(he2016, [he2016])).to.equal('he2016')
    })

    it('adds letter suffixes when author and year collide', function () {
      const first = { ...he2016, title: 'A' }
      const second = { ...he2016, title: 'B' }
      const siblings = [first, second]
      expect(this.utils.makeCiteKey(first, siblings)).to.equal('he2016a')
      expect(this.utils.makeCiteKey(second, siblings)).to.equal('he2016b')
    })

    it('does not suffix when only one item matches', function () {
      const other = { authors: ['Ashish Vaswani'], year: '2017', title: 'B' }
      expect(this.utils.makeCiteKey(he2016, [he2016, other])).to.equal('he2016')
    })

    it('falls back to title when no authors are available', function () {
      expect(
        this.utils.makeCiteKey({ title: 'Anonymous Report', year: '2020' }, [])
      ).to.equal('anonymousrep2020')
    })
  })

  describe('makeBibtexEntry', function () {
    it('emits inproceedings with booktitle for conference items', function () {
      const entry = this.utils.makeBibtexEntry(he2016, 'he2016')
      expect(entry).to.include('@inproceedings{he2016,')
      expect(entry).to.include('author = {Kaiming He and Xiangyu Zhang}')
      expect(entry).to.include('booktitle = {CVPR}')
      expect(entry).to.include('doi = {10.1109/CVPR.2016.90}')
    })

    it('emits article with journal for journal items', function () {
      const entry = this.utils.makeBibtexEntry(
        { ...he2016, type: 'journal-article' },
        'he2016'
      )
      expect(entry).to.include('@article{he2016,')
      expect(entry).to.include('journal = {CVPR}')
    })

    it('omits empty fields instead of writing blanks', function () {
      const entry = this.utils.makeBibtexEntry(
        { title: 'Only Title', authors: [], year: '' },
        'onlytitle'
      )
      expect(entry).to.not.include('author =')
      expect(entry).to.not.include('year =')
    })
  })

  describe('makeBibitem', function () {
    it('builds a thebibliography entry', function () {
      expect(this.utils.makeBibitem(he2016, 'he2016')).to.equal(
        '\\bibitem{he2016}\n' +
          'Kaiming He, Xiangyu Zhang. Deep Residual Learning for Image Recognition. ' +
          '\\textit{CVPR}, 2016.'
      )
    })
  })

  describe('key extraction', function () {
    it('pulls every entry key out of bib content', function () {
      const keys = this.utils.extractBibKeys(
        '@article{he2016,\n title={A}\n}\n\n@misc{vaswani2017,\n}'
      )
      expect([...keys]).to.deep.equal(['he2016', 'vaswani2017'])
    })

    it('finds bibitem keys and cite keys in the tex', function () {
      const tex = '\\cite{he2016,vaswani2017}\n\\bibitem{he2016}\nHe.'
      expect([...this.utils.extractBibitemKeys(tex)]).to.deep.equal(['he2016'])
      expect([...this.utils.extractCitedKeys(tex)]).to.deep.equal([
        'he2016',
        'vaswani2017',
      ])
    })

    it('handles optional cite arguments', function () {
      expect([
        ...this.utils.extractCitedKeys('\\citep[see][p.2]{knuth1984}'),
      ]).to.deep.equal(['knuth1984'])
    })
  })

  describe('insertCiteCommand', function () {
    it('inserts before \\end{document}', function () {
      const { text, citeCommand } = this.utils.insertCiteCommand(
        '\\section{A}\ntext\n\\end{document}',
        ['he2016']
      )
      expect(citeCommand).to.equal('\\cite{he2016}')
      expect(text).to.equal(
        '\\section{A}\ntext\n\\cite{he2016}\n\n\\end{document}'
      )
    })

    it('inserts after the anchor line when an anchor is given', function () {
      const { text } = this.utils.insertCiteCommand(
        '\\section{Intro}\nbody\n',
        ['he2016'],
        '\\section{Intro}'
      )
      expect(text).to.equal('\\section{Intro}\n\\cite{he2016}\nbody\n')
    })

    it('appends when there is no \\end{document}', function () {
      expect(
        this.utils.insertCiteCommand('plain text', ['he2016']).text
      ).to.include('\\cite{he2016}')
    })
  })

  describe('insertBibitems', function () {
    it('creates thebibliography before \\end{document} when absent', function () {
      const text = this.utils.insertBibitems(
        '\\section{A}\n\\end{document}',
        '\\bibitem{k}'
      )
      expect(text).to.include('% Bibliography')
      expect(text).to.include('\\begin{thebibliography}{99}')
      expect(text).to.include('\\bibitem{k}')
      expect(text.indexOf('\\end{thebibliography}')).to.be.lessThan(
        text.indexOf('\\end{document}')
      )
    })

    it('appends into the existing environment', function () {
      const text = this.utils.insertBibitems(
        '\\begin{thebibliography}{9}\n\\bibitem{x} X.\n\\end{thebibliography}\n\\end{document}',
        '\\bibitem{y} Y.'
      )
      expect(text).to.include('\\bibitem{x} X.')
      expect(text.indexOf('\\bibitem{y}')).to.be.lessThan(
        text.indexOf('\\end{thebibliography}')
      )
    })
  })

  describe('detectBibliographySetup', function () {
    it('detects \\bibliography and normalizes the file name', function () {
      const detected = this.utils.detectBibliographySetup(
        new Map([['/main.tex', { text: '\\bibliography{refs}' }]])
      )
      expect(detected.hasBibliography).to.be.true
      expect(detected.bibFileNames).to.deep.equal(['refs.bib'])
      expect(detected.directive).to.equal('bibliography')
    })

    it('detects biblatex \\addbibresource', function () {
      const detected = this.utils.detectBibliographySetup(
        new Map([['/main.tex', { text: '\\addbibresource{myrefs.bib}' }]])
      )
      expect(detected.hasBibliography).to.be.true
      expect(detected.bibFileNames).to.deep.equal(['myrefs.bib'])
      expect(detected.directive).to.equal('addbibresource')
    })

    it('reports no bibliography when absent', function () {
      expect(
        this.utils.detectBibliographySetup(
          new Map([['/main.tex', { text: '\\begin{document}' }]])
        ).hasBibliography
      ).to.be.false
    })
  })

  describe('cite handler', function () {
    function fakeRes() {
      return {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code
          return this
        },
        json(payload) {
          this.body = payload
          return this
        },
      }
    }

    it('rejects a request without references', async function () {
      const res = fakeRes()
      await this.Citations.cite({ params: { project_id: 'p' }, body: {} }, res)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.include('references')
    })

    it('rejects bibitem mode when the project uses \\bibliography', async function () {
      state.docs = {
        '/main.tex': {
          id: 'doc-1',
          lines: ['\\bibliography{refs}', '\\end{document}'],
        },
      }
      const res = fakeRes()
      await this.Citations.cite(
        {
          params: { project_id: 'p' },
          body: { references: [he2016], mode: 'bibitem' },
        },
        res
      )
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.include('\\bibliography')
    })

    it('writes bib entries and \\cite when \\bibliography exists', async function () {
      state.docs = {
        '/main.tex': {
          id: 'doc-1',
          lines: [
            '\\documentclass{article}',
            '\\bibliography{refs}',
            '\\end{document}',
          ],
        },
      }
      const res = fakeRes()
      await this.Citations.cite(
        { params: { project_id: 'p' }, body: { references: [he2016] } },
        res
      )

      expect(res.statusCode).to.equal(200)
      expect(res.body.mode).to.equal('bib')
      expect(res.body.bibFile).to.equal('/refs.bib')
      expect(res.body.wrote.bib.created).to.be.true
      expect(res.body.wrote.bib.addedCount).to.equal(1)
      expect(res.body.citeCommand).to.equal('\\cite{he2016}')

      const calls = this.EditorController.promises.upsertDocWithPath.args
      expect(calls).to.have.length(2)
      expect(calls[0][1]).to.equal('/refs.bib')
      expect(calls[0][2].join('\n')).to.include('@inproceedings{he2016,')
      expect(calls[1][1]).to.equal('/main.tex')
      expect(calls[1][2].join('\n')).to.include('\\cite{he2016}')
    })

    it('does not duplicate entries already present in the bib file', async function () {
      state.docs = {
        '/main.tex': { id: 'doc-1', lines: ['\\bibliography{refs}'] },
        '/refs.bib': {
          id: 'doc-2',
          lines: ['@inproceedings{he2016,', '  title = {Old}', '}'],
        },
      }
      const res = fakeRes()
      await this.Citations.cite(
        { params: { project_id: 'p' }, body: { references: [he2016] } },
        res
      )

      expect(res.body.wrote.bib.created).to.be.false
      expect(res.body.wrote.bib.addedCount).to.equal(0)
      expect(res.body.wrote.bib.duplicateCount).to.equal(1)
      // bib 无需追加时不写它，只写 tex
      expect(
        this.EditorController.promises.upsertDocWithPath.args
      ).to.have.length(1)
    })

    it('falls back to bibitem mode when there is no \\bibliography', async function () {
      state.docs = {
        '/main.tex': {
          id: 'doc-1',
          lines: [
            '\\documentclass{article}',
            '\\begin{document}',
            '\\end{document}',
          ],
        },
      }
      const res = fakeRes()
      await this.Citations.cite(
        { params: { project_id: 'p' }, body: { references: [he2016] } },
        res
      )

      expect(res.body.mode).to.equal('bibitem')
      const texLines =
        this.EditorController.promises.upsertDocWithPath.args[0][2].join('\n')
      expect(texLines).to.include('\\begin{thebibliography}{99}')
      expect(texLines).to.include('\\bibitem{he2016}')
      expect(texLines).to.include('\\cite{he2016}')
    })

    it('honours dryRun and writes nothing', async function () {
      state.docs = {
        '/main.tex': {
          id: 'doc-1',
          lines: ['\\begin{document}\\end{document}'],
        },
      }
      const res = fakeRes()
      await this.Citations.cite(
        {
          params: { project_id: 'p' },
          body: { references: [he2016], dryRun: true },
        },
        res
      )

      expect(res.body.dryRun).to.be.true
      expect(this.EditorController.promises.upsertDocWithPath.called).to.be
        .false
    })
  })
})
