import { expect } from 'chai'

import {
  collectMentionFiles,
  filterMentionFiles,
  getMentionQuery,
  removeMentionToken,
  isMentionableFile,
  fileExtOf,
  MAX_MENTION_FILES,
  MENTION_FILE_EXTS,
} from '@/features/ai-chat/utils/mention-files'

describe('ai-chat mention-files', function () {
  describe('collectMentionFiles', function () {
    it('收集嵌套目录里的源文件，路径带目录', function () {
      const files = collectMentionFiles({
        name: 'root',
        docs: [{ name: 'main.tex' }],
        folders: [
          {
            name: 'chapters',
            docs: [{ name: 'intro.tex' }, { name: 'methods.tex' }],
            folders: [{ name: 'deep', docs: [{ name: 'x.tex' }] }],
          },
        ],
        // 上传的二进制（fileRefs）不参与 @
        fileRefs: [{ name: 'figure.png' }],
      })
      expect(files.map(f => f.path)).to.deep.equal([
        'chapters/deep/x.tex',
        'chapters/intro.tex',
        'chapters/methods.tex',
        'main.tex',
      ])
      expect(files.find(f => f.path === 'main.tex')?.name).to.equal('main.tex')
    })

    it('文件树还没加载时不抛异常', function () {
      expect(collectMentionFiles(undefined)).to.deep.equal([])
      expect(collectMentionFiles(null)).to.deep.equal([])
      expect(collectMentionFiles({})).to.deep.equal([])
    })

    // FIXED: 2026-11-18 @ 只列白名单里的文本源文件
    it('只列白名单内的扩展名（按需求给定的列表）', function () {
      const allowed = [
        'a.tex',
        'a.sty',
        'a.cls',
        'a.def',
        'a.cfg',
        'a.clo',
        'a.fd',
        'a.dtx',
        'a.ins',
        'a.ltx',
        'a.bib',
        'a.bst',
        'a.bbx',
        'a.cbx',
        'a.lbx',
        'a.ist',
        'a.ldf',
        'a.md',
        'a.txt',
        'a.rst',
      ]
      const blocked = [
        'logo.png',
        'paper.pdf',
        'main.log',
        'main.aux',
        'main.synctex.gz',
        '.latexmkrc',
        'Makefile',
        'notes.markdown',
        'main.texin',
      ]
      const files = collectMentionFiles({
        name: 'root',
        docs: [...allowed, ...blocked].map(name => ({ name })),
      })
      // collectMentionFiles 按路径排序，这里只比集合内容
      expect(files.map(f => f.name).sort()).to.deep.equal([...allowed].sort())
    })

    it('扩展名大小写不敏感', function () {
      const files = collectMentionFiles({
        name: 'root',
        docs: [{ name: 'MAIN.TEX' }, { name: 'Refs.BIB' }],
      })
      expect(files.map(f => f.name)).to.deep.equal(['MAIN.TEX', 'Refs.BIB'])
    })

    it('白名单本身没有重复项', function () {
      expect(new Set(MENTION_FILE_EXTS).size).to.equal(MENTION_FILE_EXTS.length)
      expect(MENTION_FILE_EXTS.every(ext => ext.startsWith('.'))).to.equal(true)
      expect(MENTION_FILE_EXTS.length).to.equal(20)
    })

    // FIXED: 2026-11-18 上传文件（fileRef）里属于文本源文件的也要能 @
    it('上传文件里白名单扩展名的也收，并标记 source=file', function () {
      const files = collectMentionFiles({
        name: 'project',
        docs: [{ name: 'main.tex' }],
        fileRefs: [
          { name: 'README.md' },
          { name: 'NOTES.txt' },
          { name: 'logo.png' },
          { name: 'paper.pdf' },
        ],
      })
      expect(files.map(f => `${f.path}:${f.source}`)).to.deep.equal([
        'main.tex:doc',
        'NOTES.txt:file',
        'README.md:file',
      ])
    })

    it('同一路径 doc 与 file 同时出现时优先 doc', function () {
      const files = collectMentionFiles({
        name: 'project',
        docs: [{ name: 'README.md' }],
        fileRefs: [{ name: 'README.md' }],
      })
      expect(files.length).to.equal(1)
      expect(files[0].source).to.equal('doc')
    })

    it('isMentionableFile / fileExtOf', function () {
      expect(isMentionableFile('chapters/intro.tex')).to.equal(true)
      expect(isMentionableFile('CH1.RST')).to.equal(true)
      expect(isMentionableFile('figure.png')).to.equal(false)
      expect(isMentionableFile('.latexmkrc')).to.equal(false)
      expect(isMentionableFile('')).to.equal(false)
      expect(fileExtOf('a/b/c.STY')).to.equal('.sty')
      expect(fileExtOf('.latexmkrc')).to.equal('')
      expect(fileExtOf('noext')).to.equal('')
    })
  })

  describe('getMentionQuery', function () {
    it('行首/空白后的 @ 触发', function () {
      expect(getMentionQuery('@', 1)).to.deep.equal({ start: 0, query: '' })
      expect(getMentionQuery('看下 @main', 8)).to.deep.equal({
        start: 3,
        query: 'main',
      })
    })

    it('光标不在 @ 词里时返回 null', function () {
      expect(getMentionQuery('hello', 5)).to.equal(null)
      expect(getMentionQuery('@main.tex 后面的字', 14)).to.equal(null)
      expect(getMentionQuery('', 0)).to.equal(null)
    })

    it('邮箱里的 @ 不触发', function () {
      expect(getMentionQuery('{{EMAIL_pf2kkk3m}}', 21)).to.equal(null)
    })

    it('查询词过长时放弃提示', function () {
      const long = '@' + 'a'.repeat(200)
      expect(getMentionQuery(long, long.length)).to.equal(null)
    })
  })

  describe('filterMentionFiles', function () {
    const files = [
      { path: 'main.tex', name: 'main.tex' },
      { path: 'chapters/main.tex', name: 'main.tex' },
      { path: 'chapters/intro.tex', name: 'intro.tex' },
      { path: 'refs.bib', name: 'refs.bib' },
    ]

    it('空查询返回前几个', function () {
      expect(filterMentionFiles(files, '').length).to.equal(files.length)
      expect(filterMentionFiles(files, '', 2).length).to.equal(2)
    })

    it('文件名前缀优先于路径包含，同分短路径优先', function () {
      const out = filterMentionFiles(files, 'main')
      expect(out[0].path).to.equal('main.tex')
      expect(out[1].path).to.equal('chapters/main.tex')
    })

    it('不区分大小写', function () {
      expect(filterMentionFiles(files, 'REFS').map(f => f.path)).to.deep.equal([
        'refs.bib',
      ])
    })

    it('没有匹配时返回空数组', function () {
      expect(filterMentionFiles(files, 'zzz')).to.deep.equal([])
    })
  })

  describe('removeMentionToken', function () {
    it('去掉 @路径 并收掉多余空格', function () {
      expect(removeMentionToken('看下 @main.tex 这段', 'main.tex')).to.equal(
        '看下 这段'
      )
    })

    it('没出现时不改动文本', function () {
      expect(removeMentionToken('随便一句话', 'main.tex')).to.equal('随便一句话')
    })
  })

  it('MAX_MENTION_FILES 与后端口径一致（8）', function () {
    expect(MAX_MENTION_FILES).to.equal(8)
  })
})
