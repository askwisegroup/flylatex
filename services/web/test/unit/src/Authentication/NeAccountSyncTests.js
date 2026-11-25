const { expect } = require('chai')
const path = require('path')
const Module = require('module')

const WEB = path.resolve(__dirname, '../../../../..')
const SYNC = path.join(WEB, 'app/src/Features/Authentication/NeAccountSync.js')
const MONGO = path.join(WEB, 'app/src/infrastructure/mongodb.js')
const USER_MODEL = path.join(WEB, 'app/src/models/User.js')

const ORIGINAL_USER = { updateOne: null }

let institutions
const updates = []

function loadSync() {
  const originalRequire = Module.prototype.require
  Module.prototype.require = function (name) {
    if (name === '@overleaf/settings') {
      return {
        defaultFeatures: { compileTimeout: 300 },
        // FIXED: 2026-10-23 超时数值统一来自 Settings.compileTimeouts
        compileTimeouts: {
          fallback: 300,
          min: 60,
          max: 600,
          vip: 600,
          default: 300,
        },
      }
    }
    if (name === '@overleaf/logger') {
      return { warn() {}, info() {}, err() {}, debug() {} }
    }
    let resolved
    try {
      resolved = Module._resolveFilename(name, this)
    } catch (err) {}
    if (resolved === MONGO) {
      return {
        db: {
          institutions: {
            find: () => ({
              toArray: cb => cb(null, institutions),
            }),
          },
        },
      }
    }
    if (resolved === USER_MODEL) {
      return {
        User: {
          updateOne(query, update, cb) {
            updates.push(update)
            cb(null)
          },
        },
      }
    }
    return originalRequire.apply(this, arguments)
  }
  try {
    delete require.cache[SYNC]
    return require(SYNC)
  } finally {
    Module.prototype.require = originalRequire
  }
}

describe('NeAccountSync', function () {
  let sync

  beforeEach(function () {
    institutions = [
      { eduName: '中山大学' },
      { eduName: '深圳大学' },
      { eduName: ' expired-but-listed ' },
    ]
    updates.length = 0
    sync = loadSync()
    sync._resetInstitutionCacheForTests()
  })

  describe('buildSyncFields / 机构', function () {
    it('写入 NE 返回的机构，并标记来源与核实结果', function (done) {
      const user = { _id: 'u1', institution: '', institutionSource: '' }
      sync.buildSyncFields(
        user,
        { inst_name: '中山大学', type: 1, type_txt: '普通用户' },
        (err, result) => {
          expect(err).to.equal(null)
          expect(result.fields.institution).to.equal('中山大学')
          expect(result.fields.institutionSource).to.equal('ne')
          expect(result.fields.institutionVerified).to.equal(true)
          expect(result.institution.reason).to.equal('updated')
          done()
        }
      )
    })

    it('机构为空时不清空已有值', function (done) {
      const user = { _id: 'u1', institution: '深圳大学', institutionSource: 'ne' }
      sync.buildSyncFields(user, { inst_name: '' }, (err, result) => {
        expect(err).to.equal(null)
        expect(result.fields.institution).to.equal(undefined)
        expect(result.institution.reason).to.equal('empty')
        done()
      })
    })

    it('人工确认过的机构不被登录覆盖', function (done) {
      const user = {
        _id: 'u1',
        institution: '深圳大学',
        institutionSource: 'manual',
      }
      sync.buildSyncFields(user, { inst_name: '中山大学' }, (err, result) => {
        expect(err).to.equal(null)
        expect(result.fields.institution).to.equal(undefined)
        expect(result.institution.reason).to.equal('manual-locked')
        done()
      })
    })

    it('不在名单中的机构仍然写入，只标记为未核实', function (done) {
      const user = { _id: 'u1', institution: '', institutionSource: '' }
      sync.buildSyncFields(
        user,
        { inst_name: '某某职业学院' },
        (err, result) => {
          expect(err).to.equal(null)
          expect(result.fields.institution).to.equal('某某职业学院')
          expect(result.fields.institutionVerified).to.equal(false)
          done()
        }
      )
    })

    it('机构未变化时不产生写请求', function (done) {
      const user = {
        _id: 'u1',
        institution: '中山大学',
        institutionSource: 'ne',
        institutionVerified: true,
      }
      sync.buildSyncFields(user, { inst_name: '中山大学' }, (err, result) => {
        expect(err).to.equal(null)
        expect(result.fields).to.deep.equal({})
        expect(result.institution.reason).to.equal('unchanged')
        done()
      })
    })
  })

  describe('buildSyncFields / VIP', function () {
    it('VIP 生效时只提升 compileTimeout，不动其它 features', function (done) {
      const user = {
        _id: 'u1',
        institution: '中山大学',
        institutionSource: 'ne',
        institutionVerified: true,
        features: {
          compileTimeout: 300,
          collaborators: 1,
          dropbox: true,
          github: true,
          versioning: true,
        },
      }
      const vipEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000)
      sync.buildSyncFields(
        user,
        { inst_name: '中山大学', type: 2, type_txt: 'VIP会员', vip_end: vipEnd },
        (err, result) => {
          expect(err).to.equal(null)
          expect(result.fields['features.compileTimeout']).to.equal(600)
          expect(result.fields['features.collaborators']).to.equal(-1)
          expect(result.fields.vipExpired).to.equal(false)
          // 关键：不能整体替换 features
          expect(Object.keys(result.fields)).to.not.include('features')
          expect(result.vip.vipActive).to.equal(true)
          done()
        }
      )
    })

    it('VIP 过期时降级回默认值并标记', function (done) {
      const past = new Date(Date.now() - 24 * 3600 * 1000)
      const user = {
        _id: 'u1',
        institution: '中山大学',
        institutionSource: 'ne',
        institutionVerified: true,
        vipEndDate: past,
        vipExpired: false,
        features: { compileTimeout: 600, dropbox: true },
      }
      sync.buildSyncFields(
        user,
        { inst_name: '中山大学', type: 1, type_txt: '普通用户', vip_end: past },
        (err, result) => {
          expect(err).to.equal(null)
          expect(result.fields['features.compileTimeout']).to.equal(300)
          expect(result.fields.vipExpired).to.equal(true)
          expect(result.vip.downgraded).to.equal(true)
          done()
        }
      )
    })

    it('非 VIP 且从未有过 vipEndDate 时不动配额（避免误降人工授予）', function (done) {
      const user = {
        _id: 'u1',
        institution: '中山大学',
        institutionSource: 'ne',
        institutionVerified: true,
        features: { compileTimeout: 600 },
      }
      sync.buildSyncFields(
        user,
        { inst_name: '中山大学', type: 1, type_txt: '普通用户' },
        (err, result) => {
          expect(err).to.equal(null)
          expect(result.fields['features.compileTimeout']).to.equal(undefined)
          expect(result.vip.downgraded).to.equal(false)
          done()
        }
      )
    })

    it('已经是 VIP 配额时不重复写入', function (done) {
      const vipEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000)
      const user = {
        _id: 'u1',
        institution: '中山大学',
        institutionSource: 'ne',
        institutionVerified: true,
        vipEndDate: vipEnd,
        vipExpired: false,
        features: { compileTimeout: 600, collaborators: -1 },
      }
      sync.buildSyncFields(
        user,
        { inst_name: '中山大学', type: 2, type_txt: 'VIP会员', vip_end: vipEnd },
        (err, result) => {
          expect(err).to.equal(null)
          expect(result.fields['features.compileTimeout']).to.equal(undefined)
          done()
        }
      )
    })
  })

  describe('applyFields', function () {
    it('按点路径写回内存对象，且不整体替换 features', function (done) {
      const user = { _id: 'u1', features: { compileTimeout: 300, dropbox: true } }
      sync.applyFields(
        user,
        { 'features.compileTimeout': 600, institution: '中山大学' },
        (err, updated) => {
          expect(err).to.equal(null)
          expect(updated.features.compileTimeout).to.equal(600)
          expect(updated.features.dropbox).to.equal(true)
          expect(updated.institution).to.equal('中山大学')
          expect(updates).to.have.length(1)
          done()
        }
      )
    })

    it('没有字段时不发起写请求', function (done) {
      const user = { _id: 'u1' }
      sync.applyFields(user, {}, (err, updated) => {
        expect(err).to.equal(null)
        expect(updated).to.equal(user)
        expect(updates).to.have.length(0)
        done()
      })
    })
  })

  describe('resolveVipState', function () {
    it('识别 CARSI 预计算布尔值', function () {
      const state = sync.resolveVipState({ isVip: true, vipEndDate: new Date(Date.now() + 10000) })
      expect(state.isVipActive).to.equal(true)
    })

    it('type=2 视为 VIP，但无到期时间时不算生效', function () {
      const state = sync.resolveVipState({ type: 2, type_txt: 'VIP会员' })
      expect(state.isVip).to.equal(true)
      expect(state.isVipActive).to.equal(false)
    })

    it('普通用户不算 VIP', function () {
      const state = sync.resolveVipState({ type: 1, type_txt: '普通用户' })
      expect(state.isVip).to.equal(false)
      expect(state.isVipActive).to.equal(false)
    })
  })
})
