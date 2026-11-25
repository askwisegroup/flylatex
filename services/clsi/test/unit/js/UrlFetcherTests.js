const Path = require('path')
const { Readable, Writable } = require('stream')
const SandboxedModule = require('sandboxed-module')
const sinon = require('sinon')
const { expect } = require('chai')

const MODULE_PATH = Path.join(__dirname, '../../../app/js/UrlFetcher')

// 覆盖分离模式（web + clsi 两个容器）下的两个必踩坑：
//   ① clsi 里的 localhost 不再是 web → 资源 URL 的 host 必须被重写
//   ② production settings 里可能没有 apis.clsiPerf（原代码直接取 .host 会崩）
describe('UrlFetcher', function () {
  beforeEach(function () {
    this.Settings = {}
    delete process.env.FILESTORE_DOMAIN_OVERRIDE

    this.fetchStream = sinon.stub().resolves(Readable.from([Buffer.from('x')]))
    this.fs = {
      createWriteStream: () =>
        new Writable({
          write(chunk, encoding, callback) {
            callback()
          },
        }),
      promises: {
        rename: sinon.stub().resolves(),
        unlink: sinon.stub().resolves(),
      },
    }

    this.UrlFetcher = SandboxedModule.require(MODULE_PATH, {
      requires: {
        '@overleaf/logger': { warn: sinon.stub(), error: sinon.stub() },
        '@overleaf/settings': this.Settings,
        '@overleaf/fetch-utils': { fetchStream: this.fetchStream },
        fs: this.fs,
        // sandboxed-module 无法自行解析带斜杠的内置模块名，显式透传真实实现
        'stream/promises': require('stream/promises'),
      },
      // 沙箱里没有 AbortSignal 全局（UrlFetcher 用它做下载超时），显式传入
      globals: { AbortSignal },
    })
  })

  afterEach(function () {
    delete process.env.FILESTORE_DOMAIN_OVERRIDE
  })

  async function fetch(url) {
    await this.UrlFetcher.promises.pipeUrlToFileWithRetry(
      url,
      '/tmp/url-fetcher-test~'
    )
    return this.fetchStream.firstCall.args[0]
  }

  it('downloads from the original url by default', async function () {
    const url = 'http://localhost:3009/project/p1/file/f1'
    expect(await fetch.call(this, url)).to.equal(url)
  })

  it('rewrites the host when FILESTORE_DOMAIN_OVERRIDE is set (split mode)', async function () {
    process.env.FILESTORE_DOMAIN_OVERRIDE = 'http://sharelatex:3009'
    const url = 'http://localhost:3009/project/p1/file/f1?cacheBust=1'
    expect(await fetch.call(this, url)).to.equal(
      'http://sharelatex:3009/project/p1/file/f1?cacheBust=1'
    )
  })

  it('does not throw when apis.clsiPerf is missing from settings', async function () {
    process.env.FILESTORE_DOMAIN_OVERRIDE = 'http://sharelatex:3009'
    // 生产 settings 里可能没有 apis / clsiPerf，原代码在这里会抛 TypeError
    expect(this.Settings.apis).to.equal(undefined)
    const url = 'http://localhost:3009/project/p1/file/f1'
    expect(await fetch.call(this, url)).to.equal(
      'http://sharelatex:3009/project/p1/file/f1'
    )
  })

  it('leaves the url alone when it already points at the clsiPerf host', async function () {
    this.Settings.filestoreDomainOveride = 'http://sharelatex:3009'
    this.Settings.apis = { clsiPerf: { host: 'perf.internal:3009' } }
    const url = 'http://perf.internal:3009/project/p1/file/f1'
    expect(await fetch.call(this, url)).to.equal(url)
  })
})
