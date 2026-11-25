'use strict'

/**
 * FIXED: 2026-10-23 NE 账号属性（机构 / VIP 配额）的统一同步逻辑
 *
 * 背景与问题：
 *   1. `institution` 只由 NE 返回的 `inst_name` 覆盖式写入，没有来源标记：
 *      - 无法区分「自动同步」与「人工确认」，人工修正后下次登录又会被改回去
 *      - 历史 IP 推断留下的脏数据无法识别
 *   2. VIP 配额（features.compileTimeout）原来只在 CARSI 登录时同步，
 *      密码 / 短信登录完全不管，VIP 过期后会一直保留 600 秒配额。
 *   3. 原实现用 `$set: { features: {...} }` 整体替换 features，
 *      会把 dropbox / github / versioning 等布尔开关全部抹掉。
 *
 * 本模块把这两件事收敛为一处，供 CARSI 回调与 AuthenticationManager 共用：
 *   - 机构：白名单校验 + 来源标记（ne / manual）+ 人工修正后不再覆盖
 *   - VIP ：按账号级别（type/type_txt + vip_end）判定，只改两个点路径字段
 */

const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const { User } = require('../../models/User')

// FIXED: 2026-10-23 超时数值统一来自 Settings.compileTimeouts，
// 不在业务代码里重复写 300 / 600 这些字面量。
const COMPILE_TIMEOUTS = Settings.compileTimeouts || {}
const VIP_COMPILE_TIMEOUT = COMPILE_TIMEOUTS.vip
const DEFAULT_COMPILE_TIMEOUT =
  (Settings.defaultFeatures && Settings.defaultFeatures.compileTimeout) ||
  COMPILE_TIMEOUTS.default

const SOURCE_NE = 'ne'
const SOURCE_MANUAL = 'manual'

// 机构名单缓存：Mongo 的 institutions 集合是唯一事实源（carsi-mgr 维护）。
// 早期版本读的是仓库里的 institutions.json，现已废弃。
const INSTITUTIONS_CACHE_TTL_MS = 5 * 60 * 1000
let institutionNamesCache = null
let institutionNamesLoadedAt = 0
let institutionLoadWarned = false
// 同一机构只告警一次，避免每次登录刷日志
const warnedInstitutions = new Set()

function _resetInstitutionCacheForTests() {
  institutionNamesCache = null
  institutionNamesLoadedAt = 0
  institutionLoadWarned = false
  warnedInstitutions.clear()
}

/**
 * 读取 Mongo `institutions` 集合里的机构名（eduName）。
 * 读不到时返回 null，表示「无法校验」——此时放行写入并只记一次告警，
 * 绝不因为名单不可用而阻断登录或清空用户已有机构。
 */
function _loadInstitutionNames(callback) {
  callback = callback || function () {}

  if (
    institutionNamesCache &&
    Date.now() - institutionNamesLoadedAt < INSTITUTIONS_CACHE_TTL_MS
  ) {
    return callback(null, institutionNamesCache)
  }

  // 惰性 require：避免单测环境因连接 Mongo 的守卫而整体加载失败
  let collection = null
  try {
    const { db } = require('../../infrastructure/mongodb')
    if (db && db.institutions && typeof db.institutions.find === 'function') {
      collection = db.institutions
    }
  } catch (err) {
    collection = null
  }

  // 集合不可用（如单测未注入、或部署未启用机构表）时视为「无法校验」
  if (!collection) {
    if (!institutionLoadWarned) {
      institutionLoadWarned = true
      logger.warn(
        {},
        'ne-account-sync: institutions 集合不可用，跳过机构名单校验'
      )
    }
    return callback(null, null)
  }

  collection.find(
    // 用 $exists/$ne 而非 $type:'string'，兼容老版本 MongoDB 的类型别名差异
    { eduName: { $exists: true, $ne: '' } },
    { projection: { eduName: 1 } }
  ).toArray(function (err, docs) {
    if (err) {
      if (!institutionLoadWarned) {
        institutionLoadWarned = true
        logger.warn(
          { err },
          'ne-account-sync: 读取 institutions 集合失败，跳过机构名单校验'
        )
      }
      return callback(null, null)
    }
    institutionNamesCache = new Set(
      (docs || [])
        .map(doc => String((doc && doc.eduName) || '').trim())
        .filter(Boolean)
    )
    institutionNamesLoadedAt = Date.now()
    callback(null, institutionNamesCache)
  })
}

/**
 * 解析 NE 账号的 VIP 状态。
 *
 * CARSI 路径传的是已计算好的布尔 `isVip`（已与有效期做过 AND），
 * 密码 / 短信路径拿到的是原始 `type` / `type_txt` / `vip_end`。
 * 两种形态都要能识别。
 */
function resolveVipState(userInfo) {
  const info = userInfo || {}

  let isVip
  if (typeof info.isVip === 'boolean') {
    isVip = info.isVip
  } else {
    const typeTxt = String(info.type_txt || '')
    isVip = info.type === 2 || typeTxt.indexOf('VIP') !== -1
  }

  let vipEndDate = null
  const raw = info.vipEndDate || info.vip_end
  if (raw) {
    const parsed = raw instanceof Date ? raw : new Date(raw)
    if (!Number.isNaN(parsed.getTime())) {
      vipEndDate = parsed
    }
  }

  const isVipActive = Boolean(
    isVip && vipEndDate && vipEndDate.getTime() > Date.now()
  )

  return { isVip: Boolean(isVip), vipEndDate, isVipActive }
}

/**
 * 机构字段：#FIXED 2026-10-23
 * - 空值不写入（不能把用户已有机构清空）
 * - 人工确认过的机构（institutionSource=manual）不再被自动覆盖
 * - 与 Mongo `institutions` 集合比对，结果写入 `institutionVerified`：
 *     true  = 在机构名单中
 *     false = 不在名单中（仍写入，但记告警，便于人工核对）
 *   注意：该集合是**已开通机构**名单，不是全国高校全集，
 *   因此绝不能用它做硬拦截——硬拦会把正常用户的机构清空。
 *
 * @param {object} user 现有用户（新建时传空对象）
 * @param {string} instName NE 返回的机构名
 * @param {Set<string>|null} knownNames 机构名单；null 表示无法校验
 */
function buildInstitutionFields(user, instName, knownNames) {
  const value = typeof instName === 'string' ? instName.trim() : ''

  if (!value) {
    return { fields: {}, value: '', reason: 'empty' }
  }

  if (user && user.institutionSource === SOURCE_MANUAL) {
    return { fields: {}, value: value, reason: 'manual-locked' }
  }

  const verified = knownNames ? knownNames.has(value) : null
  if (verified === false && !warnedInstitutions.has(value)) {
    warnedInstitutions.add(value)
    logger.warn(
      { userId: user && user._id, institution: value },
      'ne-account-sync: 机构名不在 institutions 集合中，已写入并标记为未核实'
    )
  }

  const verifiedFields =
    verified === null ? {} : { institutionVerified: verified }

  if (user && user.institution === value) {
    const markFields = {}
    if (user.institutionSource !== SOURCE_NE) {
      markFields.institutionSource = SOURCE_NE
    }
    if (verified !== null && user.institutionVerified !== verified) {
      markFields.institutionVerified = verified
    }
    if (Object.keys(markFields).length === 0) {
      return { fields: {}, value: value, reason: 'unchanged' }
    }
    return {
      fields: markFields,
      value: value,
      reason: 'unchanged-mark',
    }
  }

  return {
    fields: Object.assign(
      {
        institution: value,
        institutionSource: SOURCE_NE,
        institutionUpdatedAt: new Date(),
      },
      verifiedFields
    ),
    value: value,
    reason: 'updated',
  }
}

/**
 * VIP 配额字段：#FIXED 2026-10-23
 *
 * 只改 `features.compileTimeout` 与 `features.collaborators` 两个点路径，
 * 不再整体替换 features，避免抹掉 dropbox / github / versioning 等开关。
 *
 * 降级保护：只有存在 `vipEndDate` 记录（即确实当过 VIP）才降级，
 * 避免把人工授予 600 秒配额的非 VIP 账号误降。
 */
function buildVipFields(user, userInfo) {
  const state = resolveVipState(userInfo)
  const features = (user && user.features) || {}
  const currentTimeout = Number(features.compileTimeout) || 0
  const fields = {}

  // 配置缺失时宁可不写，也不要往用户文档里写 undefined
  if (!Number.isFinite(VIP_COMPILE_TIMEOUT)) {
    logger.warn(
      { userId: user && user._id },
      'ne-account-sync: Settings.compileTimeouts.vip 缺失，跳过 VIP 配额同步'
    )
    return { fields, state, vipActive: false, downgraded: false }
  }

  if (state.isVipActive) {
    if (currentTimeout !== VIP_COMPILE_TIMEOUT) {
      fields['features.compileTimeout'] = VIP_COMPILE_TIMEOUT
    }
    if (features.collaborators !== -1) {
      fields['features.collaborators'] = -1
    }
    if (state.vipEndDate) {
      fields.vipEndDate = state.vipEndDate
    }
    if (user && user.vipExpired !== false) {
      fields.vipExpired = false
    }
    return { fields, state, vipActive: true, downgraded: false }
  }

  if (currentTimeout >= VIP_COMPILE_TIMEOUT) {
    if (!user || !user.vipEndDate) {
      logger.warn(
        { userId: user && user._id },
        'ne-account-sync: 用户拥有 prof 配额但缺少 VIP 到期记录，跳过降级'
      )
      return { fields, state, vipActive: false, downgraded: false }
    }
    fields['features.compileTimeout'] = DEFAULT_COMPILE_TIMEOUT
    fields.vipExpired = true
    if (state.vipEndDate) {
      fields.vipEndDate = state.vipEndDate
    }
    return { fields, state, vipActive: false, downgraded: true }
  }

  return { fields, state, vipActive: false, downgraded: false }
}

/**
 * 把机构字段与 VIP 字段合并为一次 $set 所需的扁平对象（features 用点路径）。
 * 机构名单来自 Mongo，因此是异步接口。
 */
function buildSyncFields(user, userInfo, callback) {
  if (typeof callback !== 'function') {
    throw new Error('buildSyncFields requires a callback')
  }
  _loadInstitutionNames(function (err, knownNames) {
    if (err) {
      return callback(err)
    }
    const institution = buildInstitutionFields(
      user,
      userInfo && userInfo.inst_name,
      knownNames
    )
    const vip = buildVipFields(user, userInfo)

    if (institution.reason === 'manual-locked') {
      logger.info(
        {
          userId: user && user._id,
          preservedInstitution: user && user.institution,
          neInstitution: institution.value,
        },
        'ne-account-sync: 机构为人工确认值，保留不覆盖'
      )
    }

    callback(null, {
      fields: Object.assign({}, institution.fields, vip.fields),
      institution: institution,
      vip: vip,
    })
  })
}

/** 创建新用户时的嵌套字段（不能使用点路径） */
function buildNewUserFields(userInfo, callback) {
  if (typeof callback !== 'function') {
    throw new Error('buildNewUserFields requires a callback')
  }
  _loadInstitutionNames(function (err, knownNames) {
    if (err) {
      return callback(err)
    }
    const fields = {}

    const institution = buildInstitutionFields(
      { institution: '', institutionSource: '' },
      userInfo && userInfo.inst_name,
      knownNames
    )
    if (institution.fields.institution) {
      fields.institution = institution.fields.institution
      fields.institutionSource = institution.fields.institutionSource
      if (institution.fields.institutionVerified !== undefined) {
        fields.institutionVerified = institution.fields.institutionVerified
      }
    }

    const state = resolveVipState(userInfo)
    if (state.isVipActive) {
      fields.features = {
        compileTimeout: VIP_COMPILE_TIMEOUT,
        collaborators: -1,
      }
      if (state.vipEndDate) {
        fields.vipEndDate = state.vipEndDate
      }
      fields.vipExpired = false
    }

    callback(null, fields)
  })
}

function _assignField(target, key, value) {
  const parts = key.split('.')
  if (parts.length === 1) {
    target[key] = value
    return
  }
  let cursor = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!cursor[part] || typeof cursor[part] !== 'object') {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
}

/** 写库并同步内存对象；无变化时不发起写请求 */
function applyFields(user, fields, callback) {
  const keys = Object.keys(fields || {})
  if (keys.length === 0) {
    return callback(null, user)
  }

  User.updateOne({ _id: user._id }, { $set: fields }, function (err) {
    if (err) {
      return callback(err)
    }
    for (const key of keys) {
      _assignField(user, key, fields[key])
    }
    callback(null, user)
  })
}

module.exports = {
  VIP_COMPILE_TIMEOUT,
  DEFAULT_COMPILE_TIMEOUT,
  SOURCE_NE,
  SOURCE_MANUAL,
  resolveVipState,
  buildInstitutionFields,
  buildVipFields,
  buildSyncFields,
  buildNewUserFields,
  applyFields,
  _resetInstitutionCacheForTests,
}
