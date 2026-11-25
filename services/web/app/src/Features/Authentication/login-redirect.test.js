/**
 * 回归测试：登录后被送到埋点端点导致 404。
 *
 * 真实事故（2026-11-12）：
 *   1. 未登录用户在导航栏点「登录」；
 *   2. 前端埋点顺带 `POST /event/menu-clicked-login`；
 *   3. requireGlobalLogin 拦下它，把 `req.path` 记进 postLoginRedirect；
 *   4. Google 登录成功 → finishLogin 跳过去 → GET 一个只接受 POST 的端点 → 404。
 *
 * 两道防线各自落在哪个函数，就在下面分别钉住。
 */
const test = require('node:test')
const assert = require('node:assert')

process.env.DEPLOYMENT_PROFILE = 'sg'

const AuthenticationController = require('./AuthenticationController')

const makeReq = (method, path, extra = {}) =>
  Object.assign(
    {
      method,
      path,
      query: {},
      session: {},
    },
    extra
  )

test('非 GET 请求不会被记成登录落地页（根因）', () => {
  const req = makeReq('POST', '/event/menu-clicked-login')
  AuthenticationController.setRedirectInSession(req)
  assert.strictEqual(
    req.session.postLoginRedirect,
    undefined,
    '埋点 POST 绝不能成为登录后的跳转目标'
  )
})

test('GET 请求照常记录，带 query 也保留', () => {
  const req = makeReq('GET', '/project/abc', { query: { q: '1' } })
  AuthenticationController.setRedirectInSession(req)
  assert.strictEqual(req.session.postLoginRedirect, '/project/abc?q=1')
})

test('显式传 value 时不受方法限制（表单提交后指定落地页仍有效）', () => {
  const req = makeReq('POST', '/login')
  AuthenticationController.setRedirectInSession(req, '/project')
  assert.strictEqual(req.session.postLoginRedirect, '/project')
})

test('兜底：会话里已有的脏值不会被当成落地页', () => {
  const cases = [
    ['/event/menu-clicked-login', null],
    ['/event/compile-metrics', null],
    ['/api/llm/session', null],
    ['/project', '/project'],
    ['/project/123?x=1', '/project/123?x=1'],
  ]
  for (const [stored, expected] of cases) {
    const req = makeReq('GET', '/login')
    req.session.postLoginRedirect = stored
    assert.strictEqual(
      AuthenticationController._getRedirectFromSession(req),
      expected,
      `postLoginRedirect=${stored}`
    )
  }
})
