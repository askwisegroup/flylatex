const { expect } = require('chai')

const {
  challengeFromVerifier,
  createTransaction,
  isValidState,
  isValidVerifier,
  base64url,
} = require('../../../../../commercial/ne-auth-v2/pkce')

describe('ne-auth-v2/pkce', function () {
  it('S256 与 RFC 7636 附录 B 的测试向量一致', function () {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(challengeFromVerifier(verifier)).to.equal(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  it('challenge 不含 Base64 填充与 +/', function () {
    const t = createTransaction()
    expect(t.challenge).to.match(/^[A-Za-z0-9_-]+$/)
    expect(t.challenge).to.not.include('=')
  })

  it('生成的 verifier 满足 43–128 位与字符集要求', function () {
    for (let i = 0; i < 50; i++) {
      const { verifier } = createTransaction()
      expect(verifier.length).to.be.within(43, 128)
      expect(isValidVerifier(verifier)).to.equal(true)
    }
  })

  it('生成的 state 满足 16–512 字节且不含控制字符', function () {
    for (let i = 0; i < 50; i++) {
      const { state } = createTransaction()
      expect(isValidState(state)).to.equal(true)
      expect(Buffer.byteLength(state, 'utf8')).to.be.within(16, 512)
    }
  })

  it('每次事务的 state / verifier / challenge 都不同', function () {
    const seen = new Set()
    for (let i = 0; i < 100; i++) {
      const t = createTransaction()
      seen.add(t.state)
      seen.add(t.verifier)
      seen.add(t.challenge)
    }
    expect(seen.size).to.equal(300)
  })

  it('isValidVerifier 拒绝越界与非法字符', function () {
    expect(isValidVerifier('a'.repeat(42))).to.equal(false)
    expect(isValidVerifier('a'.repeat(129))).to.equal(false)
    expect(isValidVerifier('a'.repeat(43))).to.equal(true)
    expect(isValidVerifier('a'.repeat(128))).to.equal(true)
    expect(isValidVerifier('has space'.padEnd(43, 'a'))).to.equal(false)
    expect(isValidVerifier(null)).to.equal(false)
  })

  it('isValidState 拒绝过短、带空白/控制字符与 0x7f', function () {
    expect(isValidState('short')).to.equal(false)
    expect(isValidState('a'.repeat(16))).to.equal(true)
    expect(isValidState('a'.repeat(15) + ' ')).to.equal(false)
    expect(isValidState('a'.repeat(15) + '\n')).to.equal(false)
    expect(isValidState('a'.repeat(15) + '\u007f')).to.equal(false)
    expect(isValidState('a'.repeat(513))).to.equal(false)
  })

  it('base64url 去掉填充并替换 +/', function () {
    // 0xfb ff be -> 标准 Base64 "+/++" -> URL 安全 "-_--"
    expect(base64url(Buffer.from([251, 255, 190]))).to.equal('-_--')
    expect(base64url(Buffer.from([0, 0, 0]))).to.equal('AAAA')
  })
})
