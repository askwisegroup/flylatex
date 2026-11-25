#!/usr/bin/env node

/**
 * FIXED: 2026-10-23 用户 features 快照审计 / 修复
 *
 * 背景：
 *   `users.features` 是注册时写入的**快照**，不会随 Settings.defaultFeatures 变化。
 *   - 2025-06 之前默认 compileTimeout=180，之后改成了 300，老用户停留在 180（3 分钟）。
 *   - 部分老用户的 features 只有 compileTimeout，其余开关（dropbox/github/versioning/
 *     templates/trackChanges/references）缺失；而 UserGetter 走原生驱动，不会补默认值，
 *     导致这些功能对他们实际上是关闭的。
 *
 * 本脚本：
 *   1. 默认只读：统计 compileTimeout 分布、缺失字段分布、受影响用户数
 *   2. --apply 才写库，且每一项修复都可单独开关
 *
 * 安全约束：
 *   - 不动 VIP 用户（`vipEndDate` 有效）的 compileTimeout，避免把 600 降成 300
 *   - 不动显式设置过 180 的用户？无法区分，因此 180→300 默认需要 --fix-timeout 显式开启
 *   - 只补齐「缺失」的布尔/数值字段，不覆盖已有值
 *
 * 用法：
 *   node scripts/audit_user_features.js
 *   node scripts/audit_user_features.js --fix-missing
 *   node scripts/audit_user_features.js --fix-missing --fix-timeout
 *   node scripts/audit_user_features.js --fix-missing --fix-timeout --limit=100
 */

const minimist = require('minimist')
const { db, waitForDb } = require('../app/src/infrastructure/mongodb')
const Settings = require('@overleaf/settings')

const argv = minimist(process.argv.slice(2), {
  boolean: ['apply', 'fix-missing', 'fix-timeout', 'force'],
  string: ['limit', 'email', 'from', 'to'],
  default: { limit: '0', from: '180' },
})

// 目标值：优先 --to，其次当前生效的 Settings.defaultFeatures.compileTimeout
const DEFAULT_TIMEOUT = Number.parseInt(
  argv.to !== undefined ? argv.to : Settings.defaultFeatures.compileTimeout,
  10
)
// 历史遗留默认值；只处理这个值，避免误伤 1..600 之间的人工设置
const LEGACY_DEFAULT_TIMEOUT = Number.parseInt(argv.from, 10)

// 需要保证存在的 features 字段（取自 Settings.defaultFeatures）
const EXPECTED_FEATURE_KEYS = [
  'collaborators',
  'versioning',
  'dropbox',
  'github',
  'gitBridge',
  'compileTimeout',
  'compileGroup',
  'templates',
  'references',
  'trackChanges',
  'mendeley',
  'zotero',
  'referencesSearch',
  'symbolPalette',
]

function describe(value) {
  return value === undefined ? '(缺失)' : JSON.stringify(value)
}

async function main() {
  await waitForDb()

  const limit = parseInt(argv.limit, 10) || 0
  const apply = Boolean(argv.apply)
  const fixMissing = Boolean(argv['fix-missing'])
  const fixTimeout = Boolean(argv['fix-timeout'])

  if ((fixMissing || fixTimeout) && !apply) {
    console.log('提示：--fix-missing / --fix-timeout 只在 --apply 时生效')
    console.log('')
  }

  const query = {}
  if (argv.email) {
    query.email = argv.email
  }

  console.log('=== 当前配置 ===')
  console.log(
    '  生效的 defaultFeatures.compileTimeout  :',
    Settings.defaultFeatures.compileTimeout
  )
  console.log('  本次要迁移的遗留值 (--from)            :', LEGACY_DEFAULT_TIMEOUT)
  console.log('  本次要写入的目标值 (--to)              :', DEFAULT_TIMEOUT)
  console.log(
    '  模式                                   :',
    apply ? 'APPLY（会写库）' : 'READ-ONLY'
  )
  console.log('')

  // 目标值等于遗留值时，--fix-timeout 会变成空操作，必须显式拦下
  if (fixTimeout && DEFAULT_TIMEOUT === LEGACY_DEFAULT_TIMEOUT) {
    console.error(
      '拒绝执行：--to 与 --from 相同（都是 ' +
        DEFAULT_TIMEOUT +
        '），不会产生任何变化。'
    )
    console.error(
      '  原因通常是线上 /etc/sharelatex/settings.js 仍把 ' +
        'defaultFeatures.compileTimeout 覆盖成了旧值。'
    )
    console.error(
      '  请先修正该配置，或用 --to=' +
        (Settings.compileTimeouts || {}).fallback +
        ' 指定目标值。'
    )
    console.error('  确认要在配置不变的情况下强行执行，请追加 --force。')
    if (!argv.force) process.exit(1)
  }
  console.log('')

  // 1) compileTimeout 分布
  console.log('=== compileTimeout 分布 ===')
  const timeoutAgg = await db.users
    .aggregate([
      { $match: query },
      {
        $group: {
          _id: '$features.compileTimeout',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray()
  for (const row of timeoutAgg) {
    console.log(
      `  ${String(describe(row._id)).padEnd(12)} ${String(row.count).padStart(8)} 人`
    )
  }
  if (timeoutAgg.length === 0) console.log('  （无数据）')

  // 2) 缺失字段分布
  console.log('')
  console.log('=== features 字段缺失统计 ===')
  let anyMissing = false
  for (const key of EXPECTED_FEATURE_KEYS) {
    // 不在 defaultFeatures 里的键（如 mendeley / zotero / symbolPalette）
    // 本来就是「缺省即关闭」，不算异常，跳过
    if (Settings.defaultFeatures[key] === undefined) continue
    const missing = await db.users.countDocuments({
      ...query,
      [`features.${key}`]: { $exists: false },
    })
    if (missing > 0) {
      anyMissing = true
      console.log(`  ${key.padEnd(18)} 缺失 ${String(missing).padStart(8)} 人`)
    }
  }
  if (!anyMissing) console.log('  （无）')

  // 3) 受影响样本
  console.log('')
  console.log('=== 样本（compileTimeout=180 或 features 字段不全） ===')
  const sampleQuery = {
    ...query,
    $or: [
      { 'features.compileTimeout': LEGACY_DEFAULT_TIMEOUT },
      { 'features.dropbox': { $exists: false } },
      { 'features.versioning': { $exists: false } },
    ],
  }
  const total = await db.users.countDocuments(sampleQuery)
  console.log(`  匹配总数: ${total}`)

  const sampleLimit = limit > 0 ? limit : 10
  const samples = await db.users
    .find(sampleQuery, {
      projection: {
        email: 1,
        signUpDate: 1,
        vipEndDate: 1,
        featuresUpdatedAt: 1,
        features: 1,
      },
    })
    .limit(sampleLimit)
    .toArray()

  for (const user of samples) {
    const features = user.features || {}
    console.log(
      `  ${String(user.email || user._id).padEnd(34)} ` +
        `注册 ${user.signUpDate ? user.signUpDate.toISOString().slice(0, 10) : '-'}  ` +
        `timeout=${String(describe(features.compileTimeout)).padEnd(8)} ` +
        `dropbox=${String(features.dropbox).padEnd(5)} ` +
        `versioning=${String(features.versioning).padEnd(5)} ` +
        `vip=${user.vipEndDate ? user.vipEndDate.toISOString().slice(0, 10) : '-'}`
    )
  }

  if (!apply || (!fixMissing && !fixTimeout)) {
    console.log('')
    console.log('未写库。确认无误后按需执行：')
    console.log('  node scripts/audit_user_features.js --apply --fix-missing')
    console.log(
      '  node scripts/audit_user_features.js --apply --fix-missing --fix-timeout' +
        (DEFAULT_TIMEOUT === LEGACY_DEFAULT_TIMEOUT
          ? ' --to=' + (Settings.compileTimeouts || {}).fallback
          : '')
    )
    return
  }

  // 4) 修复：补齐缺失字段
  if (fixMissing) {
    console.log('')
    console.log('=== 补齐缺失字段 ===')
    let patched = 0
    for (const key of EXPECTED_FEATURE_KEYS) {
      const value = Settings.defaultFeatures[key]
      if (value === undefined) continue
      const result = await db.users.updateMany(
        { ...query, [`features.${key}`]: { $exists: false } },
        { $set: { [`features.${key}`]: value } }
      )
      if (result.modifiedCount > 0) {
        patched += result.modifiedCount
        console.log(`  ${key.padEnd(18)} 补齐 ${result.modifiedCount} 人 -> ${JSON.stringify(value)}`)
      }
    }
    console.log(`  合计补齐 ${patched} 个字段值`)
  }

  // 5) 修复：180 -> 当前默认（跳过 VIP）
  if (fixTimeout) {
    console.log('')
    console.log(
      '=== compileTimeout ' +
        LEGACY_DEFAULT_TIMEOUT +
        ' -> ' +
        DEFAULT_TIMEOUT +
        '（跳过 VIP） ==='
    )
    const now = new Date()
    const result = await db.users.updateMany(
      {
        ...query,
        'features.compileTimeout': LEGACY_DEFAULT_TIMEOUT,
        $or: [
          { vipEndDate: { $exists: false } },
          { vipEndDate: null },
          { vipEndDate: { $lt: now } },
        ],
      },
      { $set: { 'features.compileTimeout': DEFAULT_TIMEOUT } }
    )
    console.log(`  已更新 ${result.modifiedCount} 人`)
  }

  console.log('')
  console.log('完成。')
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
