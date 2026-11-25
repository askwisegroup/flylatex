'use strict'

/**
 * NE 用户中心 认证 V2 —— 单测用 Mock 服务
 *
 * 迁移自联调 demo 的 mock-ne.js（已验证可跑通全链路），改造为可编程启停的 fixture：
 *   const mock = await startMockNe({ captchaEnabled: true })
 *   mock.baseUrl  // http://127.0.0.1:<port>
 *   mock.requests // 请求记录，便于断言
 *   await mock.close()
 *
 * 它实现了指南里的接口语义：
 *   GET  /user/dict            自带 RSA 密钥对（用于校验客户端加密是否正确）
 *   POST /user/passwordlogin   校验 auth_version / client_id / captcha，用私钥解密密码
 *   POST /util/sendcode        type=2（当前不要求 auth_version / client_id）
 *   POST /user/codelogin       校验 mobile + 短信码
 *   GET  /user/authorize       校验 PKCE S256；mock_format=json 时直接回 JSON 便于测试
 *   GET  /user/carsiauthorize  同上
 *   POST /user/token           authorization_code / refresh_token（含 slow_down，校验 client_secret）
 *   POST /user/sessionlogout   校验 client_secret
 *   GET  /user/info            Bearer
 */

const http = require('http')
const crypto = require('crypto')
const { URL, URLSearchParams } = require('url')

const DEFAULT_CLIENT_ID = 'flylatex'
const DEFAULT_VALID_CAPTCHA = 'VALID_CAPTCHA'
const DEFAULT_SMS_CODE = '123456'

const b64url = b =>
  b
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

function readBody(req) {
  return new Promise(resolve => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => resolve(new URLSearchParams(data)))
  })
}

/**
 * @param {object} [options]
 * @param {boolean} [options.captchaEnabled]     字典 enabled 返回 "1"
 * @param {number}  [options.rotateSeconds]      刷新轮换最小间隔，默认 60
 * @param {string}  [options.clientId]
 * @param {string}  [options.clientSecret]       设置后要求保密客户端提交 client_secret
 * @param {string}  [options.validCaptchaParam]
 * @param {string}  [options.smsCode]
 * @param {Array}   [options.users]
 * @returns {Promise<object>}
 */
function startMockNe(options = {}) {
  const captchaEnabled = !!options.captchaEnabled
  const rotateSeconds =
    options.rotateSeconds != null ? options.rotateSeconds : 60
  const clientId = options.clientId || DEFAULT_CLIENT_ID
  const clientSecret = options.clientSecret || ''
  const validCaptcha = options.validCaptchaParam || DEFAULT_VALID_CAPTCHA
  const smsCode = options.smsCode || DEFAULT_SMS_CODE
  const users = options.users || [
    {
      target: 'demo@example.com',
      mobile: '',
      password: 'Passw0rd!',
      account_id: 10001,
    },
    {
      target: '13800000000',
      mobile: '13800000000',
      password: 'Passw0rd!',
      account_id: 659497,
    },
  ]

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })

  const requests = []
  const codes = new Map() // code -> { challenge, redirectUri, clientId, used }
  const refreshTokens = new Map() // token -> { rotatedAt }
  const accessTokens = new Map() // token -> { sub }

  function issueTokens(sub) {
    const now = Math.floor(Date.now() / 1000)
    const access = 'a2.' + crypto.randomBytes(12).toString('hex')
    const refresh = 'r2.' + crypto.randomBytes(12).toString('hex')
    accessTokens.set(access, { sub })
    refreshTokens.set(refresh, { rotatedAt: now })
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_expires_in: 86400,
      expires_at: now + 900,
      session_expires_at: now + 86400,
    }
  }

  function decryptPassword(cipherB64) {
    try {
      return crypto
        .privateDecrypt(
          { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(cipherB64, 'base64')
        )
        .toString('utf8')
    } catch (e) {
      return null
    }
  }

  function checkCaptcha(form) {
    if (!captchaEnabled) return null
    const p = form.get('captcha_verify_param')
    if (!p) return { code: 1000, msg: '参数错误' }
    if (p !== validCaptcha) return { code: 2000, msg: '身份验证失败' }
    return null
  }

  function clientSecretError(form) {
    if (clientSecret && form.get('client_secret') !== clientSecret) {
      return {
        code: 2000,
        msg: 'invalid_client',
        data: { error: 'invalid_client' },
      }
    }
    return null
  }

  function checkClient(form) {
    if (form.get('auth_version') !== '2') {
      return { code: 2001, msg: 'client_upgrade_required' }
    }
    if (form.get('client_id') !== clientId) {
      return {
        code: 2000,
        msg: 'invalid_client',
        data: { error: 'invalid_client' },
      }
    }
    return clientSecretError(form)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    const form =
      req.method === 'POST' ? await readBody(req) : new URLSearchParams()
    requests.push({
      method: req.method,
      path: p,
      form: Object.fromEntries(form.entries()),
      headers: req.headers,
    })

    const json = (status, obj) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=UTF-8',
      })
      res.end(JSON.stringify(obj))
    }

    if (p === '/user/dict' && req.method === 'GET') {
      return json(200, {
        code: 0,
        msg: '',
        data: {
          public_key: publicKeyPem,
          carsi_authorize_url: `http://127.0.0.1:${
            server.address().port
          }/user/carsiauthorize`,
          captcha: {
            enabled: captchaEnabled ? '1' : '0',
            provider: 'aliyun',
            region: 'cn',
            prefix: 'mockprefix',
            sceneId: 'mockscene',
          },
        },
      })
    }

    if (p === '/user/passwordlogin' && req.method === 'POST') {
      const clientErr = checkClient(form)
      if (clientErr) return json(200, clientErr)
      const capErr = checkCaptcha(form)
      if (capErr) return json(200, capErr)

      const plain = decryptPassword(form.get('password') || '')
      if (plain === null) return json(200, { code: 1000, msg: '参数错误' })

      const user = users.find(u => u.target === form.get('target'))
      if (!user || user.password !== plain) {
        return json(200, { code: 1000, msg: '密码错误' })
      }
      return json(200, {
        code: 0,
        msg: '',
        data: {
          ...issueTokens(user.target),
          account_id: user.account_id,
          email: user.target.includes('@') ? user.target : '',
          mobile: user.mobile,
        },
      })
    }

    if (p === '/util/sendcode' && req.method === 'POST') {
      const capErr = checkCaptcha(form)
      if (capErr) return json(200, capErr)
      if (form.get('type') !== '2')
        return json(200, { code: 1000, msg: '参数错误' })
      if (!/^1[3-9]\d{9}$/.test(form.get('target') || '')) {
        return json(200, { code: 1000, msg: '请输入正确的手机号' })
      }
      return json(200, { code: 0, msg: '' })
    }

    if (p === '/user/codelogin' && req.method === 'POST') {
      const clientErr = checkClient(form)
      if (clientErr) return json(200, clientErr)
      if (!/^1[3-9]\d{9}$/.test(form.get('mobile') || '')) {
        return json(200, { code: 1000, msg: '请输入正确的手机号' })
      }
      if (form.get('code') !== smsCode) {
        return json(200, { code: 2000, msg: '验证码错误或已失效' })
      }
      const user = users.find(u => u.mobile === form.get('mobile')) || {
        target: form.get('mobile'),
        mobile: form.get('mobile'),
        account_id: 9999,
      }
      return json(200, {
        code: 0,
        msg: '',
        data: {
          ...issueTokens(user.mobile || user.target),
          account_id: user.account_id,
          mobile: user.mobile,
        },
      })
    }

    if (
      (p === '/user/authorize' || p === '/user/carsiauthorize') &&
      req.method === 'GET'
    ) {
      // FIXED: 2026-10-23 两个授权入口统一使用 client_id，不再接受 app。
      const clientIdParam = url.searchParams.get('client_id')
      const redirectTo = url.searchParams.get('redirect')
      const state = url.searchParams.get('state')
      const challenge = url.searchParams.get('code_challenge')
      const method = url.searchParams.get('code_challenge_method')
      if (
        !clientIdParam ||
        !redirectTo ||
        !state ||
        !challenge ||
        method !== 'S256'
      ) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=UTF-8' })
        return res.end('<h1>mock: 参数不完整或 method!=S256</h1>')
      }
      const code = 'c2.' + crypto.randomBytes(8).toString('hex')
      codes.set(code, {
        challenge,
        redirectUri: redirectTo,
        clientId: clientIdParam,
        used: false,
      })
      const callbackUrl = `${redirectTo}${
        redirectTo.includes('?') ? '&' : '?'
      }code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
      if (url.searchParams.get('mock_format') === 'json') {
        return json(200, { code, state, callbackUrl })
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' })
      return res.end(
        `<!DOCTYPE html><meta charset="utf-8"><h1>mock 登录页</h1><a id="go" href="${callbackUrl.replace(
          /&/g,
          '&amp;'
        )}">回跳</a>`
      )
    }

    if (p === '/user/token' && req.method === 'POST') {
      const secretErr = clientSecretError(form)
      if (secretErr) return json(200, secretErr)
      const grant = form.get('grant_type')

      if (grant === 'authorization_code') {
        const rec = codes.get(form.get('code'))
        if (!rec || rec.used) {
          return json(200, {
            code: 2001,
            msg: 'invalid_grant',
            data: { error: 'invalid_grant' },
          })
        }
        if (
          rec.clientId !== form.get('client_id') ||
          rec.redirectUri !== form.get('redirect_uri')
        ) {
          return json(200, {
            code: 2000,
            msg: 'invalid_client',
            data: { error: 'invalid_client' },
          })
        }
        const expect = b64url(
          crypto
            .createHash('sha256')
            .update(form.get('code_verifier') || '')
            .digest()
        )
        if (expect !== rec.challenge) {
          return json(200, {
            code: 2001,
            msg: 'invalid_grant',
            data: { error: 'invalid_grant' },
          })
        }
        rec.used = true
        return json(200, { code: 0, msg: '', data: issueTokens('carsi-user') })
      }

      if (grant === 'refresh_token') {
        const token = form.get('refresh_token')
        const rec = refreshTokens.get(token)
        if (!rec) {
          return json(200, {
            code: 2001,
            msg: 'invalid_grant',
            data: { error: 'invalid_grant' },
          })
        }
        if (!form.get('request_id')) {
          return json(200, {
            code: 1000,
            msg: 'invalid_request',
            data: { error: 'invalid_request' },
          })
        }
        const now = Math.floor(Date.now() / 1000)
        if (now - rec.rotatedAt < rotateSeconds) {
          return json(200, {
            code: 2000,
            msg: 'slow_down',
            data: {
              error: 'slow_down',
              retry_after: rotateSeconds - (now - rec.rotatedAt),
            },
          })
        }
        refreshTokens.delete(token)
        return json(200, {
          code: 0,
          msg: '',
          data: issueTokens('refreshed-user'),
        })
      }

      return json(200, {
        code: 1000,
        msg: 'unsupported_grant_type',
        data: { error: 'unsupported_grant_type' },
      })
    }

    if (p === '/user/sessionlogout' && req.method === 'POST') {
      const secretErr = clientSecretError(form)
      if (secretErr) return json(200, secretErr)
      const existed = refreshTokens.delete(form.get('refresh_token'))
      return json(200, { code: 0, msg: '', data: { revoked: existed } })
    }

    if (p === '/user/info' && req.method === 'GET') {
      const m = (req.headers.authorization || '').match(/^Bearer (.+)$/)
      const rec = m && accessTokens.get(m[1])
      if (!rec) {
        return json(200, {
          code: 2001,
          msg: '会话已过期',
          data: { error: 'invalid_grant' },
        })
      }
      if (options.userInfoError) return json(200, options.userInfoError)
      const user =
        users.find(u => u.target === rec.sub || u.mobile === rec.sub) ||
        users[0]
      return json(200, {
        code: 0,
        msg: '',
        data: {
          account_id: user.account_id,
          nick_name: 'MOCK',
          email: user.target.includes('@') ? user.target : '',
          mobile: user.mobile,
          type: user.type === undefined ? 1 : user.type,
          type_txt: user.type_txt || '普通用户',
          vip_end: user.vip_end,
          // FIXED: 2026-10-23 便于单测覆盖机构同步（默认空）
          inst_name: user.inst_name || '',
        },
      })
    }

    json(404, { code: 1000, msg: 'not found (mock)' })
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        requests,
        users,
        validCaptchaParam: validCaptcha,
        smsCode,
        clientId,
        close: () =>
          new Promise(done => {
            server.close(() => done())
          }),
      })
    })
  })
}

module.exports = {
  startMockNe,
  DEFAULT_CLIENT_ID,
  DEFAULT_VALID_CAPTCHA,
  DEFAULT_SMS_CODE,
}
