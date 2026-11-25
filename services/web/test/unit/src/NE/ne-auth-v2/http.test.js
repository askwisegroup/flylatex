const { expect } = require('chai')
const http = require('http')
const { request } = require('../../../../../commercial/ne-auth-v2/http')

describe('ne-auth-v2/http failure recovery', function () {
  let server
  async function serve(handler) {
    server = http.createServer(handler)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return `http://127.0.0.1:${server.address().port}/test`
  }
  afterEach(async function () {
    if (server.closeAllConnections) server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  async function failure(promise) {
    try {
      await promise
    } catch (error) {
      return error
    }
    throw new Error('Expected request to fail')
  }
  it('rejects an interrupted response instead of leaving the request pending', async function () {
    const url = await serve((req, res) => {
      res.writeHead(200, { 'Content-Length': 100 })
      res.write('partial')
      setTimeout(() => res.destroy(), 10)
    })
    const error = await failure(request('GET', url, { timeoutMs: 200 }))
    expect(error.message).to.match(/interrupted|incomplete|aborted/)
  })
  it('bounds the total duration even while response bytes keep arriving', async function () {
    const url = await serve((req, res) => {
      res.writeHead(200)
      res.write('start')
      const timer = setInterval(() => res.write('.'), 10)
      res.on('close', () => clearInterval(timer))
    })
    const error = await failure(request('GET', url, { timeoutMs: 50 }))
    expect(error.message).to.match(/50ms/)
  })
  it('rejects oversized responses', async function () {
    const url = await serve((req, res) => res.end('123456789'))
    const error = await failure(request('GET', url, { maxBodyBytes: 4 }))
    expect(error.message).to.match(/size limit/)
  })
  it('keeps the complete response contract', async function () {
    const url = await serve((req, res) => res.end('{"code":0}'))
    const response = await request('GET', url)
    expect(response.status).to.equal(200)
    expect(response.body).to.equal('{"code":0}')
  })
})
