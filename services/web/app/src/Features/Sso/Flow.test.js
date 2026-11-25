'use strict'

/**
 * T2 全链路：`/sso/authorize` → code → `/sso/token` → `/sso/userinfo`
 *
 * 这是唯一一个「三个 handler 串起来跑」的测试，也是最有价值的那个 ——
 * 单元测试各自通过但顺序/契约对不上，是最典型的 OAuth 实现事故。
 *
 * 全部依赖注入（memory store + 假 req/res + 假 loadUser），
 * 所以不需要 Mongo / Redis / express 就能跑。
 */

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

const Clients = require('./Clients')
const Codes = require('./Codes')
const Tokens = require('./Tokens')
const Store = require('./Store')
const Authorize = require('./Authorize')
const Token = require('./Token')
const UserInfo = require('./UserInfo')
const Claims = require('./Claims')

const REDIRECT_URI = 'http://localhost:3100/word2latex/api/auth/sso/callback'
const CLIENT_SECRET = 's3cr3t-&^-with-chars'
const USER = {
  _id: '65f000000000000000000001',
  first_name: '三',
  last_name: '张',
  email: 'a@b.c',
  // 下面这些**绝不能**出现在响应里
  account_id: 'NE-123',
  carsiEmail: 'x@school.edu.cn',
  isAdmin: true,
  staffAccess: true,
  aiModel: 'gpt-x',
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    redirectTo: undefined,
  }
  res.status = code => {
    res.statusCode = code
    return res
  }
  res.set = (key, value) => {
    res.headers[String(key).toLowerCase()] = value
    return res
  }
  res.type = () => res
  res.send = body => {
    res.body = body
    return res
  }
  res.json = body => {
    res.body = body
    return res
  }
  res.redirect = url => {
    res.statusCode = 302
    res.redirectTo = url
    return res
  }
  return res
}

/** handler 现在返回 promise，await 它即可；next 抛出即视为失败 */
async function call(handler, req) {
  const res = fakeRes()
  await handler(req, res, error => {
    throw error
  })
  return res
}

function verifier() {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * 搭一套完整环境。
 * @param {object} [options]
 */
function setup(options = {}) {
  const registry = Clients.createRegistry([
    {
      client_id: 'word2latex',
      client_secret: CLIENT_SECRET,
      name: 'Word 转 LaTeX',
      redirect_uris: [REDIRECT_URI],
      scopes: ['openid', 'profile', 'email'],
      trusted: true,
      ...options.client,
    },
  ])
  const store = Store.memoryStore()
  const codes = Codes.createCodeService({ store })
  const tokens = Tokens.createTokenService({ store })

  const users = new Map([[String(USER._id), USER]])

  const authorize = Authorize.createAuthorizeHandler({
    registry,
    codes,
    getUser: req =>
      req.loggedIn === false ? null : req.session && req.session.user,
  })
  const token = Token.createTokenHandler({ registry, codes, tokens, store })
  const userinfo = UserInfo.createUserInfoHandler({
    tokens,
    loadUser: async userId => users.get(userId) || null,
  })

  return { registry, store, codes, tokens, authorize, token, userinfo, users }
}

async function authorizeOnce(env, overrides = {}) {
  const v = verifier()
  const state = crypto.randomUUID()
  const res = await call(env.authorize, {
    session: { user: USER },
    query: {
      response_type: 'code',
      client_id: 'word2latex',
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email',
      state,
      code_challenge: Codes.s256(v),
      code_challenge_method: 'S256',
      ...overrides,
    },
  })
  return { res, verifier: v, state }
}

/** 从 302 Location 里取 query 参数 */
function redirectedParams(res) {
  assert.strictEqual(res.statusCode, 302, `期望 302，实际 ${res.statusCode}`)
  return new URL(res.redirectTo).searchParams
}

// ---------------------------------------------------------------- 正常链路

test('全链路：authorize → code → token → userinfo', async () => {
  const env = setup()
  const { res: authorizeRes, verifier: v, state } = await authorizeOnce(env)

  const params = redirectedParams(authorizeRes)
  assert.strictEqual(params.get('state'), state, 'state 必须原样回传')
  const code = params.get('code')
  assert.ok(code && code.length >= 40, '必须带回 code')
  assert.strictEqual(params.get('error'), null)

  const tokenRes = await call(env.token, {
    headers: {},
    body: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: 'word2latex',
      client_secret: CLIENT_SECRET,
      code_verifier: v,
    },
  })

  assert.strictEqual(tokenRes.statusCode, 200)
  assert.strictEqual(tokenRes.headers['cache-control'], 'no-store')
  assert.strictEqual(tokenRes.body.token_type, 'Bearer')
  assert.strictEqual(tokenRes.body.scope, 'openid profile email')
  assert.ok(tokenRes.body.access_token)

  const userinfoRes = await call(env.userinfo, {
    headers: { authorization: `Bearer ${tokenRes.body.access_token}` },
  })

  assert.strictEqual(userinfoRes.statusCode, 200)
  assert.strictEqual(userinfoRes.headers['cache-control'], 'no-store')
  assert.deepStrictEqual(userinfoRes.body, {
    sub: String(USER._id),
    name: '三 张',
    email: 'a@b.c',
    email_verified: false,
  })
})

test('userinfo 与 /sso/session 同形（同一份 buildClaims）', async () => {
  const env = setup()
  const { res, verifier: v } = await authorizeOnce(env)
  const code = redirectedParams(res).get('code')
  const tokenRes = await call(env.token, {
    headers: {},
    body: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: 'word2latex',
      client_secret: CLIENT_SECRET,
      code_verifier: v,
    },
  })
  const userinfoRes = await call(env.userinfo, {
    headers: { authorization: `Bearer ${tokenRes.body.access_token}` },
  })
  // T0 的 /sso/session 用的就是这一个函数，形状必须逐字节一致
  assert.deepStrictEqual(
    userinfoRes.body,
    Claims.buildClaims(USER, ['openid', 'profile', 'email'])
  )
})

// ---------------------------------------------------------------- authorize 错误

test('未知 client_id：400 纯文本，绝不跳转（开放重定向回归）', async () => {
  const env = setup()
  const res = await call(env.authorize, {
    session: { user: USER },
    query: {
      response_type: 'code',
      client_id: 'nope',
      redirect_uri: REDIRECT_URI,
      state: 'x',
    },
  })
  assert.strictEqual(res.statusCode, 400)
  assert.strictEqual(res.redirectTo, undefined, '不能有任何跳转')
})

test('未注册 redirect_uri：400 纯文本，绝不跳转', async () => {
  const env = setup()
  for (const evil of [
    'https://evil.com/cb',
    'http://localhost:3100/word2latex/api/auth/sso/callback?x=1',
    REDIRECT_URI + '/../evil',
  ]) {
    const res = await call(env.authorize, {
      session: { user: USER },
      query: {
        response_type: 'code',
        client_id: 'word2latex',
        redirect_uri: evil,
        state: 'x',
      },
    })
    assert.strictEqual(res.statusCode, 400, `不该通过：${evil}`)
    assert.strictEqual(res.redirectTo, undefined)
  }
})

test('缺 state：400，不跳转（挡住登录 CSRF）', async () => {
  const env = setup()
  const res = await call(env.authorize, {
    session: { user: USER },
    query: {
      response_type: 'code',
      client_id: 'word2latex',
      redirect_uri: REDIRECT_URI,
    },
  })
  assert.strictEqual(res.statusCode, 400)
  assert.strictEqual(res.redirectTo, undefined)
})

test('response_type 不是 code：跳回并带 error + state', async () => {
  const env = setup()
  const state = 'abc'
  const res = await call(env.authorize, {
    session: { user: USER },
    query: {
      response_type: 'token',
      client_id: 'word2latex',
      redirect_uri: REDIRECT_URI,
      state,
    },
  })
  const params = redirectedParams(res)
  assert.strictEqual(params.get('error'), 'unsupported_response_type')
  assert.strictEqual(params.get('state'), state, '错误也要回传 state')
})

test('scope 越权：invalid_scope', async () => {
  const env = setup({ client: { scopes: ['openid'] } })
  const res = await call(env.authorize, {
    session: { user: USER },
    query: {
      response_type: 'code',
      client_id: 'word2latex',
      redirect_uri: REDIRECT_URI,
      state: 'abc',
      scope: 'openid email',
    },
  })
  assert.strictEqual(redirectedParams(res).get('error'), 'invalid_scope')
})

test('强制 PKCE：缺 code_challenge / 用 plain 都拒绝', async () => {
  const env = setup()

  const missing = await call(env.authorize, {
    session: { user: USER },
    query: {
      response_type: 'code',
      client_id: 'word2latex',
      redirect_uri: REDIRECT_URI,
      state: 'abc',
    },
  })
  assert.strictEqual(redirectedParams(missing).get('error'), 'invalid_request')

  const plain = await call(env.authorize, {
    session: { user: USER },
    query: {
      response_type: 'code',
      client_id: 'word2latex',
      redirect_uri: REDIRECT_URI,
      state: 'abc',
      code_challenge: verifier(),
      code_challenge_method: 'plain',
    },
  })
  assert.strictEqual(redirectedParams(plain).get('error'), 'invalid_request')
})

test('非 trusted 客户端：access_denied（不静默放行）', async () => {
  const env = setup({ client: { trusted: false } })
  const { res } = await authorizeOnce(env)
  assert.strictEqual(redirectedParams(res).get('error'), 'access_denied')
})

test('未登录时抛错交给中间件（不能在这里自己跳）', async () => {
  const env = setup()
  // 正常路径下 requireLogin() 已经拦住了。真走到这里说明中间件顺序配错，
  // 必须变成 500 级的错误，而不是让浏览器看到一个空跳转。
  await assert.rejects(
    () =>
      env.authorize(
        {
          loggedIn: false,
          session: {},
          query: {
            response_type: 'code',
            client_id: 'word2latex',
            redirect_uri: REDIRECT_URI,
            state: 'abc',
            code_challenge: Codes.s256(verifier()),
            code_challenge_method: 'S256',
          },
        },
        fakeRes(),
        error => {
          throw error
        }
      ),
    /without a logged-in user/
  )
})

// ---------------------------------------------------------------- token 错误

async function issueCode(env) {
  const { res, verifier: v } = await authorizeOnce(env)
  return { code: redirectedParams(res).get('code'), verifier: v }
}

function tokenRequest(body, headers = {}) {
  return { headers, body }
}

test('错 secret：401 invalid_client', async () => {
  const env = setup()
  const { code, verifier: v } = await issueCode(env)
  const res = await call(
    env.token,
    tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: 'word2latex',
      client_secret: 'wrong',
      code_verifier: v,
    })
  )
  assert.strictEqual(res.statusCode, 401)
  assert.strictEqual(res.body.error, 'invalid_client')
})

test('缺 code_verifier：400 invalid_grant', async () => {
  const env = setup()
  const { code } = await issueCode(env)
  const res = await call(
    env.token,
    tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: 'word2latex',
      client_secret: CLIENT_SECRET,
    })
  )
  assert.strictEqual(res.statusCode, 400)
  assert.strictEqual(res.body.error, 'invalid_grant')
})

test('code 复用：第二次 400 invalid_grant', async () => {
  const env = setup()
  const { code, verifier: v } = await issueCode(env)
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: 'word2latex',
    client_secret: CLIENT_SECRET,
    code_verifier: v,
  }
  const first = await call(env.token, tokenRequest({ ...body }))
  assert.strictEqual(first.statusCode, 200)

  const second = await call(env.token, tokenRequest({ ...body }))
  assert.strictEqual(second.statusCode, 400)
  assert.strictEqual(second.body.error, 'invalid_grant')
})

test('grant_type 不对：unsupported_grant_type', async () => {
  const env = setup()
  const res = await call(
    env.token,
    tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'word2latex',
      client_secret: CLIENT_SECRET,
    })
  )
  assert.strictEqual(res.statusCode, 400)
  assert.strictEqual(res.body.error, 'unsupported_grant_type')
})

test('client_secret_basic 也接受（含特殊字符要 URL 编码）', async () => {
  const env = setup()
  const { code, verifier: v } = await issueCode(env)
  const basic = Buffer.from(
    `${encodeURIComponent('word2latex')}:${encodeURIComponent(CLIENT_SECRET)}`
  ).toString('base64')

  const res = await call(
    env.token,
    tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: v,
      },
      { authorization: `Basic ${basic}` }
    )
  )
  assert.strictEqual(res.statusCode, 200)
  assert.ok(res.body.access_token)
})

test('换 token 限流：超过阈值返回 429', async () => {
  const env = setup()
  const registry = env.registry
  const codes = env.codes
  const tokens = env.tokens
  const store = Store.memoryStore()
  const handler = Token.createTokenHandler({
    registry,
    codes,
    tokens,
    store,
    rateLimit: 2,
    rateWindowSeconds: 60,
  })
  const body = {
    grant_type: 'authorization_code',
    code: 'x',
    redirect_uri: REDIRECT_URI,
    client_id: 'word2latex',
    client_secret: CLIENT_SECRET,
  }
  await call(handler, tokenRequest({ ...body }))
  await call(handler, tokenRequest({ ...body }))
  const third = await call(handler, tokenRequest({ ...body }))
  assert.strictEqual(third.statusCode, 429)
  assert.strictEqual(third.body.error, 'temporarily_unavailable')
})

// ---------------------------------------------------------------- userinfo 错误

test('无 token：401 + WWW-Authenticate', async () => {
  const env = setup()
  const res = await call(env.userinfo, { headers: {} })
  assert.strictEqual(res.statusCode, 401)
  assert.match(res.headers['www-authenticate'], /^Bearer error="invalid_token"/)
  assert.strictEqual(res.headers['cache-control'], 'no-store')
})

test('伪造 token：401', async () => {
  const env = setup()
  const res = await call(env.userinfo, {
    headers: { authorization: `Bearer ${'A'.repeat(43)}` },
  })
  assert.strictEqual(res.statusCode, 401)
})

test('token 有效但用户已不存在：401（当无效处理，不给细节）', async () => {
  const env = setup()
  const { res, verifier: v } = await authorizeOnce(env)
  const code = redirectedParams(res).get('code')
  const tokenRes = await call(env.token, {
    headers: {},
    body: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: 'word2latex',
      client_secret: CLIENT_SECRET,
      code_verifier: v,
    },
  })
  assert.strictEqual(tokenRes.statusCode, 200)

  env.users.delete(String(USER._id))

  const userinfoRes = await call(env.userinfo, {
    headers: { authorization: `Bearer ${tokenRes.body.access_token}` },
  })
  assert.strictEqual(userinfoRes.statusCode, 401)
  assert.strictEqual(userinfoRes.body.error, 'invalid_token')
})

// ---------------------------------------------------------------- claims 边界

test('claims 只含白名单字段，敏感字段一律不出门', async () => {
  const claims = Claims.buildClaims(USER, ['openid', 'profile', 'email'])
  assert.deepStrictEqual(Object.keys(claims).sort(), [
    'email',
    'email_verified',
    'name',
    'sub',
  ])
  assert.strictEqual(claims.sub, String(USER._id))
})
