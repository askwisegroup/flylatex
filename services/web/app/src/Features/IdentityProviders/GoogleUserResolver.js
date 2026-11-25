'use strict'

/**
 * Google 登录 → 本地用户 的解析与绑定。
 *
 * 这是**唯一**允许把 Google 身份落库的地方。刻意不复用
 * `AuthenticationManager._findOrUpdateByEmailOrCreate`：那条路径与 NE
 * 用户中心（account_id / carsiEmail / VIP / 机构）深度耦合，改它等于改
 * 中国站的登录语义。海外站走独立模块，互不影响。
 *
 * 三条安全底线（改动前请确认仍然成立）：
 *
 *   1. **同邮箱必须绑定，不能新建。** 海外用户第一次用 Gmail 登录时，
 *      若该邮箱在中国站已有账号（`email` 或 `carsiEmail` 命中），必须合并
 *      到那个账号 —— 否则用户会看到"我的项目全没了"，而且两个账号
 *      `_id` 不同，历史版本、协作关系、订阅全部断掉。
 *
 *   2. **不同 sub 不允许抢占同一账号。** 若目标账号已绑定另一个 Google
 *      `sub`，说明有人在冒充或用户换了 Google 账号 —— 必须拒绝并留日志，
 *      绝不能静默改绑。改绑只能由用户主动操作（后续"账号设置 → 解绑"）。
 *
 *   3. **不写 NE 字段。** `account_id` / `vipEndDate` / `institution*`
 *      保持原样，不能被 Google 登录顺手清空。
 */

const logger = require('@overleaf/logger')
const { User } = require('../../models/User')
const UserCreator = require('../User/UserCreator')

/**
 * @typedef {object} GoogleIdentity
 * @property {string} sub    Google 稳定用户标识
 * @property {string} email  已由 Google 验证的邮箱
 * @property {string} [name]
 * @property {string} [picture]
 */

/**
 * @param {GoogleIdentity} identity
 * @returns {Promise<{user:object, created:boolean, linked:boolean}>}
 */
async function resolveGoogleUser(identity) {
  const sub = String(identity.sub || '')
  const email = String(identity.email || '').trim()

  if (!sub) throw new Error('google_identity_missing_sub')
  if (!email) throw new Error('google_identity_missing_email')

  // ---- 1. 已绑定过：最稳的路径 ----
  const bySub = await User.findOne({ googleSub: sub })
  if (bySub) {
    // 用户可能在 Google 侧改了邮箱（企业域改名）。同步显示用的 googleEmail，
    // 但**不动主 email**：主 email 决定登录标识与协作邀请，改名不应当顺带改它。
    if (bySub.googleEmail !== email) {
      await User.updateOne(
        { _id: bySub._id },
        { $set: { googleEmail: email } }
      )
      bySub.googleEmail = email
    }
    return { user: bySub, created: false, linked: false }
  }

  // ---- 2. 同邮箱已存在（中国站老账号 / 其他渠道注册）：绑定 ----
  const byEmail = await User.findOne({
    $or: [{ email }, { carsiEmail: email }],
  })

  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== sub) {
      // 底线 2：拒绝抢占
      logger.warn(
        {
          userId: String(byEmail._id),
          existingSub: byEmail.googleSub,
          incomingSub: sub,
        },
        '[identity/google] 该账号已绑定其他 Google 身份，拒绝自动改绑'
      )
      throw Object.assign(new Error('google_account_conflict'), {
        code: 'google_account_conflict',
      })
    }

    await User.updateOne(
      { _id: byEmail._id },
      {
        $set: {
          googleSub: sub,
          googleEmail: email,
          googleLinkedAt: new Date(),
        },
      }
    )
    byEmail.googleSub = sub
    byEmail.googleEmail = email

    logger.info(
      { userId: String(byEmail._id), email },
      '[identity/google] 已把 Google 身份绑定到既有账号'
    )
    return { user: byEmail, created: false, linked: true }
  }

  // ---- 3. 全新用户 ----
  // 不给新账号设置本地密码：这类账号的密码不可猜，也不该存在。
  // 本地密码登录会失败（bcrypt.compare 对 undefined 返回 false），
  // 这正是期望行为 —— 想设密码走"忘记密码/设置密码"流程。
  const user = await UserCreator.promises.createNewUser(
    {
      email,
      first_name: firstNameFrom(identity.name, email),
      last_name: '',
      googleSub: sub,
      googleEmail: email,
      googleLinkedAt: new Date(),
      // NE 字段显式留空：避免下游逻辑把 Google 用户当成 NE 账号
      account_id: '',
    },
    {
      // Google 已经验证过邮箱，不需要再发确认邮件，否则用户会卡在
      // "请确认邮箱"页面而收不到邮件（海外站没接邮件服务商时尤其致命）。
      confirmedAt: new Date(),
    }
  )

  logger.info(
    { userId: String(user._id), email },
    '[identity/google] 已创建 Google 登录用户'
  )

  // 首次登录赠送额度**不在这里发**。
  // 发放点是 AuthenticationController.finishLogin —— 那是密码 / 短信 /
  // CARSI / Google 唯一的共同收尾，放在一处才能保证「每种登录方式都送、
  // 且只送一次」。这里只负责把用户建出来。

  return { user, created: true, linked: false }
}

function firstNameFrom(name, email) {
  const trimmed = String(name || '').trim()
  if (trimmed) return trimmed.split(/\s+/)[0].slice(0, 100)
  // UserCreator 在 first_name 为空时会用邮箱前缀，这里显式做一次，
  // 避免把整个邮箱当成名字显示出来。
  return String(email).split('@')[0].slice(0, 100)
}

module.exports = { resolveGoogleUser }
