'use strict'

/**
 * FIXED: 2026-11-16 Zotero API Key 的落库加密。
 *
 * 为什么不能明文存：Zotero 的 key 默认带读写权限（`access.user.library/files`），
 * 一旦库被导出/备份泄露，等于把用户的整个文献库（及附件）交出去。
 * 这里用 AES-256-GCM，密钥由 `Settings.security.sessionSecret` 派生出独立子钥，
 * 因此不需要额外配置；换了 sessionSecret 等于让所有旧 key 失效（用户重新绑一次即可）。
 */

const crypto = require('node:crypto')
const Settings = require('@overleaf/settings')

const ALGORITHM = 'aes-256-gcm'
const SALT = 'flylatex:zotero:api-key:v1'

function deriveKey() {
  const secret =
    (Settings.security && Settings.security.sessionSecret) ||
    process.env.SESSION_SECRET ||
    ''
  if (!secret) {
    throw new Error('缺少 Settings.security.sessionSecret，无法加密 Zotero key')
  }
  return crypto.createHash('sha256').update(`${SALT}:${secret}`).digest()
}

function encrypt(plainText) {
  if (typeof plainText !== 'string' || !plainText) {
    throw new Error('encrypt: 需要非空字符串')
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ])
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  }
}

function decrypt(payload) {
  if (!payload || typeof payload !== 'object' || !payload.data) {
    return null
  }
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      deriveKey(),
      Buffer.from(payload.iv, 'base64')
    )
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ])
    return decrypted.toString('utf8')
  } catch (error) {
    // 换了 sessionSecret / 数据损坏：当作未绑定，让用户重新绑一次
    return null
  }
}

/** 只给 UI 看的掩码：SpAb…wMC（不泄露完整 key） */
function maskKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 8) {
    return '***'
  }
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-3)}`
}

module.exports = { encrypt, decrypt, maskKey }
