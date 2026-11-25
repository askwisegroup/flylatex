const Settings = require('@overleaf/settings')
const { User } = require('../../models/User')
const { db, ObjectId } = require('../../infrastructure/mongodb')
const bcrypt = require('bcrypt')
const EmailHelper = require('../Helpers/EmailHelper')
const {
  InvalidEmailError,
  InvalidPasswordError,
  ParallelLoginError,
  PasswordMustBeDifferentError,
  PasswordReusedError,
} = require('./AuthenticationErrors')
const util = require('util')
const HaveIBeenPwned = require('./HaveIBeenPwned')
const UserAuditLogHandler = require('../User/UserAuditLogHandler')
const logger = require('@overleaf/logger')
const DiffHelper = require('../Helpers/DiffHelper')
const Metrics = require('@overleaf/metrics')
const UserCreator = require('../User/UserCreator')
const { Project } = require('../../models/Project')
const crypto = require('crypto')
const async = require('async')
const NEService = require('../../../../commercial')
const { getTempPasswordByEmail } = require('../../../../commercial/carsi')
const NeAccountSync = require('./NeAccountSync')
const BCRYPT_ROUNDS = Settings.security.bcryptRounds || 12
const BCRYPT_MINOR_VERSION = Settings.security.bcryptMinorVersion || 'a'
const MAX_SIMILARITY = 0.7
// FIXED: 2026-10-23 机构名单改读 Mongo 集合后，不再需要 fs / path
// OLD: const fs = require('fs')
// OLD: const path = require('path')

function _exceedsMaximumLengthRatio(password, maxSimilarity, value) {
  const passwordLength = password.length
  const lengthBoundSimilarity = (maxSimilarity / 2) * passwordLength
  const valueLength = value.length
  return (
    passwordLength >= 10 * valueLength && valueLength < lengthBoundSimilarity
  )
}

const _checkWriteResult = function (result, callback) {
  // for MongoDB
  if (result && result.modifiedCount === 1) {
    callback(null, true)
  } else {
    callback(null, false)
  }
}

function _validatePasswordNotTooLong(password) {
  // bcrypt has a hard limit of 72 characters.
  if (password.length > 72) {
    return new InvalidPasswordError({
      message: 'password is too long',
      info: { code: 'too_long' },
    })
  }
  return null
}

/**
 * 机构是否「已开通且未到期」。
 *
 * FIXED: 2026-10-23 改为读 Mongo 的 institutions 集合。
 * OLD: 读取仓库里的 institutions.json —— 该文件只是早期种子数据，
 *      线上真实名单由 carsi-mgr 维护在集合里，两者可能早已不一致。
 */
function getValidInstitution(institution, callback) {
  if (typeof callback !== 'function') {
    throw new Error('getValidInstitution requires a callback')
  }
  if (!institution) {
    return callback(null, false)
  }

  // 集合不可用（单测未注入等）时按「无法校验」处理，不阻断登录
  if (!db || !db.institutions || typeof db.institutions.findOne !== 'function') {
    console.warn('institutions 集合不可用，跳过机构有效性校验')
    return callback(null, true)
  }

  db.institutions.findOne(
    { eduName: institution },
    { projection: { valid: 1, endDate: 1 } },
    function (error, found) {
      if (error) {
        console.error('查询机构信息失败:', error)
        return callback(null, false)
      }
      if (!found) return callback(null, false)
      if (!found.valid) return callback(null, false)

      const endDate = new Date(found.endDate)
      if (Number.isNaN(endDate.getTime())) return callback(null, false)
      callback(null, Date.now() <= endDate.getTime())
    }
  )
}

function _metricsForSuccessfulPasswordMatch(password) {
  const validationResult = AuthenticationManager.validatePassword(password)
  const status =
    validationResult === null ? 'success' : validationResult?.info?.code
  Metrics.inc('check-password', { status })
  return null
}

// FIXED: 2026-05-07 同时用account_id和email查询，通过project数量智能匹配用户
function _findOrUpdateByEmailOrCreate(email, nick_name, result, institution, callback) {
  const account_id = result.account_id

  if (!email && !account_id) {
    console.log('No email or account_id, creating new user directly');
    return _createNewCarsiUser(email, nick_name, '', result, institution, callback);
  }

  // 并行查询：account_id / email（或carsiEmail）
  async.parallel({
    userByAccountId: function(cb) {
      if (account_id) {
        User.findOne({ account_id: String(account_id) }, cb)
      } else {
        cb(null, null)
      }
    },
    userByEmail: function(cb) {
      // FIXED: 2026-05-07 同时搜索当前email和旧的{account_id}@example.com模式
      const emailConditions = []
      if (email) {
        emailConditions.push({ email })
        emailConditions.push({ carsiEmail: email })
      }
      const legacyFlylatexEmail = account_id ? String(account_id) + '@example.com' : ''
      if (legacyFlylatexEmail) {
        emailConditions.push({ email: legacyFlylatexEmail })
        emailConditions.push({ carsiEmail: legacyFlylatexEmail })
      }
      if (emailConditions.length > 0) {
        User.findOne({ $or: emailConditions }, cb)
      } else {
        cb(null, null)
      }
    }
  }, (err, results) => {
    if (err) {
      console.error('Error querying users:', err);
      return callback(err);
    }

    const userByAccountId = results.userByAccountId
    const userByEmail = results.userByEmail

    // 情形1：两个查询指向同一个用户，或只有一个匹配
    if (userByAccountId && userByEmail &&
        userByAccountId._id.toString() === userByEmail._id.toString()) {
      console.log('Both queries match same user:', userByAccountId._id);
      return _updateAndMergeUser(userByAccountId, result, email, institution, callback)
    }
    if (userByAccountId && !userByEmail) {
      console.log('Only account_id matched:', userByAccountId._id);
      return _updateAndMergeUser(userByAccountId, result, email, institution, callback)
    }
    if (!userByAccountId && userByEmail) {
      console.log('Only email matched:', userByEmail._id);
      return _updateAndMergeUser(userByEmail, result, email, institution, callback)
    }

    // 情形2：两个不同的用户同时匹配
    if (userByAccountId && userByEmail) {
      console.log('Two different users found, checking projects:',
        'account_id user:', userByAccountId._id,
        'email user:', userByEmail._id);

      return async.parallel({
        countA: function(cb) { Project.countDocuments({ owner_ref: userByAccountId._id }, cb) },
        countB: function(cb) { Project.countDocuments({ owner_ref: userByEmail._id }, cb) }
      }, function(err, counts) {
        if (err) {
          console.error('Error counting projects:', err);
          return callback(err);
        }

        let selectedUser
        if (counts.countA > 0 && counts.countB > 0) {
          // 都有projects → 选account_id匹配的
          selectedUser = userByAccountId
          console.log('Both have projects, prefer account_id matched:', selectedUser._id);
        } else if (counts.countA > 0) {
          selectedUser = userByAccountId
          console.log('account_id matched user has projects:', selectedUser._id, 'count:', counts.countA);
        } else if (counts.countB > 0) {
          selectedUser = userByEmail
          console.log('email matched user has projects:', selectedUser._id, 'count:', counts.countB);
        } else {
          // 都没有projects → 选email匹配的
          selectedUser = userByEmail
          console.log('Neither has projects, prefer email matched:', selectedUser._id);
        }

        _updateAndMergeUser(selectedUser, result, email, institution, callback)
      })
    }

    // 情形3：两个都无匹配
    console.log('No matching user found, creating new');
    _createNewCarsiUser(email, nick_name, '', result, institution, callback)
  })
}

/**
 * FIXED: 2026-05-07 更新用户信息并合并account_id/carsiEmail/email
 *
 * 关键逻辑：
 * - carsiEmail：总是更新为当前登录标识（可能是手机号或email）
 * - email：仅当新值看起来是真实email（含@）且当前是@example.com占位符时才替换
 * - 避免手机号覆盖旧用户的合法email
 */
function _updateAndMergeUser(user, result, email, institution, callback) {
  // FIXED: 2026-10-23 机构与 VIP 配额统一由 NeAccountSync 生成：
  //   - 机构：与 Mongo institutions 集合比对 + 来源标记，不覆盖人工修正
  //   - VIP ：按账号级别（type/type_txt + vip_end）同步，只改点路径字段
  // OLD: if (institution && user.institution !== institution) { updateData.institution = institution }
  NeAccountSync.buildSyncFields(
    user,
    Object.assign({}, result || {}, { inst_name: institution || '' }),
    function (err, sync) {
      if (err) {
        return callback(err)
      }
      const updateData = Object.assign({}, sync.fields)

      if (email) {
        // carsiEmail始终更新为当前登录标识
        updateData.carsiEmail = email
        // FIXED: 2026-05-07 仅当新email看起来是真实邮箱（含@）时才替换主email
        const isValidEmail = email.indexOf('@') !== -1
        const isPlaceholderEmail =
          !user.email || user.email.indexOf('@example.com') !== -1
        if (isValidEmail && isPlaceholderEmail) {
          updateData.email = email
        }
      }
      if (result && result.account_id && !user.account_id) {
        updateData.account_id = String(result.account_id)
      }

      if (sync.vip.downgraded) {
        logger.warn(
          { userId: user._id, email: user.email },
          'ne-account-sync: VIP 已过期，编译超时已降级'
        )
      } else if (sync.vip.vipActive) {
        logger.info(
          { userId: user._id, email: user.email, vipEndDate: sync.vip.state.vipEndDate },
          'ne-account-sync: VIP 配额已同步'
        )
      }

      // FIXED: 2026-10-23 通过 NeAccountSync 写库，正确处理 features.* 点路径
      NeAccountSync.applyFields(user, updateData, callback)
    }
  )
}

// FIXED: 2026-05-06 抽取创建新CARSI用户的逻辑为独立函数
function _createNewCarsiUser(email, nick_name, password, result, institution, callback) {
  console.log('Creating new user for email:', email);
  let newPassword = crypto.randomBytes(32).toString('hex');

  // FIXED: 2026-10-23 新建用户同样走统一口径：机构比对 + 来源标记 + VIP 配额
  // OLD: institution: institution
  NeAccountSync.buildNewUserFields(
    Object.assign({}, result || {}, { inst_name: institution || '' }),
    (syncError, syncedFields) => {
      if (syncError) {
        console.error('Error building NE user fields:', syncError);
        return callback(syncError);
      }

      UserCreator.createNewUser(
        Object.assign(
          {
            holdingAccount: false,
            email: email,
            carsiEmail: email,
            first_name: nick_name,
            last_name: '',
            password: newPassword,
            account_id: String(result.account_id || ''),
          },
          syncedFields
        ),
        {},
        (error, user) => {
          console.log('UserCreator callback - error:', error, 'user:', user);
          if (error) {
            console.error('Error creating user:', error);
            return callback(error);
          }
          console.log('User created successfully, setting password');
          async.series(
            [
              callback =>
                User.updateOne(
                  { _id: user._id },
                  { $set: { holdingAccount: false } },
                  (e, u) => {
                    console.log('User updated, e:', e);
                    return callback(null, user);
                  }
                ),
              callback =>
                AuthenticationManager.setUserPassword(
                  user,
                  newPassword,
                  callback
                ),
            ],
            (error) => {
              console.log('async.series completed - error:', error);
              if (error) {
                return callback(error);
              }
              console.log('Returning user from NELogin:', user.email);
              return callback(null, user);
            }
          );
        }
      );
    }
  );
}

const AuthenticationManager = {
  _checkUserPassword(query, password, callback) {
    // Using Mongoose for legacy reasons here. The returned User instance
    // gets serialized into the session and there may be subtle differences
    // between the user returned by Mongoose vs mongodb (such as default values)
    User.findOne(query, (error, user) => {
      if (error) {
        return callback(error)
      }
      if (!user || !user.hashedPassword) {
        return callback(null, null, null)
      }
      let rounds = 0
      try {
        rounds = bcrypt.getRounds(user.hashedPassword)
      } catch (err) {
        let prefix, suffix, length
        if (typeof user.hashedPassword === 'string') {
          length = user.hashedPassword.length
          if (user.hashedPassword.length > 50) {
            // A full bcrypt hash is 60 characters long.
            prefix = user.hashedPassword.slice(0, '$2a$12$x'.length)
            suffix = user.hashedPassword.slice(-4)
          } else if (user.hashedPassword.length > 20) {
            prefix = user.hashedPassword.slice(0, 4)
            suffix = user.hashedPassword.slice(-4)
          } else {
            prefix = user.hashedPassword.slice(0, 4)
          }
        }
        logger.warn(
          {
            err,
            userId: user._id,
            hashedPassword: {
              type: typeof user.hashedPassword,
              length,
              prefix,
              suffix,
            },
          },
          'unexpected user.hashedPassword value'
        )
      }
      Metrics.inc('bcrypt', 1, {
        method: 'compare',
        path: rounds,
      })
      bcrypt.compare(password, user.hashedPassword, function (error, match) {
        if (error) {
          return callback(error)
        }
        if (match) {
          _metricsForSuccessfulPasswordMatch(password)
        }
        callback(null, user, match)
      })
    })
  },

  authenticate(query, password, auditLog, callback) {
    if (typeof callback === 'undefined') {
      callback = auditLog
      auditLog = null
    }

    let email = query.email;

    // email not in NEService.SpecialUsers
    if (!NEService.SpecialUsers.includes(email)) {
      let isCarsiUser = email.indexOf('@example.com') !== -1;
      if (isCarsiUser) {
        return User.findOne({
          $or: [
            { email: email },
            { carsiEmail: email }
          ]
        }, (error, user) => {
          if (!user) {
            return callback(null, false, {
              text: '用户不存在',
              type: 'error',
              status: 401,
              errorReason: 'user_not_found',
            });
          }
          let tempPassword = getTempPasswordByEmail(email)
          if (tempPassword && tempPassword === password) {
            return getValidInstitution(user.institution, function (err, valid) {
              if (!user.institution || !valid) {
                return callback(null, false, {
                  text: '您的学校尚未开通，无法登录',
                  type: 'error',
                  status: 401,
                  errorReason: 'institution_not_supported',
                });
              }
              return callback(null, user);
            });
          } else {
            return callback(null, false, {
              text: 'SSO密码错误',
              type: 'error',
              status: 401,
              errorReason: 'sso_password_error',
            });
          }
        });
      }

      // FIXED: 2026-10-11 认证 V2：透传人机验证结果。
      // OLD: NEService.NELogin(email, password, async (result) => {
      // 兼容改造后的签名 (email, password, captchaVerifyParam, cb)；
      // 未启用验证码时该值为 undefined，行为与原先完全一致。
      NEService.NELogin(email, password, query.captchaVerifyParam, async (result) => {
        if (result.code !== 0) {
          return callback(null, false, {
            text: result.msg || '登录失败',
            type: 'error',
            status: 401,
            errorReason: 'ne_login_failed',
            originalError: result.msg
          });
        }
        /**
         *  nick_name: nick_name,
            name: name,
            type_txt: type_txt,
            icon_url: icon_url,
         */
        var nick_name = result.nick_name;
        var name = result.name;
        var type_txt = result.type_txt;
        var account_id = result.account_id;
        // FIXED: 2026-05-06 使用CARSI API返回的inst_name作为机构，而非通过IP推断
        // 原因：1) IP推断不精确（用户可能使用VPN或处于多IP段环境）
        //       2) CARSI API直接返回准确的机构名称（如"北京师范大学"）
        //       3) 之前通过IP推断导致所有用户被误标记为"广东中医药大学"
        var institution = result.inst_name || '';
        var mobile = result.mobile || '';
        // ignore account type check in the during of alpha(test) version
        // if (type_txt !== 'VIP会员') {
        //   return callback('您不是VIP会员，无法登录');
        // }
        // FIXED: 2026-10-12 Use the existing legacy resolver for both login methods.
        // The account-id shortcut skipped the identity with the user's projects.
        _findOrUpdateByEmailOrCreate(email, nick_name, result, institution, callback);
      });
    } else {
      AuthenticationManager._checkUserPassword(
        query,
        password,
        (error, user, match) => {
          if (error) {
            return callback(error)
          }
          // var fs = require('fs')
          // fs.writeFileSync('/overleaf/xxx.log', JSON.stringify(user));
          if (!user) {
            return callback(null, null)
          }
          const update = { $inc: { loginEpoch: 1 } }
          if (!match) {
            update.$set = { lastFailedLogin: new Date() }
          }
          User.updateOne(
            { _id: user._id, loginEpoch: user.loginEpoch },
            update,
            {},
            (err, result) => {
              if (err) {
                return callback(err)
              }
              if (result.modifiedCount !== 1) {
                return callback(new ParallelLoginError())
              }
              if (!match) {
                if (!auditLog) {
                  return callback(null, null)
                } else {
                  return UserAuditLogHandler.addEntry(
                    user._id,
                    'failed-password-match',
                    user._id,
                    auditLog.ipAddress,
                    auditLog.info,
                    err => {
                      if (err) {
                        logger.error(
                          { userId: user._id, err, info: auditLog.info },
                          'Error while adding AuditLog entry for failed-password-match'
                        )
                      }
                      callback(null, null)
                    }
                  )
                }
              }
              AuthenticationManager.checkRounds(
                user,
                user.hashedPassword,
                password,
                function (err) {
                  if (err) {
                    return callback(err)
                  }
                  callback(null, user)
                  HaveIBeenPwned.checkPasswordForReuseInBackground(password)
                }
              )
            }
          )
        }
      )
    }
  },

  /**
   * FIXED: 2026-10-11 认证 V2：短信验证码登录。
   *
   * ⚠️ 用户匹配必须与密码登录**完全同源**，否则老用户会「登录即新建用户」而看不到原有文档：
   *   - 这里把用户输入的**手机号**作为 `email` 标识传给 _findOrUpdateByEmailOrCreate，
   *     与「用户在密码表单里输入手机号」时的语义完全一致；
   *   - 因此查询条件（account_id / email / carsiEmail / 遗留 {account_id}@example.com）
   *     与密码登录逐条相同，只是取回了用户信息的接口不同。
   */
  authenticateBySms(mobile, code, callback) {
    const identifier = String(mobile || '').trim()
    if (!identifier || !code) {
      return callback(null, false, {
        text: '请输入手机号和短信验证码',
        type: 'error',
        status: 401,
      })
    }

    NEService.SmsLogin(identifier, code, async (result) => {
      if (result.code !== 0) {
        return callback(null, false, {
          text: result.msg || '短信登录失败',
          type: 'error',
          status: 401,
          errorReason: 'ne_sms_login_failed',
          originalError: result.msg,
        })
      }

      const nick_name = result.nick_name
      const institution = result.inst_name || ''
      // 与密码登录共用同一套「查找或更新，实在没有才创建」的逻辑
      _findOrUpdateByEmailOrCreate(
        identifier,
        nick_name,
        result,
        institution,
        callback
      )
    })
  },

  validateEmail(email) {
    const parsed = EmailHelper.parseEmail(email)
    if (!parsed) {
      return new InvalidEmailError({ message: 'email not valid' })
    }
    return null
  },

  // validates a password based on a similar set of rules previously used by `passfield.js` on the frontend
  // note that `passfield.js` enforced more rules than this, but these are the most commonly set.
  // returns null on success, or an error object.
  validatePassword(password, email) {
    if (password == null) {
      return new InvalidPasswordError({
        message: 'password not set',
        info: { code: 'not_set' },
      })
    }

    Metrics.inc('try-validate-password')

    let allowAnyChars, min, max
    if (Settings.passwordStrengthOptions) {
      allowAnyChars = Settings.passwordStrengthOptions.allowAnyChars === true
      if (Settings.passwordStrengthOptions.length) {
        min = Settings.passwordStrengthOptions.length.min
        max = Settings.passwordStrengthOptions.length.max
      }
    }
    allowAnyChars = !!allowAnyChars
    min = min || 8
    max = max || 72

    // we don't support passwords > 72 characters in length, because bcrypt truncates them
    if (max > 72) {
      max = 72
    }

    if (password.length < min) {
      return new InvalidPasswordError({
        message: 'password is too short',
        info: { code: 'too_short' },
      })
    }
    if (password.length > max) {
      return new InvalidPasswordError({
        message: 'password is too long',
        info: { code: 'too_long' },
      })
    }
    const passwordLengthError = _validatePasswordNotTooLong(password)
    if (passwordLengthError) {
      return passwordLengthError
    }
    if (
      !allowAnyChars &&
      !AuthenticationManager._passwordCharactersAreValid(password)
    ) {
      return new InvalidPasswordError({
        message: 'password contains an invalid character',
        info: { code: 'invalid_character' },
      })
    }
    // if (typeof email === 'string' && email !== '') {
    if (typeof email === 'string' && email.includes('@')) {
      const startOfEmail = email.split('@')[0]
      if (
        password.includes(email) ||
        password.includes(startOfEmail) ||
        email.includes(password)
      ) {
        return new InvalidPasswordError({
          message: 'password contains part of email address',
          info: { code: 'contains_email' },
        })
      }
      try {
        const passwordTooSimilarError =
          AuthenticationManager._validatePasswordNotTooSimilar(password, email)
        if (passwordTooSimilarError) {
          Metrics.inc('password-too-similar-to-email')
          return new InvalidPasswordError({
            message: 'password is too similar to email address',
            info: { code: 'too_similar' },
          })
        }
      } catch (error) {
        logger.error(
          { error },
          'error while checking password similarity to email'
        )
      }
      // TODO: remove this check once the password-too-similar checks are active?
    }
    return null
  },

  setUserPassword(user, password, callback) {
    AuthenticationManager.setUserPasswordInV2(user, password, callback)
  },

  checkRounds(user, hashedPassword, password, callback) {
    // Temporarily disable this function, TODO: re-enable this
    if (Settings.security.disableBcryptRoundsUpgrades) {
      Metrics.inc('bcrypt_check_rounds', 1, { status: 'disabled' })
      return callback()
    }
    // check current number of rounds and rehash if necessary
    const currentRounds = bcrypt.getRounds(hashedPassword)
    if (currentRounds < BCRYPT_ROUNDS) {
      Metrics.inc('bcrypt_check_rounds', 1, { status: 'upgrade' })
      AuthenticationManager._setUserPasswordInMongo(user, password, callback)
    } else {
      Metrics.inc('bcrypt_check_rounds', 1, { status: 'success' })
      callback()
    }
  },

  hashPassword(password, callback) {
    // Double-check the size to avoid truncating in bcrypt.
    const error = _validatePasswordNotTooLong(password)
    if (error) {
      return callback(error)
    }
    bcrypt.genSalt(BCRYPT_ROUNDS, BCRYPT_MINOR_VERSION, function (error, salt) {
      if (error) {
        return callback(error)
      }
      Metrics.inc('bcrypt', 1, {
        method: 'hash',
        path: BCRYPT_ROUNDS,
      })
      bcrypt.hash(password, salt, callback)
    })
  },

  setUserPasswordInV2(user, password, callback) {
    if (!user || !user.email || !user._id) {
      return callback(new Error('invalid user object'))
    }
    const validationError = this.validatePassword(password, user.email)
    if (validationError) {
      return callback(validationError)
    }
    // check if we can log in with this password. In which case we should reject it,
    // because it is the same as the existing password.
    AuthenticationManager._checkUserPassword(
      { _id: user._id },
      password,
      (err, _user, match) => {
        if (err) {
          return callback(err)
        }
        if (match) {
          return callback(new PasswordMustBeDifferentError())
        }

        HaveIBeenPwned.checkPasswordForReuse(
          password,
          (error, isPasswordReused) => {
            if (error) {
              logger.err({ error }, 'cannot check password for re-use')
            }

            if (!error && isPasswordReused) {
              return callback(new PasswordReusedError())
            }

            // password is strong enough or the validation with the service did not happen
            this._setUserPasswordInMongo(user, password, callback)
          }
        )
      }
    )
  },

  _setUserPasswordInMongo(user, password, callback) {
    this.hashPassword(password, function (error, hash) {
      if (error) {
        return callback(error)
      }
      db.users.updateOne(
        { _id: ObjectId(user._id.toString()) },
        {
          $set: {
            hashedPassword: hash,
          },
          $unset: {
            password: true,
          },
        },
        function (updateError, result) {
          if (updateError) {
            return callback(updateError)
          }
          _checkWriteResult(result, callback)
        }
      )
    })
  },

  _passwordCharactersAreValid(password) {
    let digits, letters, lettersUp, symbols
    if (
      Settings.passwordStrengthOptions &&
      Settings.passwordStrengthOptions.chars
    ) {
      digits = Settings.passwordStrengthOptions.chars.digits
      letters = Settings.passwordStrengthOptions.chars.letters
      lettersUp = Settings.passwordStrengthOptions.chars.letters_up
      symbols = Settings.passwordStrengthOptions.chars.symbols
    }
    digits = digits || '1234567890'
    letters = letters || 'abcdefghijklmnopqrstuvwxyz'
    lettersUp = lettersUp || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    symbols = symbols || '@#$%^&*()-_=+[]{};:<>/?!£€.,'

    for (let charIndex = 0; charIndex <= password.length - 1; charIndex++) {
      if (
        digits.indexOf(password[charIndex]) === -1 &&
        letters.indexOf(password[charIndex]) === -1 &&
        lettersUp.indexOf(password[charIndex]) === -1 &&
        symbols.indexOf(password[charIndex]) === -1
      ) {
        return false
      }
    }
    return true
  },

  /**
   * Check if the password is similar to (parts of) the email address.
   * For now, this merely sends a metric when the password and
   * email address are deemed to be too similar to each other.
   * Later we will reject passwords that fail this check.
   *
   * This logic was borrowed from the django project:
   * https://github.com/django/django/blob/fa3afc5d86f1f040922cca2029d6a34301597a70/django/contrib/auth/password_validation.py#L159-L214
   */
  _validatePasswordNotTooSimilar(password, email) {
    password = password.toLowerCase()
    email = email.toLowerCase()
    const stringsToCheck = [email]
      .concat(email.split(/\W+/))
      .concat(email.split(/@/))
    for (const emailPart of stringsToCheck) {
      if (!_exceedsMaximumLengthRatio(password, MAX_SIMILARITY, emailPart)) {
        const similarity = DiffHelper.stringSimilarity(password, emailPart)
        if (similarity > MAX_SIMILARITY) {
          logger.warn(
            { email, emailPart, similarity, maxSimilarity: MAX_SIMILARITY },
            'Password too similar to email'
          )
          return new Error('password is too similar to email')
        }
      }
    }
  },

  getMessageForInvalidPasswordError(error, req) {
    const errorCode = error?.info?.code
    const message = {
      type: 'error',
    }
    switch (errorCode) {
      case 'not_set':
        message.key = 'password-not-set'
        message.text = req.i18n.translate('invalid_password_not_set')
        break
      case 'invalid_character':
        message.key = 'password-invalid-character'
        message.text = req.i18n.translate('invalid_password_invalid_character')
        break
      case 'contains_email':
        message.key = 'password-contains-email'
        message.text = req.i18n.translate('invalid_password_contains_email')
        break
      case 'too_similar':
        message.key = 'password-too-similar'
        message.text = req.i18n.translate('invalid_password_too_similar')
        break
      case 'too_short':
        message.key = 'password-too-short'
        message.text = req.i18n.translate('invalid_password_too_short', {
          minLength: Settings.passwordStrengthOptions?.length?.min || 8,
        })
        break
      case 'too_long':
        message.key = 'password-too-long'
        message.text = req.i18n.translate('invalid_password_too_long', {
          maxLength: Settings.passwordStrengthOptions?.length?.max || 72,
        })
        break
      default:
        logger.error({ err: error }, 'Unknown password validation error code')
        message.text = req.i18n.translate('invalid_password')
        break
    }
    return message
  },
}

AuthenticationManager.promises = {
  authenticate: util.promisify(AuthenticationManager.authenticate),
  hashPassword: util.promisify(AuthenticationManager.hashPassword),
  setUserPassword: util.promisify(AuthenticationManager.setUserPassword),
}

module.exports = AuthenticationManager
