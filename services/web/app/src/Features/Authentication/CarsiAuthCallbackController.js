/**
 * CARSI Authentication Callback Controller
 * 
 * FIXED: 2026-05-06 创建新的回调处理器，在同一个session中处理用户登录
 * 这样避免了跨session的CSRF验证问题
 */

const logger = require('@overleaf/logger')
const async = require('async')
const CarsiService = require('../../../../commercial/carsi')
const { User } = require('../../models/User')
const { Project } = require('../../models/Project')
const UserCreator = require('../User/UserCreator')
const NeAccountSync = require('./NeAccountSync')
// FIXED: 2026-11-20 复用 finishLogin 那套「读 session.postLoginRedirect」的实现，
// 不再自己拼 redirect。require 进来是安全的：AuthenticationController 不反向
// require 本文件（carsi-v2.js 才 require 本文件，且它只被 router.js 引入），无循环依赖。
const AuthenticationController = require('./AuthenticationController')

/**
 * FIXED: 2026-05-07 同时用account_id和email查询，通过project数量智能匹配用户
 *
 * 流程：
 * 1. 验证carsiAuthToken
 * 2. 从缓存中获取用户信息
 * 3. 同时用account_id和email查询，智能匹配最佳用户
 * 4. 直接建立session登录
 * 5. 重定向到项目页面
 */
function handleCarsiAuthCallback(req, res, next) {
    const carsiAuthToken = req.body.carsiAuthToken
    
    if (!carsiAuthToken) {
        logger.warn({ req }, 'carsiAuthCallback: missing carsiAuthToken')
        return res.redirect('/login')
    }
    
    // 从缓存中获取用户信息（会自动删除，使用一次后立即失效）
    const userInfo = CarsiService.getAndDeleteCarsiAuthInfo(carsiAuthToken)
    
    if (!userInfo) {
        // token过期（30秒超时）或不存在，重新引导用户从CARSI入口登录
        logger.warn({ req }, 'carsiAuthCallback: invalid or expired carsiAuthToken')
        return res.redirect('/login')
    }
    
    const { email, nick_name, inst_name, password, AUT, account_id, legacyFlylatexEmail, isVip, vipEndDate, type, type_txt } = userInfo

    logger.info({ email, AUT, account_id, legacyFlylatexEmail, isVip, type_txt, vipEndDate }, 'carsiAuthCallback: processing CARSI user')

    // FIXED: 2026-05-15 将userInfo保存到req中，供后续函数使用
    req.carsiUserInfo = userInfo

    // FIXED: 2026-05-07 同时用account_id和email查询，并兼容{account_id}@example.com旧模式
    _resolveCarsiUser(account_id, email, legacyFlylatexEmail, nick_name, inst_name, userInfo, (err, user) => {
        if (err) {
            logger.err({ err, account_id, email }, 'carsiAuthCallback: error resolving user')
            return next(err)
        }
        if (user) {
            logger.info({ userId: user._id, email: user.email, account_id: user.account_id }, 'carsiAuthCallback: user resolved')
            // FIXED: 2026-10-23 VIP 配额与机构已在 _updateUserFields 中按统一口径同步，
            // 这里不再单独分支升级/降级，避免两条路径写出不同的 features。
            _doLoginAndRedirect(user, req, res, next)
        } else {
            // 未找到任何匹配，创建新用户
            logger.info({ email, account_id }, 'carsiAuthCallback: no match, creating new user')
            _createNewUser(email, nick_name, inst_name, password, account_id, userInfo, req, res, next)
        }
    })
}

/**
 * FIXED: 2026-05-07 智能解析CARSI用户
 *
 * 同时用account_id和email查询，避免因email变化或account_id未关联导致重复建用户。
 * 如果查出两个不同的用户，通过project数量判断真实用户并更新其account_id/carsiEmail。
 * —— 不删除任何用户（防止projects关联丢失风险）。
 */
function _resolveCarsiUser(account_id, email, legacyFlylatexEmail, nick_name, inst_name, userInfo, callback) {
    if (!account_id && !email && !legacyFlylatexEmail) {
        return callback(null, null)
    }

    // 并行查询
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
            // 旧模式：用户之前通过{account_id}@example.com注册
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
            return callback(err)
        }

        const userByAccountId = results.userByAccountId
        const userByEmail = results.userByEmail

        // 情形1：两个查询指向同一个用户，或只有一个匹配
        if (userByAccountId && userByEmail &&
            userByAccountId._id.toString() === userByEmail._id.toString()) {
            logger.info({ userId: userByAccountId._id }, 'carsiAuthCallback: both queries match same user')
            return _updateUserFields(userByAccountId, account_id, email, inst_name, userInfo, callback)
        }
        if (userByAccountId && !userByEmail) {
            logger.info({ userId: userByAccountId._id }, 'carsiAuthCallback: only account_id matched')
            return _updateUserFields(userByAccountId, account_id, email, inst_name, userInfo, callback)
        }
        if (!userByAccountId && userByEmail) {
            logger.info({ userId: userByEmail._id }, 'carsiAuthCallback: only email matched')
            return _updateUserFields(userByEmail, account_id, email, inst_name, userInfo, callback)
        }

        // 情形2：两个不同的用户同时匹配
        if (userByAccountId && userByEmail) {
            logger.warn({
                userByAccountId: userByAccountId._id.toString(),
                userByEmail: userByEmail._id.toString(),
                account_id, email
            }, 'carsiAuthCallback: two different users matched, checking projects')

            return async.parallel({
                countA: function(cb) { Project.countDocuments({ owner_ref: userByAccountId._id }, cb) },
                countB: function(cb) { Project.countDocuments({ owner_ref: userByEmail._id }, cb) }
            }, function(err, counts) {
                if (err) {
                    return callback(err)
                }

                // 选择有projects的用户登录，优先account_id匹配的
                let selectedUser
                if (counts.countA > 0 && counts.countB > 0) {
                    // 都有projects → 选account_id匹配的（保守策略）
                    selectedUser = userByAccountId
                    logger.warn({
                        selected: selectedUser._id.toString(),
                        countA: counts.countA,
                        countB: counts.countB
                    }, 'carsiAuthCallback: both have projects, prefer account_id matched')
                } else if (counts.countA > 0) {
                    // 只有account_id匹配的有projects
                    selectedUser = userByAccountId
                    logger.info({ selected: selectedUser._id.toString(), projects: counts.countA },
                        'carsiAuthCallback: account_id matched user has projects')
                } else if (counts.countB > 0) {
                    // 只有email匹配的有projects
                    selectedUser = userByEmail
                    logger.info({ selected: selectedUser._id.toString(), projects: counts.countB },
                        'carsiAuthCallback: email matched user has projects')
                } else {
                    // 都没有projects → 选email匹配的（有carsiEmail关联）
                    selectedUser = userByEmail
                    logger.info({ selected: selectedUser._id.toString() },
                        'carsiAuthCallback: neither has projects, prefer email matched')
                }

                // 更新所选用户的account_id和carsiEmail（另一个用户保持不动）
                _updateUserFields(selectedUser, account_id, email, inst_name, userInfo, callback)
            })
        }

        // 情形3：两个都无匹配
        callback(null, null)
    })
}

/**
 * FIXED: 2026-05-07 更新用户信息（account_id、email、carsiEmail、institution、VIP等）
 *
 * 关键逻辑：
 * - institution：交给 NeAccountSync 统一处理（白名单 + 来源标记 + 不覆盖人工修正）
 * - VIP 配额：交给 NeAccountSync 统一处理（只改点路径，不整体替换 features）
 * - carsiEmail：总是更新为当前的登录标识（可能是手机号或email）
 * - email：仅当新值看起来是真实email（含@）且当前是@example.com占位符时才替换
 * - 避免手机号覆盖旧用户的合法email
 */
function _updateUserFields(user, account_id, email, inst_name, userInfo, callback) {
    NeAccountSync.buildSyncFields(
        user,
        Object.assign({}, userInfo || {}, { inst_name: inst_name }),
        function (syncErr, sync) {
            if (syncErr) {
                return callback(syncErr)
            }
            const updateFields = Object.assign({}, sync.fields)

            if (account_id) {
                updateFields.account_id = String(account_id)
            }
            if (email) {
                // carsiEmail始终更新为当前登录标识
                updateFields.carsiEmail = email
                // FIXED: 2026-05-07 仅当新email看起来是真实邮箱（含@）时才替换主email
                // 手机号不应作为主email字段，否则会丢失旧{account_id}@example.com模式
                const isValidEmail = email.indexOf('@') !== -1
                const isPlaceholderEmail = !user.email || user.email.indexOf('@example.com') !== -1
                if (isValidEmail && isPlaceholderEmail) {
                    updateFields.email = email
                }
            }

            NeAccountSync.applyFields(user, updateFields, function(err, updated) {
                if (err) {
                    return callback(err)
                }
                if (sync.vip.downgraded) {
                    logger.warn({ userId: user._id, email: user.email },
                        'carsiAuthCallback: VIP expired, features.compileTimeout downgraded')
                } else if (sync.vip.vipActive) {
                    logger.info({ userId: user._id, email: user.email, vipEndDate: sync.vip.state.vipEndDate },
                        'carsiAuthCallback: VIP quota ensured')
                }
                callback(null, updated)
            })
        }
    )
}

/**
 * FIXED: 2026-10-23 原有的 _updateVipFeatures / _downgradeVipFeatures 已移除。
 *
 * 原因：
 *   1. 它们用 `$set: { features: {...} }` 整体替换 features，会抹掉
 *      dropbox / github / gitVersion / versioning 等开关；
 *   2. 只在 CARSI 登录时生效，密码 / 短信登录不会同步 VIP 状态。
 * 现在统一由 NeAccountSync.buildVipFields() 生成点路径更新，三条登录链路共用。
 */

/**
 * FIXED: 2026-05-07 通过email查找或创建CARSI用户（有account_id时同步查找合并）
 *
 * 作为_resolveCarsiUser的备选路径：有email但无account_id时使用。
 * 当同时有email和account_id时，也会并行查找以防冲突。
 *
 * FIXED: 2026-10-23 机构 / VIP 统一走 NeAccountSync；此前这里调用
 * `_institutionUpdate()` 且缺少 VIP 参数，属于未被调用的历史分支。
 */
function _findOrCreateByEmail(email, nick_name, inst_name, password, account_id, req, res, next) {
    const userInfo = req.carsiUserInfo || {}
    if (!email) {
        logger.info({}, 'carsiAuthCallback: email is empty, creating new user directly')
        return _createNewUser(email, nick_name, inst_name, password, account_id, userInfo, req, res, next)
    }

    // FIXED: 2026-05-07 如果同时有account_id，走智能合并路径
    if (account_id) {
        logger.info({ account_id, email }, 'carsiAuthCallback: has both account_id and email, using resolve path')
        const legacyFlylatexEmail = String(account_id) + '@example.com'
        return _resolveCarsiUser(account_id, email, legacyFlylatexEmail, nick_name, inst_name, userInfo, (err, user) => {
            if (err) {
                logger.err({ err }, 'carsiAuthCallback: error in resolve path')
                return next(err)
            }
            if (user) {
                _doLoginAndRedirect(user, req, res, next)
            } else {
                _createNewUser(email, nick_name, inst_name, password, account_id, userInfo, req, res, next)
            }
        })
    }

    // 只有email（无account_id），按原逻辑查找
    User.findOne({
        $or: [
            { email: email },
            { carsiEmail: email }
        ]
    }, (err, user) => {
        if (err) {
            logger.err({ err, email }, 'carsiAuthCallback: error finding user by email')
            return next(err)
        }

        if (user) {
            logger.info({ email, account_id }, 'carsiAuthCallback: found existing user by email')
            NeAccountSync.buildSyncFields(user, userInfo, (syncErr, sync) => {
                if (syncErr) {
                    logger.err({ err: syncErr }, 'carsiAuthCallback: error building user fields')
                    return next(syncErr)
                }
                const updateFields = Object.assign({ carsiEmail: email }, sync.fields)
                NeAccountSync.applyFields(user, updateFields, (err, updated) => {
                    if (err) {
                        logger.err({ err }, 'carsiAuthCallback: error updating existing user by email')
                        return next(err)
                    }
                    _doLoginAndRedirect(updated, req, res, next)
                })
            })
        } else {
            logger.info({ email }, 'carsiAuthCallback: user not found by email, creating new user')
            _createNewUser(email, nick_name, inst_name, password, null, userInfo, req, res, next)
        }
    })
}

/**
 * 创建新CARSI用户
 *
 * FIXED: 2026-10-23 机构（白名单 + 来源标记）与 VIP 配额统一由
 * NeAccountSync.buildNewUserFields() 生成，避免新建用户与老用户口径不一致。
 * OLD: 手工判断 isVip 后设置 features，且机构直接写入 inst_name
 */
function _createNewUser(email, nick_name, inst_name, password, account_id, userInfo, req, res, next) {
    NeAccountSync.buildNewUserFields(
        Object.assign({}, userInfo || {}, { inst_name: inst_name }),
        function (syncErr, syncedFields) {
            if (syncErr) {
                logger.err({ err: syncErr, email }, 'carsiAuthCallback: error building new user fields')
                return next(syncErr)
            }

            const newUserData = Object.assign(
                {
                    holdingAccount: false,
                    email: email,
                    first_name: nick_name,
                    last_name: '',
                    password: password,
                    carsiEmail: email,
                },
                syncedFields
            )

            if (account_id) {
                newUserData.account_id = String(account_id)
            }

            logger.info(
                {
                    email,
                    institution: newUserData.institution,
                    isVip: Boolean(syncedFields.features),
                    vipEndDate: syncedFields.vipEndDate,
                },
                'carsiAuthCallback: creating new user'
            )

            UserCreator.createNewUser(newUserData, {}, (err, newUser) => {
                if (err) {
                    logger.err({ err, email }, 'carsiAuthCallback: error creating user')
                    return next(err)
                }

                // 更新用户状态
                User.updateOne(
                    { _id: newUser._id },
                    { $set: { holdingAccount: false } },
                    (err) => {
                        if (err) {
                            logger.err({ err }, 'carsiAuthCallback: error updating new user')
                            return next(err)
                        }
                        // 建立登录会话
                        _doLoginAndRedirect(newUser, req, res, next)
                    }
                )
            })
        }
    )
}

/**
 * 内部函数：建立登录会话并重定向
 */
function _doLoginAndRedirect(user, req, res, next) {
    // 使用passport的req.login()来建立会话
    // 这确保会话和用户信息都正确地关联
    req.login(user, (err) => {
        if (err) {
            logger.err({ err, userId: user._id }, 'carsiAuthCallback: error in req.login')
            return next(err)
        }

        _recordCarsiLogin(user, req)

        logger.info({ userId: user._id, email: user.email }, 'carsiAuthCallback: user logged in successfully')

        // FIXED: 2026-11-20 登录后回到用户**真正想去的页面**，而不是一律 /project。
        //
        // 为什么必须改（这是 SSO 的前置条件）：
        //   密码 / 短信 / Google 三条登录路径都走
        //   AuthenticationController.finishLogin()，那里会读
        //   session.postLoginRedirect 把用户送回原页面；只有 CARSI 这一条在回调里
        //   硬编码 res.redirect('/project')。而 CARSI 正是 CN 站的主登录方式。
        //
        //   后果：未登录访问 /sso/authorize?... → requireLogin() 记下
        //   postLoginRedirect → /login → 用户选 CARSI → 这里直接跳 /project，
        //   授权请求被丢弃，等待 code 的下游应用只能超时。
        //
        // 清理 redirect 是配套动作：这个值是一次性的，留着会被下一次登录复用
        // （/sso/authorize?state=... 里的 state 只能用一次，复用必然报错）。
        // 之前 _clearRedirectFromSession() 是死代码，没有任何地方调用。
        const redir =
            AuthenticationController._getRedirectFromSession(req) || '/project'
        AuthenticationController._clearRedirectFromSession(req)

        res.redirect(redir)
    })
}

/**
 * FIXED: 2026-10-23 CARSI 登录补记登录统计
 *
 * 背景：密码/短信登录会经 finishLogin -> _loginAsyncHandlers 累加 loginCount 并写入
 *      lastLoggedIn；CARSI 回调直接 req.login()，这两项从未写入。结果 carsi-mgr 的
 *      「总登录次数」「活跃用户」对以 CARSI 为主的学校恒为 0，出现「用户数 41、登录 3 次」
 *      这种自相矛盾的报表。
 *
 * 说明：这里不直接复用 AuthenticationController._recordSuccessfulLogin，避免把整个
 *      认证控制器（passport / redis / 限流）拉进 CARSI 回调的依赖链；口径保持一致：
 *      lastLoggedIn 按东八区时间写入，loginCount +1。
 */
function _recordCarsiLogin(user, req) {
    const chinaTime = new Date(Date.now() + 8 * 60 * 60 * 1000)
    User.updateOne(
        { _id: user._id },
        { $set: { lastLoggedIn: chinaTime }, $inc: { loginCount: 1 } },
        (err) => {
            if (err) {
                logger.err({ err, userId: user._id }, 'carsiAuthCallback: error recording login stats')
            }
        }
    )

    // 审计日志与密码/短信登录保持一致；写入失败不影响登录
    try {
        const ipAddress =
            (req.headers && req.headers['x-real-ip']) || req.ip
        require('../User/UserAuditLogHandler').addEntry(
            user._id,
            'login',
            user._id,
            ipAddress,
            { method: 'CARSI login' },
            (auditErr) => {
                if (auditErr) {
                    logger.warn({ err: auditErr, userId: user._id }, 'carsiAuthCallback: error writing login audit log')
                }
            }
        )
    } catch (auditErr) {
        logger.warn({ err: auditErr, userId: user._id }, 'carsiAuthCallback: audit log unavailable')
    }
}

module.exports = {
    handleCarsiAuthCallback
}
