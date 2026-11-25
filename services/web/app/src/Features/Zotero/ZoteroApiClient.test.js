/**
 * Zotero 集成（Phase A）的后端回归测试
 *
 * 钉住四件「写错了会出事」的事：
 *   1. API Key 落库必须加密，且 describeCredentials 只回掩码
 *   2. /keys/current 的映射（userID / library / files）不能错——它决定绑定成败
 *   3. 条目列表的字段映射与前端渲染一致（title/creators/year/publication…）
 *   4. BibTeX 导出要能解析出引用键，并且批量上限/去重生效
 *
 * 不连 Mongo / 外网：Settings、User 模型、global.fetch 全部打桩。
 *
 * Run: cd services/web && node --test app/src/Features/Zotero/ZoteroApiClient.test.js
 */

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const Module = require('module')

const webRoot = path.join(__dirname, '../../../..') // services/web

const calls = { fetch: [] }
let nextResponse = null

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => headers[String(name).toLowerCase()] ?? null,
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

global.fetch = async (url, options) => {
  calls.fetch.push({ url: String(url), options })
  if (typeof nextResponse === 'function') {
    return nextResponse(String(url), options)
  }
  return nextResponse
}

// ---- 打桩 Settings / User ----
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@overleaf/settings') {
    return {
      security: { sessionSecret: 'test-secret' },
      // FIXED: 2026-11-16 配置统一在 Settings.zotero（见 settings.defaults.js）
      zotero: {
        apiUrl: 'https://api.zotero.org',
        timeoutMs: 12000,
        maxBibtexItems: 20,
        oauth: {
          clientKey: '',
          clientSecret: '',
          callbackUrl: '',
          configDirs: [],
        },
      },
    }
  }
  if (request === '../../models/User') {
    return {
      User: {
        findOne: () => ({ exec: async () => null }),
        updateOne: () => ({ exec: async () => ({}) }),
      },
    }
  }
  return origLoad.call(this, request, parent, isMain)
}

const Zotero = require(path.join(
  webRoot,
  'app/src/Features/Zotero/ZoteroApiClient'
))
const Cipher = require(path.join(
  webRoot,
  'app/src/Features/Zotero/ZoteroCredentialCipher'
))
const ZoteroOAuth1 = require(path.join(
  webRoot,
  'app/src/Features/Zotero/ZoteroOAuth1'
))

const creds = {
  apiKey: 'test',
  libraryType: 'user',
  libraryId: '22604681',
  username: 'tufeiping',
}

test.beforeEach(() => {
  calls.fetch.length = 0
  nextResponse = response({})
})

test('API Key 加密往返 + 篡改后解密失败（不崩、当作未绑定）', () => {
  const payload = Cipher.encrypt('KEYTEST0000000000000000')
  assert.ok(payload.data && payload.iv && payload.tag)
  assert.equal(Cipher.decrypt(payload), 'KEYTEST0000000000000000')

  const tampered = { ...payload, data: Buffer.from('x').toString('base64') }
  assert.equal(Cipher.decrypt(tampered), null)
  assert.equal(Cipher.decrypt(null), null)
})

test('describeCredentials 只回掩码，绝不回明文 key', () => {
  // 用合成 key，避免测试里出现真实凭据
  const synthetic = { ...creds, apiKey: 'test2' }
  const described = Zotero.describeCredentials(synthetic)
  assert.equal(described.apiKeyMasked, 'ABCD…JKL')
  assert.equal(JSON.stringify(described).includes(synthetic.apiKey), false)
})

test('getKeyInfo 映射 userID / library / files', async () => {
  nextResponse = response({
    key: 'k',
    userID: 22604681,
    username: 'tufeiping',
    access: { user: { library: true, files: true } },
  })
  const info = await Zotero.getKeyInfo(creds.apiKey)
  assert.deepEqual(info, {
    userID: 22604681,
    username: 'tufeiping',
    library: true,
    files: true,
  })
  // 请求头里必须带 Zotero-API-Key，不能放 query
  const call = calls.fetch[0]
  assert.equal(calls.fetch[0].url, 'https://api.zotero.org/keys/current')
  assert.ok(call.options.headers['Zotero-API-Key'])
})

test('403 翻译成人话，不透出上游原始 JSON', async () => {
  nextResponse = response({ message: 'Invalid key' }, { status: 403 })
  await assert.rejects(
    () => Zotero.getKeyInfo('bad-key-1234567890'),
    error => {
      assert.equal(error.statusCode, 403)
      assert.match(error.message, /Zotero 拒绝了这把 Key/)
      return true
    }
  )
})

test('listItems 字段映射与前端渲染一致', async () => {
  nextResponse = response(
    [
      {
        key: '6PJ6JCCG',
        version: 5,
        data: {
          key: '6PJ6JCCG',
          itemType: 'book',
          title: 'ASP网络编程技术与实例',
          creators: [{ creatorType: 'author', name: '胡标' }],
          date: '2004-05',
          publisher: '人民邮电出版社',
          url: '',
          DOI: '',
          abstractNote: '',
          collections: ['U6FXGXC4'],
        },
      },
    ],
    { headers: { 'total-results': '3' } }
  )

  const result = await Zotero.listItems(creds, { q: '网络', limit: 25 })
  assert.equal(result.totalResults, 3)
  assert.deepEqual(result.items[0], {
    key: '6PJ6JCCG',
    version: 5,
    itemType: 'book',
    title: 'ASP网络编程技术与实例',
    creators: ['胡标'],
    date: '2004-05',
    year: '2004',
    publication: '人民邮电出版社',
    url: '',
    doi: '',
    abstractNote: '',
    citationKey: '',
    collections: ['U6FXGXC4'],
    dateModified: '',
  })
})

test('listItems 分页拉取：limit 200 → 两次请求，带 start，truncated 反映库是否更大', async () => {
  // Zotero 服务端 limit 上限 100，所以 200 条必须拉两页
  const page = (from, count) =>
    Array.from({ length: count }, (_, i) => ({
      key: `K${from + i}`,
      version: 1,
      data: { itemType: 'book', title: `条目 ${from + i}` },
    }))

  nextResponse = (url, options) => {
    const start = Number(new URL(url).searchParams.get('start') || 0)
    const limit = Number(new URL(url).searchParams.get('limit') || 0)
    return response(page(start, start === 0 ? limit : Math.min(limit, 250 - start)), {
      // 库里共 250 条：拉 200 条后应该 truncated=true
      headers: { 'total-results': '250' },
    })
  }

  const result = await Zotero.listItems(creds, { limit: 200 })
  assert.equal(result.items.length, 200)
  assert.equal(result.totalResults, 250)
  assert.equal(result.truncated, true)
  assert.equal(calls.fetch.length, 2)
  assert.equal(new URL(calls.fetch[0].url).searchParams.get('start'), '0')
  assert.equal(new URL(calls.fetch[1].url).searchParams.get('start'), '100')
  // 排序必须稳定（最近修改优先），否则分页会漏/重
  assert.equal(
    new URL(calls.fetch[0].url).searchParams.get('sort'),
    'dateModified'
  )
})

test('listItems 库比请求量小时只拉一页，truncated=false', async () => {
  nextResponse = response(
    [{ key: 'K1', version: 1, data: { itemType: 'book', title: '一条' } }],
    { headers: { 'total-results': '1' } }
  )

  const result = await Zotero.listItems(creds, { limit: 200 })
  assert.equal(result.items.length, 1)
  assert.equal(result.truncated, false)
  assert.equal(calls.fetch.length, 1)
})

// FIXED: 2026-11-17 上限从 50 提到 500（前端一次拉下来做内存过滤）
test('listItems 的 limit 上限是 500，超过就钳住', async () => {
  nextResponse = (url) => {
    const limit = Number(new URL(url).searchParams.get('limit') || 0)
    return response(
      Array.from({ length: limit }, (_, i) => ({
        key: `K${i}`,
        version: 1,
        data: { itemType: 'book', title: `t${i}` },
      })),
      { headers: { 'total-results': '9999' } }
    )
  }

  const result = await Zotero.listItems(creds, { limit: 5000 })
  assert.equal(result.items.length, 500)
  assert.equal(calls.fetch.length, 5)
})

test('getItemsBibtex 解析引用键、去重、超上限报错', async () => {
  nextResponse = () => response('@book{_asp_2004,\n\ttitle = {{ASP}},\n}\n')

  const list = await Zotero.getItemsBibtex(creds, ['A', 'A', 'B'])
  assert.equal(list.length, 2, '重复 key 应该去重')
  assert.equal(list[0].citationKey, '_asp_2004')

  await assert.rejects(
    () =>
      Zotero.getItemsBibtex(
        creds,
        Array.from({ length: Zotero.maxBibtexItems() + 1 }, (_, i) => `K${i}`)
      ),
    error => {
      assert.equal(error.statusCode, 400)
      assert.match(error.message, /一次最多导出/)
      return true
    }
  )
})

test('parseCitationKey 兜住各种 @type{key, 写法', () => {
  assert.equal(Zotero.parseCitationKey('@book{abc_2004,'), 'abc_2004')
  assert.equal(Zotero.parseCitationKey('@article{ x-y_z ,'), 'x-y_z')
  assert.equal(Zotero.parseCitationKey(''), '')
  assert.equal(Zotero.parseCitationKey('not bibtex'), '')
})

test('pickPdfAttachment：只认 PDF，优先 imported_file', () => {
  const children = [
    { key: 'N1', itemType: 'note', filename: '' },
    {
      key: 'L1',
      itemType: 'attachment',
      contentType: 'text/html',
      filename: 'x.html',
      linkMode: 'imported_file',
    },
    {
      key: 'P1',
      itemType: 'attachment',
      contentType: 'application/pdf',
      filename: 'a.pdf',
      linkMode: 'linked_url',
    },
    {
      key: 'P2',
      itemType: 'attachment',
      contentType: 'application/pdf',
      filename: 'b.pdf',
      linkMode: 'imported_file',
    },
  ]
  assert.equal(Zotero.pickPdfAttachment(children).key, 'P2')
  assert.equal(Zotero.pickPdfAttachment([children[0], children[1]]), null)
  assert.equal(Zotero.pickPdfAttachment([]), null)
})

test('exportBibtex：分页拼接并按条目计数，上限生效', async () => {
  const page1 = '@book{k1,\ttitle={A},\n}\n@book{k2,\ttitle={B},\n}'
  const page2 = '@article{k3,\ttitle={C},\n}'
  // total-results 要比一页(100)大，才会真的去拉第二页
  nextResponse = url => {
    if (url.includes('start=0')) {
      return response(page1, { headers: { 'total-results': '150' } })
    }
    return response(page2, { headers: { 'total-results': '150' } })
  }

  const result = await Zotero.exportBibtex(creds, { maxEntries: 100 })
  assert.equal(result.entryCount, 3)
  assert.ok(result.bibtex.includes('@book{k1'))
  assert.ok(result.bibtex.includes('@article{k3'))
  assert.equal(result.truncated, false)

  // 第一页就够数时不应该再请求第二页
  calls.fetch.length = 0
  nextResponse = response('@book{only,\n}', {
    headers: { 'total-results': '1' },
  })
  const single = await Zotero.exportBibtex(creds, { maxEntries: 10 })
  assert.equal(single.entryCount, 1)
  assert.equal(calls.fetch.length, 1)
})

test('OAuth1：percentEncode 与签名稳定/敏感', () => {
  const { percentEncode, signRequest } = ZoteroOAuth1.__test
  assert.equal(percentEncode('a b!*'), 'a%20b%21%2A')

  const params = {
    oauth_consumer_key: 'ck',
    oauth_nonce: 'n1',
    oauth_timestamp: '1700000000',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  }
  const sig1 = signRequest({
    method: 'POST',
    url: 'https://www.zotero.org/oauth/request',
    params,
    consumerSecret: 'cs',
    tokenSecret: '',
  })
  const sig2 = signRequest({
    method: 'POST',
    url: 'https://www.zotero.org/oauth/request',
    params: { ...params },
    consumerSecret: 'cs',
    tokenSecret: '',
  })
  assert.equal(sig1, sig2, '同参数必须同签名')

  const sig3 = signRequest({
    method: 'POST',
    url: 'https://www.zotero.org/oauth/request',
    params,
    consumerSecret: 'different-igfteu',
    tokenSecret: '',
  })
  assert.notEqual(sig1, sig3, '换 secret 必须变')
  assert.ok(sig1.length > 10)
})
