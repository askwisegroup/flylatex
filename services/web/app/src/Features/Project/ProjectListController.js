const _ = require('lodash')
const Metrics = require('@overleaf/metrics')
const Settings = require('@overleaf/settings')
const ProjectHelper = require('./ProjectHelper')
const ProjectGetter = require('./ProjectGetter')
const PrivilegeLevels = require('../Authorization/PrivilegeLevels')
// FIXED: 2026-11-14 项目列表标出「自己分享出去的项目」需要判断公开级别
const PublicAccessLevels = require('../Authorization/PublicAccessLevels')
const mongodb = require('mongodb')
const SessionManager = require('../Authentication/SessionManager')
const Sources = require('../Authorization/Sources')
const UserGetter = require('../User/UserGetter')
const SurveyHandler = require('../Survey/SurveyHandler')
const TagsHandler = require('../Tags/TagsHandler')
const { expressify } = require('@overleaf/promise-utils')
const logger = require('@overleaf/logger')
const Features = require('../../infrastructure/Features')
const SubscriptionViewModelBuilder = require('../Subscription/SubscriptionViewModelBuilder')
const NotificationsHandler = require('../Notifications/NotificationsHandler')
const Modules = require('../../infrastructure/Modules')
const { OError, V1ConnectionError } = require('../Errors/Errors')
const { User } = require('../../models/User')
const UserPrimaryEmailCheckHandler = require('../User/UserPrimaryEmailCheckHandler')
const UserController = require('../User/UserController')
const LimitationsManager = require('../Subscription/LimitationsManager')
const NotificationsBuilder = require('../Notifications/NotificationsBuilder')
const GeoIpLookup = require('../../infrastructure/GeoIpLookup')
const SplitTestHandler = require('../SplitTests/SplitTestHandler')
const SubscriptionLocator = require('../Subscription/SubscriptionLocator')

/** @typedef {import("./types").GetProjectsRequest} GetProjectsRequest */
/** @typedef {import("./types").GetProjectsResponse} GetProjectsResponse */
/** @typedef {import("../../../../types/project/dashboard/api").ProjectApi} ProjectApi */
/** @typedef {import("../../../../types/project/dashboard/api").Filters} Filters */
/** @typedef {import("../../../../types/project/dashboard/api").Page} Page */
/** @typedef {import("../../../../types/project/dashboard/api").Sort} Sort */
/** @typedef {import("./types").AllUsersProjects} AllUsersProjects */
/** @typedef {import("./types").MongoProject} MongoProject */
/** @typedef {import("../Tags/types").Tag} Tag */

const _ssoAvailable = (affiliation, session, linkedInstitutionIds) => {
  if (!affiliation.institution) return false

  // institution.confirmed is for the domain being confirmed, not the email
  // Do not show SSO UI for unconfirmed domains
  if (!affiliation.institution.confirmed) return false

  // Could have multiple emails at the same institution, and if any are
  // linked to the institution then do not show notification for others
  if (
    linkedInstitutionIds.indexOf(affiliation.institution.id.toString()) === -1
  ) {
    if (affiliation.institution.ssoEnabled) return true
    if (affiliation.institution.ssoBeta && session.samlBeta) return true
    return false
  }
  return false
}

const _buildPortalTemplatesList = affiliations => {
  if (affiliations == null) {
    affiliations = []
  }

  const portalTemplates = []
  const uniqueAffiliations = _.uniqBy(affiliations, 'institution.id')
  for (const aff of uniqueAffiliations) {
    const hasSlug = aff.portal?.slug
    const hasTemplates = aff.portal?.templates_count > 0

    if (hasSlug && hasTemplates) {
      const portalPath = aff.institution.isUniversity ? '/edu/' : '/org/'
      const portalTemplateURL = Settings.siteUrl + portalPath + aff.portal?.slug

      portalTemplates.push({
        name: aff.institution.name,
        url: portalTemplateURL,
      })
    }
  }
  return portalTemplates
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
async function projectListPage(req, res, next) {
  // can have two values:
  // - undefined - when there's no "saas" feature or couldn't get subscription data
  // - object - the subscription data object
  let usersBestSubscription
  let survey
  let userIsMemberOfGroupSubscription = false
  let groupSubscriptionsPendingEnrollment = []

  const isSaas = Features.hasFeature('saas')

  const userId = SessionManager.getLoggedInUserId(req.session)
  const projectsBlobPending = _getProjects(userId).catch(err => {
    logger.err({ err, userId }, 'projects listing in background failed')
    return undefined
  })
  const user = await User.findById(
    userId,
    `email emails features alphaProgram betaProgram lastPrimaryEmailCheck signUpDate vipEndDate vipExpired${
      isSaas ? ' enrollment' : ''
    }`
  )

  // Handle case of deleted user
  if (user == null) {
    UserController.logout(req, res, next)
    return
  }

  if (isSaas) {
    await SplitTestHandler.promises.sessionMaintenance(req, user)

    try {
      usersBestSubscription =
        await SubscriptionViewModelBuilder.promises.getBestSubscription({
          _id: userId,
        })
    } catch (error) {
      logger.err(
        { err: error, userId },
        "Failed to get user's best subscription"
      )
    }
    try {
      const { isMember, subscriptions } =
        await LimitationsManager.promises.userIsMemberOfGroupSubscription(user)

      userIsMemberOfGroupSubscription = isMember

      // TODO use helper function
      if (!user.enrollment?.managedBy) {
        groupSubscriptionsPendingEnrollment = subscriptions.filter(
          subscription => subscription.groupPlan && subscription.groupPolicy
        )
      }
    } catch (error) {
      logger.error(
        { err: error },
        'Failed to check whether user is a member of group subscription'
      )
    }

    try {
      survey = await SurveyHandler.promises.getSurvey(userId)
    } catch (error) {
      logger.err({ err: error, userId }, 'Failed to load the active survey')
    }

    if (user && UserPrimaryEmailCheckHandler.requiresPrimaryEmailCheck(user)) {
      return res.redirect('/user/emails/primary-email-check')
    }
  }

  const tags = await TagsHandler.promises.getAllTags(userId)

  let userEmailsData = { list: [], allInReconfirmNotificationPeriods: [] }

  try {
    const fullEmails = await UserGetter.promises.getUserFullEmails(userId)

    if (!Features.hasFeature('affiliations')) {
      userEmailsData.list = fullEmails
    } else {
      try {
        const results = await Modules.promises.hooks.fire(
          'allInReconfirmNotificationPeriodsForUser',
          fullEmails
        )

        const allInReconfirmNotificationPeriods = (results && results[0]) || []

        userEmailsData = {
          list: fullEmails,
          allInReconfirmNotificationPeriods,
        }
      } catch (error) {
        userEmailsData = error
      }
    }
  } catch (error) {
    if (!(error instanceof V1ConnectionError)) {
      logger.error({ err: error, userId }, 'Failed to get user full emails')
    }
  }

  const userEmails = userEmailsData.list || []

  const userAffiliations = userEmails
    .filter(emailData => !!emailData.affiliation)
    .map(emailData => {
      const result = emailData.affiliation
      result.email = emailData.email
      return result
    })

  const portalTemplates = _buildPortalTemplatesList(userAffiliations)

  const { allInReconfirmNotificationPeriods } = userEmailsData

  const notifications =
    await NotificationsHandler.promises.getUserNotifications(userId)

  for (const notification of notifications) {
    notification.html = req.i18n.translate(
      notification.templateKey,
      notification.messageOpts
    )
  }

  const notificationsInstitution = []
  // Institution SSO Notifications
  let reconfirmedViaSAML
  if (Features.hasFeature('saml')) {
    reconfirmedViaSAML = _.get(req.session, ['saml', 'reconfirmed'])
    const samlSession = req.session.saml
    // Notification: SSO Available
    const linkedInstitutionIds = []
    userEmails.forEach(email => {
      if (email.samlProviderId) {
        linkedInstitutionIds.push(email.samlProviderId)
      }
    })
    if (Array.isArray(userAffiliations)) {
      userAffiliations.forEach(affiliation => {
        if (_ssoAvailable(affiliation, req.session, linkedInstitutionIds)) {
          notificationsInstitution.push({
            email: affiliation.email,
            institutionId: affiliation.institution.id,
            institutionName: affiliation.institution.name,
            templateKey: 'notification_institution_sso_available',
          })
        }
      })
    }

    if (samlSession) {
      // Notification: After SSO Linked
      if (samlSession.linked) {
        notificationsInstitution.push({
          email: samlSession.institutionEmail,
          institutionName:
            samlSession.linked.universityName ||
            samlSession.linked.providerName,
          templateKey: 'notification_institution_sso_linked',
        })
      }

      // Notification: After SSO Linked or Logging in
      // The requested email does not match primary email returned from
      // the institution
      if (
        samlSession.requestedEmail &&
        samlSession.emailNonCanonical &&
        !samlSession.error
      ) {
        notificationsInstitution.push({
          institutionEmail: samlSession.emailNonCanonical,
          requestedEmail: samlSession.requestedEmail,
          templateKey: 'notification_institution_sso_non_canonical',
        })
      }

      // Notification: Tried to register, but account already existed
      // registerIntercept is set before the institution callback.
      // institutionEmail is set after institution callback.
      // Check for both in case SSO flow was abandoned
      if (
        samlSession.registerIntercept &&
        samlSession.institutionEmail &&
        !samlSession.error
      ) {
        notificationsInstitution.push({
          email: samlSession.institutionEmail,
          templateKey: 'notification_institution_sso_already_registered',
        })
      }

      // Notification: When there is a session error
      if (samlSession.error) {
        notificationsInstitution.push({
          templateKey: 'notification_institution_sso_error',
          error: samlSession.error,
        })
      }
    }
    delete req.session.saml
  }

  // 预取项目列表时有时间上限：拿不到就不等它，交给前端再请求一次
  // （前端那次 POST /api/project 有 30 次/分钟的限流，失败后整页会掉进
  //  「抱歉，出错了」+ 欢迎面板那个分支）。
  //
  // FIXED: 2026-11-05 上限从 0ms 提到 150ms。
  //   setTimeout(0) 意味着只有「Mongo 在同一个事件循环轮次内就答完」才算预取成功，
  //   机器一忙（本项目见过 filestore/docstore 反复 slow event loop）就必然
  //   too-slow，于是每次打开项目列表都多打一枪限流接口，偶发失败的窗口被放大。
  //   150ms 的代价有界（Mongo 快时 Promise.race 立刻返回，不会多等），
  //   收益是绝大多数加载都能走预取、前端根本不发那次请求。
  // OLD: setTimeout(() => resolve(undefined), 0)
  const PREFETCH_WAIT_MS = 150
  function fakeDelay() {
    return new Promise(resolve => {
      setTimeout(() => resolve(undefined), PREFETCH_WAIT_MS)
    })
  }

  const prefetchedProjectsBlob = await Promise.race([
    projectsBlobPending,
    fakeDelay(),
  ])
  Metrics.inc('project-list-prefetch-projects', 1, {
    status: prefetchedProjectsBlob ? 'success' : 'too-slow',
  })

  // in v2 add notifications for matching university IPs
  if (Settings.overleaf != null && req.ip !== user.lastLoginIp) {
    try {
      await NotificationsBuilder.promises
        .ipMatcherAffiliation(user._id)
        .create(req.ip)
    } catch (err) {
      logger.error(
        { err },
        'failed to create institutional IP match notification'
      )
    }
  }

  let welcomePageRedesignAssignment = { variant: 'default' }

  try {
    welcomePageRedesignAssignment =
      await SplitTestHandler.promises.getAssignment(
        req,
        res,
        'welcome-page-redesign'
      )
  } catch (error) {
    logger.error(
      { err: error },
      'failed to get "welcome-page-redesign" split test assignment'
    )
  }

  const hasPaidAffiliation = userAffiliations.some(
    affiliation => affiliation.licence && affiliation.licence !== 'free'
  )

  const showGroupsAndEnterpriseBanner =
    Features.hasFeature('saas') &&
    !userIsMemberOfGroupSubscription &&
    !hasPaidAffiliation

  const groupsAndEnterpriseBannerVariant =
    showGroupsAndEnterpriseBanner &&
    _.sample(['did-you-know', 'on-premise', 'people', 'FOMO'])

  let showWritefullPromoBanner = false
  if (Features.hasFeature('saas') && !req.session.justRegistered) {
    try {
      const { variant } = await SplitTestHandler.promises.getAssignment(
        req,
        res,
        'writefull-promo-banner'
      )
      showWritefullPromoBanner = variant === 'enabled'
    } catch (error) {
      logger.warn(
        { err: error },
        'failed to get "writefull-promo-banner" split test assignment'
      )
    }
  }

  let showInrGeoBanner, inrGeoBannerSplitTestName
  let inrGeoBannerVariant = 'default'
  let showLATAMBanner = false
  let recommendedCurrency
  if (usersBestSubscription?.type === 'free') {
    const { currencyCode, countryCode } =
      await GeoIpLookup.promises.getCurrencyCode(req.ip)
    let inrGeoPricingVariant = 'default'
    try {
      // Split test is kept active, but all users geolocated in India can
      // now use the INR currency (See #13507)
      const inrGeoPricingAssignment =
        await SplitTestHandler.promises.getAssignment(
          req,
          res,
          'geo-pricing-inr'
        )
      inrGeoPricingVariant = inrGeoPricingAssignment.variant
    } catch (error) {
      logger.error(
        { err: error },
        'Failed to get geo-pricing-inr split test assignment'
      )
    }
    try {
      const latamGeoPricingAssignment =
        await SplitTestHandler.promises.getAssignment(
          req,
          res,
          'geo-pricing-latam'
        )
      showLATAMBanner =
        latamGeoPricingAssignment.variant === 'latam' &&
        ['BR', 'MX', 'CO', 'CL', 'PE'].includes(countryCode)
      // LATAM Banner needs to know which currency to display
      if (showLATAMBanner) {
        recommendedCurrency = currencyCode
      }
    } catch (error) {
      logger.error(
        { err: error },
        'Failed to get geo-pricing-latam split test assignment'
      )
    }
    if (countryCode === 'IN') {
      inrGeoBannerSplitTestName =
        inrGeoPricingVariant === 'inr'
          ? 'geo-banners-inr-2'
          : 'geo-banners-inr-1'
      try {
        const geoBannerAssignment =
          await SplitTestHandler.promises.getAssignment(
            req,
            res,
            inrGeoBannerSplitTestName
          )
        showInrGeoBanner = true
        inrGeoBannerVariant = geoBannerAssignment.variant
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to get INR geo banner lookup or assignment (${inrGeoBannerSplitTestName})`
        )
      }
    }
  }

  let hasIndividualRecurlySubscription = false

  try {
    const individualSubscription =
      await SubscriptionLocator.promises.getUsersSubscription(userId)

    hasIndividualRecurlySubscription =
      individualSubscription?.groupPlan === false &&
      individualSubscription?.recurlyStatus?.state !== 'canceled' &&
      individualSubscription?.recurlySubscription_id !== ''
  } catch (error) {
    logger.error({ err: error }, 'Failed to get individual subscription')
  }

  res.render('project/list-react', {
    title: 'your_projects',
    usersBestSubscription,
    notifications,
    notificationsInstitution,
    user,
    userAffiliations,
    userEmails,
    reconfirmedViaSAML,
    allInReconfirmNotificationPeriods,
    survey,
    tags,
    portalTemplates,
    prefetchedProjectsBlob,
    showGroupsAndEnterpriseBanner,
    groupsAndEnterpriseBannerVariant,
    showWritefullPromoBanner,
    showLATAMBanner,
    recommendedCurrency,
    showInrGeoBanner,
    inrGeoBannerVariant,
    inrGeoBannerSplitTestName,
    projectDashboardReact: true, // used in navbar
    welcomePageRedesignVariant: welcomePageRedesignAssignment.variant,
    groupSubscriptionsPendingEnrollment:
      groupSubscriptionsPendingEnrollment.map(subscription => ({
        groupId: subscription._id,
        groupName: subscription.teamName,
      })),
    hasIndividualRecurlySubscription,
  })
}

/**
 * Load user's projects with pagination, sorting and filters
 *
 * @param {GetProjectsRequest} req the request
 * @param {GetProjectsResponse} res the response
 * @returns {Promise<void>}
 */
async function getProjectsJson(req, res) {
  const { filters, page, sort } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  const projectsPage = await _getProjects(userId, filters, sort, page)
  res.json(projectsPage)
}

/**
 * @param {string} userId
 * @param {Filters} filters
 * @param {Sort} sort
 * @param {Page} page
 * @returns {Promise<{totalSize: number, projects: ProjectApi[]}>}
 * @private
 */
async function _getProjects(
  userId,
  filters = {},
  sort = { by: 'lastUpdated', order: 'desc' },
  page = { size: 20 }
) {
  const [
    /** @type {AllUsersProjects} **/ allProjects,
    /** @type {Tag[]} **/ tags,
  ] = await Promise.all([
    ProjectGetter.promises.findAllUsersProjects(
      userId,
      'name lastUpdated lastUpdatedBy publicAccesLevel archived trashed owner_ref tokens'
    ),
    TagsHandler.promises.getAllTags(userId),
  ])
  const formattedProjects = _formatProjects(allProjects, userId)
  const filteredProjects = _applyFilters(
    formattedProjects,
    tags,
    filters,
    userId
  )
  const pagedProjects = _sortAndPaginate(filteredProjects, sort, page)

  await _injectProjectUsers(pagedProjects)
  // FIXED: 2026-11 项目列表里标出「这个项目关联了 Git 仓库」，
  // 让用户一眼看出哪些项目可以从编辑器里拉取 / 推送。
  await _injectGitFlags(pagedProjects)
  await _injectSharedInfo(pagedProjects)

  return {
    totalSize: filteredProjects.length,
    projects: pagedProjects,
  }
}

/**
 * @param {AllUsersProjects} projects
 * @param {string} userId
 * @returns {Project[]}
 * @private
 */
function _formatProjects(projects, userId) {
  const { owned, readAndWrite, readOnly, tokenReadAndWrite, tokenReadOnly } =
    projects

  const formattedProjects = /** @type {Project[]} **/ []
  for (const project of owned) {
    formattedProjects.push(
      _formatProjectInfo(project, 'owner', Sources.OWNER, userId)
    )
  }
  // Invite-access
  for (const project of readAndWrite) {
    formattedProjects.push(
      _formatProjectInfo(project, 'readWrite', Sources.INVITE, userId)
    )
  }
  for (const project of readOnly) {
    formattedProjects.push(
      _formatProjectInfo(project, 'readOnly', Sources.INVITE, userId)
    )
  }
  // Token-access
  // Only add these formattedProjects if they're not already present, this gives us cascading access
  // from 'owner' => 'token-read-only'
  for (const project of tokenReadAndWrite) {
    if (!formattedProjects.some(p => p.id === project._id.toString())) {
      formattedProjects.push(
        _formatProjectInfo(project, 'readAndWrite', Sources.TOKEN, userId)
      )
    }
  }
  for (const project of tokenReadOnly) {
    if (!formattedProjects.some(p => p.id === project._id.toString())) {
      formattedProjects.push(
        _formatProjectInfo(project, 'readOnly', Sources.TOKEN, userId)
      )
    }
  }

  return formattedProjects
}

/**
 * @param {Project[]} projects
 * @param {Tag[]} tags
 * @param {Filters} filters
 * @param {string} userId
 * @returns {Project[]}
 * @private
 */
function _applyFilters(projects, tags, filters, userId) {
  if (!_hasActiveFilter(filters)) {
    return projects
  }
  return projects.filter(project => _matchesFilters(project, tags, filters))
}

/**
 * @param {Project[]} projects
 * @param {Sort} sort
 * @param {Page} page
 * @returns {Project[]}
 * @private
 */
function _sortAndPaginate(projects, sort, page) {
  if (
    (sort.by && !['lastUpdated', 'title', 'owner'].includes(sort.by)) ||
    (sort.order && !['asc', 'desc'].includes(sort.order))
  ) {
    throw new OError('Invalid sorting criteria', { sort })
  }
  const sortedProjects = _.orderBy(
    projects,
    [sort.by || 'lastUpdated'],
    [sort.order || 'desc']
  )
  // TODO handle pagination
  return sortedProjects
}

/**
 * @param {MongoProject} project
 * @param {string} accessLevel
 * @param {'owner' | 'invite' | 'token'} source
 * @param {string} userId
 * @returns {object}
 * @private
 */
function _formatProjectInfo(project, accessLevel, source, userId) {
  const archived = ProjectHelper.isArchived(project, userId)
  // If a project is simultaneously trashed and archived, we will consider it archived but not trashed.
  const trashed = ProjectHelper.isTrashed(project, userId) && !archived

  const model = {
    id: project._id.toString(),
    name: project.name,
    owner_ref: project.owner_ref,
    lastUpdated: project.lastUpdated,
    lastUpdatedBy: project.lastUpdatedBy,
    accessLevel,
    source,
    archived,
    trashed,
    // FIXED: 2026-11-14 项目列表要能分出「我自己分享出去的项目」。
    // 只给 owned 的项目带这个字段：别人的项目分享没分享出去，
    // 不该在别人的列表里被看到。
    ...(accessLevel === PrivilegeLevels.OWNER
      ? { publicAccessLevel: project.publicAccesLevel }
      : {}),
  }
  if (accessLevel === PrivilegeLevels.READ_ONLY && source === Sources.TOKEN) {
    model.owner_ref = null
    model.lastUpdatedBy = null
  }
  return model
}

/**
 * @param {Project[]} projects
 * @returns {Promise<void>}
 * @private
 */
/**
 * 给项目打上「已关联 Git 仓库」的标记
 *
 * 用一次 $in 查询，而不是每个项目查一次（列表默认 20 条，
 * 逐条查就是 20 次往返）。GitConfig 不在时静默降级：
 * 列表页不该因为 Git 功能被裁掉而报错。
 *
 * @param {Project[]} projects
 */
async function _injectGitFlags(projects) {
  for (const project of projects) {
    project.gitLinked = false
  }
  if (!projects.length) return

  try {
    const { GitConfig } = require('../Git/GitConfig')
    const linked = await GitConfig.find({
      projectId: { $in: projects.map(project => project.id) },
    })
      .select('projectId')
      .lean()
    const linkedIds = new Set(linked.map(row => row.projectId.toString()))
    for (const project of projects) {
      project.gitLinked = linkedIds.has(project.id)
    }
  } catch (err) {
    logger.warn({ err }, 'failed to load git flags for project list')
  }
}

/**
 * 给「自己分享出去的」项目补一个分享时间。
 *
 * 时间取审计日志里最近一次「打开分享」的 toggle-access-level 记录 ——
 * 这个操作本来就一直在写（ProjectController.updateProjectAdminSettings），
 * 不需要给 Project 加时间字段，历史数据也有。
 *
 * 只有 owned 且 publicAccesLevel != private 的项目才会被查，正常情况下
 * 一个用户分享出去的项目只有个位数，一次 aggregate 就够。
 *
 * @param {Project[]} projects
 */
async function _injectSharedInfo(projects) {
  const shared = projects.filter(
    project =>
      project.accessLevel === PrivilegeLevels.OWNER &&
      project.publicAccessLevel != null &&
      project.publicAccessLevel !== PublicAccessLevels.PRIVATE
  )
  if (shared.length === 0) return

  try {
    const { ProjectAuditLogEntry } = require('../../models/ProjectAuditLogEntry')
    const rows = await ProjectAuditLogEntry.aggregate([
      {
        $match: {
          projectId: {
            $in: shared.map(project => new mongodb.ObjectId(project.id)),
          },
          operation: 'toggle-access-level',
          'info.publicAccessLevel': { $ne: 'private' },
        },
      },
      { $group: { _id: '$projectId', timestamp: { $max: '$timestamp' } } },
    ]).exec()
    const byId = {}
    for (const row of rows) {
      byId[row._id.toString()] = row.timestamp
    }
    for (const project of shared) {
      const timestamp = byId[project.id]
      project.sharedAt = timestamp
        ? new Date(timestamp).toISOString().slice(0, 10)
        : null
    }
  } catch (err) {
    // 时间拿不到不影响列表，只是这一列显示为空
    logger.warn({ err }, 'failed to load share timestamps for project list')
  }
}

async function _injectProjectUsers(projects) {
  const userIds = new Set()
  for (const project of projects) {
    if (project.owner_ref != null) {
      userIds.add(project.owner_ref.toString())
    }
    if (project.lastUpdatedBy != null) {
      userIds.add(project.lastUpdatedBy.toString())
    }
  }

  const projection = {
    first_name: 1,
    last_name: 1,
    email: 1,
  }
  const users = {}
  for (const user of await UserGetter.promises.getUsers(userIds, projection)) {
    const userId = user._id.toString()
    users[userId] = {
      id: userId,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
    }
  }
  for (const project of projects) {
    if (project.owner_ref != null) {
      project.owner = users[project.owner_ref.toString()]
    }
    if (project.lastUpdatedBy != null) {
      project.lastUpdatedBy = users[project.lastUpdatedBy.toString()] || null
    }

    delete project.owner_ref
  }
}

/**
 * @param {any} project
 * @param {Tag[]} tags
 * @param {Filters} filters
 * @private
 */
function _matchesFilters(project, tags, filters) {
  if (filters.ownedByUser && project.accessLevel !== 'owner') {
    return false
  }
  if (filters.sharedWithUser && project.accessLevel === 'owner') {
    return false
  }
  if (filters.archived && !project.archived) {
    return false
  }
  if (filters.trashed && !project.trashed) {
    return false
  }
  if (
    filters.tag &&
    !_.find(
      tags,
      tag =>
        filters.tag === tag.name && (tag.project_ids || []).includes(project.id)
    )
  ) {
    return false
  }
  if (
    filters.search?.length &&
    project.name.toLowerCase().indexOf(filters.search.toLowerCase()) === -1
  ) {
    return false
  }
  return true
}

/**
 * @param {Filters} filters
 * @returns {boolean}
 * @private
 */
function _hasActiveFilter(filters) {
  return (
    filters.ownedByUser ||
    filters.sharedWithUser ||
    filters.archived ||
    filters.trashed ||
    filters.tag === null ||
    filters.tag?.length ||
    filters.search?.length
  )
}

module.exports = {
  projectListPage: expressify(projectListPage),
  getProjectsJson: expressify(getProjectsJson),
}
