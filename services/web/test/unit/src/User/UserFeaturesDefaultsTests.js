const { expect } = require('chai')
const path = require('path')
const SandboxedModule = require('sandboxed-module')

const modulePath = path.join(
  __dirname,
  '../../../../app/src/Features/User/UserFeaturesDefaults'
)

const DEFAULT_FEATURES = {
  collaborators: -1,
  dropbox: true,
  github: true,
  gitBridge: true,
  versioning: true,
  compileTimeout: 300,
  compileGroup: 'standard',
  references: true,
  templates: true,
  trackChanges: true,
}

describe('UserFeaturesDefaults', function () {
  beforeEach(function () {
    this.settings = { defaultFeatures: Object.assign({}, DEFAULT_FEATURES) }
    this.UserFeaturesDefaults = SandboxedModule.require(modulePath, {
      requires: {
        '@overleaf/settings': this.settings,
        '@overleaf/logger': {
          warn() {},
          info() {},
          err() {},
          debug() {},
        },
      },
    })
  })

  describe('normalizeUserFeatures', function () {
    it('补齐老用户缺失的 features 字段', function () {
      const user = { _id: 'u1', features: { compileTimeout: 180 } }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, {})

      expect(user.features.compileTimeout).to.equal(180) // 已有值不动
      expect(user.features.dropbox).to.equal(true)
      expect(user.features.versioning).to.equal(true)
      expect(user.features.trackChanges).to.equal(true)
      expect(user.features.templates).to.equal(true)
      expect(user.features.references).to.equal(true)
      expect(user.features.collaborators).to.equal(-1)
      expect(user.features.compileGroup).to.equal('standard')
    })

    it('不覆盖已有的 false / 自定义值', function () {
      const user = {
        _id: 'u2',
        features: {
          dropbox: false,
          github: false,
          compileTimeout: 600,
          collaborators: 3,
        },
      }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, { features: 1 })

      expect(user.features.dropbox).to.equal(false)
      expect(user.features.github).to.equal(false)
      expect(user.features.compileTimeout).to.equal(600)
      expect(user.features.collaborators).to.equal(3)
    })

    it('features 整体缺失时按默认值补齐', function () {
      const user = { _id: 'u3' }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, {})

      expect(user.features.compileTimeout).to.equal(300)
      expect(user.features.dropbox).to.equal(true)
    })

    it('未投影 features 的查询不受影响', function () {
      const user = { _id: 'u4', email: 'a@b.c' }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, { email: 1 })

      expect(user.features).to.equal(undefined)
    })

    it('投影显式为 0/false 的 features 时不处理', function () {
      const user = { _id: 'u5' }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, { features: 0 })

      expect(user.features).to.equal(undefined)
    })

    it('user 为空时安全返回', function () {
      expect(
        this.UserFeaturesDefaults.normalizeUserFeatures(null, {})
      ).to.equal(null)
      expect(
        this.UserFeaturesDefaults.normalizeUserFeatures(undefined, {})
      ).to.equal(undefined)
    })

    it('features 结构异常时不猜测', function () {
      const user = { _id: 'u6', features: 'broken' }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, {})

      expect(user.features).to.equal('broken')
    })

    it('defaultFeatures 不可用时不修改也不抛错', function () {
      this.settings.defaultFeatures = undefined
      const user = { _id: 'u7', features: { compileTimeout: 180 } }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, {})

      expect(user.features).to.deep.equal({ compileTimeout: 180 })
    })

    it('不写入 defaultFeatures 里未定义的键', function () {
      this.settings.defaultFeatures = { compileTimeout: 300, mendeley: undefined }
      const user = { _id: 'u8', features: {} }
      this.UserFeaturesDefaults.normalizeUserFeatures(user, {})

      expect(user.features).to.deep.equal({ compileTimeout: 300 })
      expect('mendeley' in user.features).to.equal(false)
    })
  })

  describe('normalizeUsersFeatures', function () {
    it('批量补齐', function () {
      const users = [
        { _id: 'a', features: { compileTimeout: 180 } },
        { _id: 'b', features: { compileTimeout: 300, dropbox: false } },
      ]
      this.UserFeaturesDefaults.normalizeUsersFeatures(users, {})

      expect(users[0].features.dropbox).to.equal(true)
      expect(users[1].features.dropbox).to.equal(false)
    })

    it('非数组安全返回', function () {
      expect(
        this.UserFeaturesDefaults.normalizeUsersFeatures(null, {})
      ).to.equal(null)
    })
  })
})
