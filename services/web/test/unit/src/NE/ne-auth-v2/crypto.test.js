const { expect } = require('chai')
const crypto = require('crypto')

const {
  rsaEncryptBase64,
  cipherByteLength,
} = require('../../../../../commercial/ne-auth-v2/crypto')

describe('ne-auth-v2/crypto', function () {
  let publicKeyPem
  let privateKey

  before(function () {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    privateKey = pair.privateKey
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' })
  })

  function decrypt(cipherBase64) {
    return crypto
      .privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(cipherBase64, 'base64')
      )
      .toString('utf8')
  }

  it('输出标准 Base64，且能用 PKCS#1 v1.5 私钥解回原文', function () {
    const cipher = rsaEncryptBase64('test-secret', publicKeyPem)
    expect(cipher).to.be.a('string')
    // 2048 位密钥 -> 256 字节密文 -> 344 个 Base64 字符（含 '=' 填充）
    expect(Buffer.from(cipher, 'base64').length).to.equal(256)
    expect(cipher.length).to.equal(344)
    expect(cipher).to.match(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(decrypt(cipher)).to.equal('test-secret')
  })

  it('正确处理多字节 UTF-8 与特殊字符', function () {
    for (const plain of [
      '密码123',
      'a+b/c=d',
      '有空格 的密码',
      'emoji🔐test',
    ]) {
      expect(decrypt(rsaEncryptBase64(plain, publicKeyPem))).to.equal(plain)
    }
  })

  it('同一明文每次密文不同（PKCS#1 v1.5 随机填充）', function () {
    const a = rsaEncryptBase64('same', publicKeyPem)
    const b = rsaEncryptBase64('same', publicKeyPem)
    expect(a).to.not.equal(b)
    expect(decrypt(a)).to.equal('same')
    expect(decrypt(b)).to.equal('same')
  })

  it('拒绝非字符串明文', function () {
    expect(() => rsaEncryptBase64(12345, publicKeyPem)).to.throw(TypeError)
  })

  it('拒绝非法公钥', function () {
    expect(() => rsaEncryptBase64('x', 'not-a-pem')).to.throw(TypeError)
    expect(() => rsaEncryptBase64('x', '')).to.throw(TypeError)
    expect(() => rsaEncryptBase64('x', undefined)).to.throw(TypeError)
  })

  it('cipherByteLength 返回模长字节数', function () {
    expect(cipherByteLength(publicKeyPem)).to.equal(256)
  })
})
