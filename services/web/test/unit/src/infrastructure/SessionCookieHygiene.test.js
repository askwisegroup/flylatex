const { expect } = require('chai')
const Settings = require('@overleaf/settings')
const signature = require('cookie-signature')
const SessionCookieHygiene = require('../../../../app/src/infrastructure/SessionCookieHygiene')

function signedCookieValue(sid) {
  return encodeURIComponent('s:' + signature.sign(sid, Settings.security.sessionSecret))
}

function fakeRequest(cookieHeader, sessionID) {
  return {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    hostname: 'www.test.example',
    path: '/login',
    sessionID,
    session: {},
  }
}

function fakeResponse() {
  const setCookies = []
  return {
    setCookies,
    append(name, value) {
      expect(name).to.equal('Set-Cookie')
      setCookies.push(value)
    },
  }
}

function run(req) {
  const res = fakeResponse()
  let called = false
  SessionCookieHygiene.middleware(req, res, () => {
    called = true
  })
  return { res, called }
}

describe('SessionCookieHygiene', function () {
  let originalDomain
  let originalLanguageDomain

  beforeEach(function () {
    originalDomain = Settings.cookieDomain
    originalLanguageDomain = Settings.languageCookieDomain
    Settings.cookieDomain = undefined
    Settings.languageCookieDomain = 'test.example'
  })

  afterEach(function () {
    Settings.cookieDomain = originalDomain
    Settings.languageCookieDomain = originalLanguageDomain
  })

  it('parses every value of the session cookie in header order', function () {
    const header = `other=1; ${Settings.cookieName}=a; ${Settings.cookieName}=b`
    expect(SessionCookieHygiene.cookieValues(header, Settings.cookieName)).to.eql([
      'a',
      'b',
    ])
  })

  it('lists the host and its parent domain as candidates', function () {
    const domains = SessionCookieHygiene.candidateDomains('www.test.example')
    expect([...domains]).to.include('www.test.example')
    expect([...domains]).to.include('test.example')
    expect([...domains]).to.include('test.example')
    expect(SessionCookieHygiene.candidateDomains('127.0.0.1').size).to.equal(1)
  })

  it('leaves a healthy session alone', function () {
    const req = fakeRequest(
      `${Settings.cookieName}=${signedCookieValue('sid-healthy')}`,
      'sid-healthy'
    )
    const { res, called } = run(req)
    expect(called).to.equal(true)
    expect(res.setCookies).to.eql([])
  })

  it('leaves requests without a session cookie alone', function () {
    const { res } = run(fakeRequest(undefined, 'sid-new'))
    expect(res.setCookies).to.eql([])
  })

  it('purges the shadowed legacy cookie pair and rewrites the current session', function () {
    // 老域名 cookie 排在前面（浏览器按创建时间发送），本次请求实际用的是新 session
    const header = [
      `${Settings.cookieName}=${signedCookieValue('sid-legacy')}`,
      `${Settings.cookieName}=${signedCookieValue('sid-other')}`,
    ].join('; ')
    const { res } = run(fakeRequest(header, 'sid-current'))
    const joined = res.setCookies.join('\n')
    // 作废：host-only + 父域（事故里那条 Domain=example.com）
    expect(joined).to.include(`Domain=www.test.example`)
    expect(joined).to.include(`Domain=test.example`)
    expect(joined).to.include('Max-Age=0')
    // 补写：当前 session，host-only
    const rewritten = res.setCookies.find(
      header =>
        !header.includes('Max-Age=0') &&
        header.includes(signedCookieValue('sid-current'))
    )
    expect(rewritten).to.be.a('string')
    expect(rewritten).to.include('HttpOnly')
    expect(rewritten).to.include('Path=/')
    expect(rewritten).to.not.include('Domain=')
  })

  it('purges a cookie whose session no longer exists', function () {
    const req = fakeRequest(
      `${Settings.cookieName}=${signedCookieValue('sid-dead')}`,
      'sid-fresh'
    )
    const { res } = run(req)
    expect(res.setCookies.length).to.be.greaterThan(0)
    expect(res.setCookies[0]).to.include('Max-Age=0')
  })

  it('does nothing when the deployment uses an explicit cross-subdomain cookie', function () {
    Settings.cookieDomain = '.test.example'
    const req = fakeRequest(
      `${Settings.cookieName}=${signedCookieValue('sid-dead')}`,
      'sid-fresh'
    )
    const { res } = run(req)
    expect(res.setCookies).to.eql([])
  })
})
