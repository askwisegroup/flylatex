const crypto = require('crypto')
const logger = require('@overleaf/logger')
const { expressify } = require('@overleaf/promise-utils')
const {
  getCollectionInternal,
  ObjectId,
} = require('../../infrastructure/mongodb')
const Errors = require('../Errors/Errors')
const SessionManager = require('../Authentication/SessionManager')

const COLLECTION_NAME = 'desktop_sync_keys'
const KEY_PREFIX = 'flysync_'
const PREFIX_DISPLAY_LENGTH = 8

// FIXED: DesktopSync v1 —— 懒获取 collection，避免在模块加载（require）阶段连库。
// 原因：infrastructure/mongodb.js / Mongoose.js 在单测环境会在 require 时直接抛错，
// 且此时基础设施的 setupDb() 尚未运行。getCollectionInternal() 内部会 await 连接就绪。
//
// v1 不创建索引：集合规模小（用户数 × 每用户少量 Key），findOne 走集合扫描可接受。
// 后续按需补 { key_hash: 1 } unique（可手动进 mongo 容器，或沉淀为 migration），
// createIndex 幂等，应用代码无需改动。
let collectionPromise
function getCollection() {
  if (!collectionPromise) {
    collectionPromise = getCollectionInternal(COLLECTION_NAME)
  }
  return collectionPromise
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function generateKey() {
  // flysync_ + 32 字节随机十六进制
  return KEY_PREFIX + crypto.randomBytes(32).toString('hex')
}

const DesktopSyncKeys = {
  generateKey,
  hashKey,

  async createKeyForUser(userId, name) {
    const key = generateKey()
    const doc = {
      user_id: ObjectId(userId),
      name: name || null,
      key_hash: hashKey(key),
      key_prefix: key.slice(
        KEY_PREFIX.length,
        KEY_PREFIX.length + PREFIX_DISPLAY_LENGTH
      ),
      created_at: new Date(),
      last_used_at: null,
      revoked_at: null,
    }
    const collection = await getCollection()
    const { insertedId } = await collection.insertOne(doc)
    // 明文 key 仅在创建时返回一次；库里只存哈希
    return {
      id: insertedId,
      key,
      name: doc.name,
      key_prefix: `${KEY_PREFIX}${doc.key_prefix}…`,
      created_at: doc.created_at,
    }
  },

  async listKeysForUser(userId) {
    const collection = await getCollection()
    const keys = await collection
      .find({ user_id: ObjectId(userId), revoked_at: null })
      .sort({ created_at: -1 })
      .toArray()
    return keys.map(key => ({
      id: key._id,
      name: key.name,
      key_prefix: `${KEY_PREFIX}${key.key_prefix}…`,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
    }))
  },

  async revokeKeyForUser(userId, keyId) {
    if (!ObjectId.isValid(keyId)) {
      throw new Errors.NotFoundError('key not found')
    }
    const collection = await getCollection()
    const result = await collection.findOneAndUpdate(
      {
        _id: ObjectId(keyId),
        user_id: ObjectId(userId),
        revoked_at: null,
      },
      { $set: { revoked_at: new Date() } }
    )
    if (!result.value) {
      throw new Errors.NotFoundError('key not found')
    }
    return { id: keyId }
  },

  async findActiveKeyByHash(keyHash) {
    const collection = await getCollection()
    return collection.findOne({ key_hash: keyHash, revoked_at: null })
  },

  async touchKey(keyId, when = new Date()) {
    // last_used_at 仅用于审计，写入失败不影响主流程
    try {
      const collection = await getCollection()
      await collection.updateOne(
        { _id: keyId },
        { $set: { last_used_at: when } }
      )
    } catch (err) {
      logger.warn(
        { err, keyId },
        'failed to update desktop sync key last_used_at'
      )
    }
  },

  // --- Key 管理端点（webRouter，Web 登录态）---

  listKeys: expressify(async function listKeys(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const keys = await DesktopSyncKeys.listKeysForUser(userId)
    res.json({ keys })
  }),

  createKey: expressify(async function createKey(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const name = req.body && req.body.name
    const created = await DesktopSyncKeys.createKeyForUser(userId, name)
    res.status(201).json(created)
  }),

  revokeKey: expressify(async function revokeKey(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const revoked = await DesktopSyncKeys.revokeKeyForUser(
      userId,
      req.params.keyId
    )
    res.json({ revoked: true, id: revoked.id })
  }),
}

module.exports = DesktopSyncKeys
