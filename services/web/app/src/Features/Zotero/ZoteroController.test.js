/**
 * Zotero OAuth 控制器的行为测试（重点是「不要一上来就 500」）。
 *
 * 线上踩过：oauthStart 里漏了 `const userId = ...`，重写时被删掉，
 * 点「用 Zotero 账号登录并授权」直接
 *    ReferenceError: userId is not defined → 500 Something went wrong
 * 这类错误 node --check 抓不到，只有真跑一遍才暴露。所以这里用打桩依赖把它跑起来。
 *
 * Run: cd services/web && node --test app/src/Features/Zotero/ZoteroController.test.js
 */

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('module')

const calls = { setex: [], saveCredentials: [], redirects: [] }
let currentUser = { _id: 'user-1' }
let oauthConfigured = true

const settingsValue = {
  siteUrl: 'https://www.example.com',
  security: { sessionSecret: 'test' },
  zotero: {
    apiUrl: 'https://api.zotero.org',
    timeoutMs: 1000,
    maxBibtexItems: 20,
    oauth: {
      clientKey: 'ck',
      clientSecret: 'cs',
      callbackUrl: 'https://www.example.com/api/zotero/oauth/callback',
    },
  },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const fromController =
    parent && parent.filename && parent.filename.endsWith('ZoteroController.js')
  if (!fromController) {
    return origLoad.call(this, request, parent, isMain)
  }

  if (request === '@overleaf/settings') return settingsValue
  if (request === '@overleaf/logger')
    return { warn() {}, info() {}, error() {} }
  if (request === '../../infrastructure/RedisWrapper') {
    return {
      client: () => ({
        setex: async (...args) => calls.setex.push(args),
        get: async () => null,
        del: async () => {},
      }),
    }
  }
  if (request.endsWith('Authentication/SessionManager')) {
    return { getSessionUser: () => currentUser }
  }
  if (request.endsWith('Authorization/AuthorizationManager')) {
    return { promises: { getPrivilegeLevelForProject: async () => 'owner' } }
  }
  if (request === './ZoteroOAuth1') {
    return {
      isConfigured: () => oauthConfigured,
      resolveConfig: () => settingsValue.zotero.oauth,
      getRequestToken: async () => ({
        token: 'req-token-123',
        secret: 'req-secret-456',
        authorizeUrl:
          'https://www.zotero.org/oauth/authorize?oauth_token=req-token-123',
      }),
      getAccessToken: async () => ({
        apiKey: 'access-key',
        userID: 22604681,
        username: 'tufeiping',
      }),
      __test: {
        signRequest() {},
        percentEncode: v => v,
        oauthHeader: () => '',
      },
    }
  }
  if (request === './ZoteroApiClient') {
    return {
      getKeyInfo: async () => ({
        userID: 22604681,
        username: 'tufeiping',
        library: true,
        files: true,
      }),
      saveCredentials: async (...args) => calls.saveCredentials.push(args),
      getCredentials: async () => null,
      clearCredentials: async () => {},
      describeCredentials: () => null,
      apiBaseUrl: () => 'https://api.zotero.org',
      listCollections: async () => [],
      listItems: async () => ({ items: [], totalResults: 0 }),
      listChildren: async () => [],
      pickPdfAttachment: () => null,
      downloadAttachment: async () => ({}),
      exportBibtex: async () => ({ bibtex: '', entryCount: 0 }),
      getItemsBibtex: async () => [],
      ZoteroApiError: class extends Error {},
    }
  }
  if (request.endsWith('Uploads/FileSystemImportManager')) {
    return { promises: { addEntity: async () => ({ _id: 'file-1' }) } }
  }
  if (request.endsWith('Project/ProjectGetter')) {
    return {
      promises: { getProject: async () => ({ rootFolder: { _id: 'root' } }) },
    }
  }
  if (request === '../../models/User') return { User: {} }
  return origLoad.call(this, request, parent, isMain)
}

const Controller = require(path.join(__dirname, 'ZoteroController'))

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    type(t) {
      this.contentType = t
      return this
    },
    send(payload) {
      this.body = payload
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
    redirect(url) {
      calls.redirects.push(url)
      this.statusCode = 302
      this.body = url
      return this
    },
  }
}

const req = (extra = {}) => ({ session: {}, query: {}, body: {}, ...extra })

test.beforeEach(() => {
  calls.setex.length = 0
  calls.saveCredentials.length = 0
  calls.redirects.length = 0
  currentUser = { _id: 'user-1' }
  oauthConfigured = true
})

test('oauthStart：跳去 Zotero 授权页，并把 pending(userId) 写进 Redis', async () => {
  const res = mockRes()
  await Controller.oauthStart(req(), res)

  assert.equal(res.statusCode, 302)
  assert.match(String(res.body), /zotero\.org\/oauth\/authorize/)
  assert.equal(calls.setex.length, 1)
  const [key, ttl, payload] = calls.setex[0]
  assert.equal(key, 'pending:req-token-123')
  assert.ok(ttl > 0)
  assert.deepEqual(JSON.parse(payload), {
    secret: 'req-secret-456',
    userId: 'user-1',
  })
})

test('oauthStart：未登录返回 401（不再 ReferenceError/500）', async () => {
  currentUser = null
  const res = mockRes()
  await Controller.oauthStart(req(), res)
  assert.equal(res.statusCode, 401)
})

test('oauthStart：未配置 OAuth 返回 404 且说明位置', async () => {
  oauthConfigured = false
  const res = mockRes()
  await Controller.oauthStart(req(), res)
  assert.equal(res.statusCode, 404)
  assert.match(String(res.body), /settings\.defaults\.js/)
})

test('oauthCallback：缺参数时给落地页（200），不是 500', async () => {
  const res = mockRes()
  await Controller.oauthCallback(req(), res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.body), /<!doctype html>/i)
})

test('oauthCallback：pending 不存在时也是落地页（200）', async () => {
  const res = mockRes()
  await Controller.oauthCallback(
    req({ query: { oauth_token: 'nope', oauth_verifier: 'v' } }),
    res
  )
  assert.equal(res.statusCode, 200)
  assert.match(String(res.body), /postMessage|如果没有自动跳转/)
})
