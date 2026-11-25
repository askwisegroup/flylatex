/**
 * Zotero OAuth1 的**配置来源**测试（签名逻辑见 ZoteroApiClient.test.js）。
 *
 * 约定（和 Settings.ne 一样）：凭据只有一处 —— config/settings.defaults.js 的
 * Settings.zotero.oauth，默认值直接写在那里，env 可覆盖。
 *
 * Run: cd services/web && node --test app/src/Features/Zotero/ZoteroOAuth1.test.js
 */

const test = require('node:test')
const assert = require('node:assert')
const Module = require('module')
const path = require('node:path')

// 与 settings.defaults.js 同形状（in-place 修改，模块持有同一个对象）
const settingsValue = {
  zotero: {
    oauth: {
      clientKey: '',
      clientSecret: '',
      callbackUrl: '',
    },
  },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@overleaf/settings') {
    return settingsValue
  }
  return origLoad.call(this, request, parent, isMain)
}

const OAuth = require(path.join(__dirname, 'ZoteroOAuth1'))

test('都在时算已配置，并原样给出回调地址', () => {
  settingsValue.zotero.oauth.clientKey = 'k1'
  settingsValue.zotero.oauth.clientSecret = 's1'
  settingsValue.zotero.oauth.callbackUrl =
    'https://www.example.com/api/zotero/oauth/callback'

  assert.equal(OAuth.isConfigured(), true)
  assert.deepEqual(OAuth.resolveConfig(), {
    clientKey: 'k1',
    clientSecret: 's1',
    callbackUrl: 'https://www.example.com/api/zotero/oauth/callback',
  })
  assert.equal(OAuth.configSource(), 'settings')
})

test('缺任一凭据 → 未配置（设置页不显示授权按钮）', () => {
  settingsValue.zotero.oauth.clientKey = 'k1'
  settingsValue.zotero.oauth.clientSecret = ''
  assert.equal(OAuth.isConfigured(), false)
  assert.equal(OAuth.configSource(), 'none')
})

test('Settings 整个缺失也不炸', () => {
  const saved = settingsValue.zotero
  delete settingsValue.zotero
  assert.equal(OAuth.isConfigured(), false)
  assert.deepEqual(OAuth.resolveConfig(), {
    clientKey: '',
    clientSecret: '',
    callbackUrl: '',
  })
  settingsValue.zotero = saved
})

test('签名随 secret 变化（防止凭据没真正参与）', () => {
  const { signRequest } = OAuth.__test
  const params = {
    oauth_consumer_key: 'ck',
    oauth_nonce: 'n',
    oauth_timestamp: '1700000000',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  }
  const a = signRequest({
    method: 'POST',
    url: 'https://www.zotero.org/oauth/request',
    params,
    consumerSecret: 's1',
  })
  const b = signRequest({
    method: 'POST',
    url: 'https://www.zotero.org/oauth/request',
    params,
    consumerSecret: 's2',
  })
  assert.notEqual(a, b)
})

test('access token 的签名不能把内部字段算进基串（线上 401 signature_invalid）', async () => {
  // 只关心「发出去的 Authorization 头，用同样的 tokenSecret 重新算签名能对上」。
  // 若内部字段被算进基串，重算必然对不上 —— 这条就是当初 401 的根因。
  settingsValue.zotero.oauth.clientKey = 'ck'
  settingsValue.zotero.oauth.clientSecret = 'cs'

  const captured = []
  const originalFetch = global.fetch
  global.fetch = async (url, options) => {
    captured.push({ url: String(url), headers: options.headers })
    return {
      ok: true,
      status: 200,
      text: async () =>
        'oauth_token=access-zx&userID=22604681&username=tufeiping',
    }
  }

  try {
    await OAuth.getAccessToken({
      requestToken: 'req-token-ijk',
      requestTokenSecret: 'req-secret-pqr',
      verifier: 'verifier-lmn',
    })
  } finally {
    global.fetch = originalFetch
  }

  const { signRequest, percentEncode } = OAuth.__test
  const header = captured[0].headers.Authorization
  assert.match(header, /^OAuth /)

  // 从 Authorization 头里解析出参数（去掉 oauth_signature 后重新签名）
  const params = {}
  for (const part of header.replace(/^OAuth /, '').split(', ')) {
    const [key, rawValue] = part.split('=')
    params[decodeURIComponent(key)] = decodeURIComponent(
      rawValue.replace(/"/g, '')
    )
  }
  const providedSignature = params.oauth_signature
  delete params.oauth_signature

  assert.equal(params.oauth_token, 'req-token-ijk')
  assert.equal(params.oauth_verifier, 'verifier-lmn')
  // 内部字段绝不能出现在请求里
  assert.equal(
    Object.keys(params).some(key => key.includes('secret_for_signing')),
    false
  )

  const expected = signRequest({
    method: 'POST',
    url: 'https://www.zotero.org/oauth/access',
    params,
    consumerSecret: 'cs',
    tokenSecret: 'req-secret-pqr',
  })
  assert.equal(providedSignature, expected)
})
