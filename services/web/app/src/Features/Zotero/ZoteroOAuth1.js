'use strict'

/**
 * FIXED: 2026-11-16 Zotero OAuth1 授权（可选路径）。
 *
 * 为什么还要 OAuth：
 *   - 粘贴 API Key 最简单，但用户得自己去 zotero.org 生成 Key；
 *   - OAuth 一点就走完，体验更好，而且拿到的 token 可以直接当 API Key 用。
 *
 * 约束（刻意）：
 *   - 不引新依赖：OAuth1 签名就是 HMAC-SHA1 + 参数排序，用 node:crypto 足够；
 *   - 凭据**只有一处**：config/settings.defaults.js 的 Settings.zotero.oauth
 *     （默认值直接写在那里，env 可覆盖）。与 Settings.ne 同一套路，
 *     不另造"运行时配置文件"。
 *   - 没配时设置页不显示"授权"按钮，粘贴 Key 那条路照常可用。
 */

const crypto = require('node:crypto')
const Settings = require('@overleaf/settings')

const REQUEST_TOKEN_URL = 'https://www.zotero.org/oauth/request'
const AUTHORIZE_URL = 'https://www.zotero.org/oauth/authorize'
const ACCESS_TOKEN_URL = 'https://www.zotero.org/oauth/access'

/** 配置来自 Settings.zotero.oauth（默认值在 config/settings.defaults.js，env 可覆盖） */
function oauthSettings() {
  const settings = Settings.zotero || {}
  return settings.oauth || {}
}

/** 当前生效的 OAuth 配置 */
function resolveConfig() {
  const config = oauthSettings()
  return {
    clientKey: config.clientKey || '',
    clientSecret: config.clientSecret || '',
    callbackUrl: config.callbackUrl || '',
  }
}

function clientKey() {
  return resolveConfig().clientKey
}

function clientSecret() {
  return resolveConfig().clientSecret
}

function isConfigured() {
  const { clientKey, clientSecret } = resolveConfig()
  return Boolean(clientKey && clientSecret)
}

/** 供排查：凭据从哪来（只看得到它是 settings，看不到值） */
function configSource() {
  return isConfigured() ? 'settings' : 'none'
}

/** RFC 3986 百分号编码（OAuth1 要求） */
function percentEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    char => '%' + char.charCodeAt(0).toString(16).toUpperCase()
  )
}

/**
 * OAuth1 签名（HMAC-SHA1）。
 * params 里除 oauth_signature 外的键值都会参与签名（含 body 里的表单字段）。
 */
function signRequest({ method, url, params, consumerSecret, tokenSecret }) {
  const oauthParams = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === 'oauth_signature') continue
    oauthParams[percentEncode(key)] = percentEncode(String(value))
  }

  const paramString = Object.keys(oauthParams)
    .sort()
    .map(key => `${key}=${oauthParams[key]}`)
    .join('&')

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&')

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(
    tokenSecret || ''
  )}`

  return crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64')
}

function oauthHeader(params) {
  const parts = Object.keys(params)
    .sort()
    .map(key => `${percentEncode(key)}="${percentEncode(String(params[key]))}"`)
  return `OAuth ${parts.join(', ')}`
}

/**
 * 发一个签好名的表单请求。
 *
 * FIXED: 2026-11-16 tokenSecret 改成**独立参数**。
 * 原来是把 `oauth_token_secret_for_signing` 塞进 params 再删掉，
 * 但 signRequest 遍历的是同一个 params —— 结果这个内部字段也被算进了
 * 签名基串，Zotero 于是回 401：
 *   oauth_problem=signature_invalid … /oauth/access
 * /oauth/request 那步不需要 tokenSecret，所以只有第二步炸，非常难查。
 */
async function postSignedForm(url, params, { tokenSecret = '' } = {}) {
  const signature = signRequest({
    method: 'POST',
    url,
    params,
    consumerSecret: clientSecret(),
    tokenSecret,
  })
  const signed = { ...params, oauth_signature: signature }

  const body = Object.keys(signed)
    .filter(key => !key.startsWith('oauth_'))
    .map(key => `${percentEncode(key)}=${percentEncode(String(signed[key]))}`)
    .join('&')

  // FIXED: 2026-11-16 加超时：服务器出网受限时，之前会一直挂着直到网关超时，
  // 前端只看到一句 "Something went wrong"。现在 12s 就报出可读原因。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: oauthHeader(signed),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    })
  } catch (error) {
    throw new Error(
      error.name === 'AbortError'
        ? `连接 Zotero 超时（12s）：${url}，请确认服务器能出网访问 www.zotero.org`
        : `连接 Zotero 失败（${error.message}）：${url}，请确认服务器能出网访问 www.zotero.org`
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Zotero OAuth 失败（${response.status}）：${text.slice(0, 200)}`
    )
  }
  return new URLSearchParams(text)
}

function baseOAuthParams(extra = {}) {
  return {
    oauth_consumer_key: clientKey(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
    ...extra,
  }
}

/** 第一步：拿 request token */
async function getRequestToken(callbackUrl) {
  const params = baseOAuthParams({ oauth_callback: callbackUrl })
  const result = await postSignedForm(REQUEST_TOKEN_URL, params)
  const token = result.get('oauth_token')
  const secret = result.get('oauth_token_secret')
  if (!token || !secret) {
    throw new Error('Zotero 没有返回 request token')
  }
  return {
    token,
    secret,
    authorizeUrl: `${AUTHORIZE_URL}?oauth_token=${token}`,
  }
}

/** 第三步：拿 access token（Zotero 的 access token 就是可以当 API Key 用的那把） */
async function getAccessToken({ requestToken, requestTokenSecret, verifier }) {
  const params = baseOAuthParams({
    oauth_token: requestToken,
    oauth_verifier: verifier,
  })
  const result = await postSignedForm(ACCESS_TOKEN_URL, params, {
    tokenSecret: requestTokenSecret,
  })
  const token = result.get('oauth_token')
  const userID = result.get('userID')
  const username = result.get('username')
  if (!token) {
    throw new Error('Zotero 没有返回 access token')
  }
  return {
    apiKey: token,
    userID: userID ? Number(userID) : null,
    username: username || '',
  }
}

module.exports = {
  isConfigured,
  resolveConfig,
  configSource,
  getRequestToken,
  getAccessToken,
  // 供测试
  __test: { signRequest, percentEncode, oauthHeader },
}
