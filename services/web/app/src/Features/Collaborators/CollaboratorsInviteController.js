const { callbackify } = require('util')
const ProjectGetter = require('../Project/ProjectGetter')
const LimitationsManager = require('../Subscription/LimitationsManager')
const UserGetter = require('../User/UserGetter')
const CollaboratorsGetter = require('./CollaboratorsGetter')
const CollaboratorsInviteHandler = require('./CollaboratorsInviteHandler')
const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')
const EmailHelper = require('../Helpers/EmailHelper')
const EditorRealTimeController = require('../Editor/EditorRealTimeController')
const AnalyticsManager = require('../Analytics/AnalyticsManager')
const SessionManager = require('../Authentication/SessionManager')
const { RateLimiter } = require('../../infrastructure/RateLimiter')
const { expressify } = require('@overleaf/promise-utils')
const ProjectAuditLogHandler = require('../Project/ProjectAuditLogHandler')
const Errors = require('../Errors/Errors')
// FIXED: 2026-11 邀请权限白名单需要 PrivilegeLevels（新增 review 档）
const PrivilegeLevels = require('../Authorization/PrivilegeLevels')

// This rate limiter allows a different number of requests depending on the
// number of callaborators a user is allowed. This is implemented by providing
// a number of points (P) and consuming c = floor(P / maxRequests) on each
// request. We'd like (maxRequests + 1) requests to trigger the rate limit, so
// one constrait that we have is that c * (maxRequests + 1) > P. This is
// achieved if P = M^2 where M is the largest value possible for maxRequests.
//
// In the present case, we allow 10 requests per collaborator per 30 minutes,
// with a maximum of 200 requests, so P = 200^2 = 40000.
const RATE_LIMIT_POINTS = 40000
const rateLimiter = new RateLimiter('invite-to-project-by-user-id', {
  points: RATE_LIMIT_POINTS,
  duration: 60 * 30,
})

// Helper: Check if input is a phone number (11 digits)
function isPhoneNumber(input) {
  return /^\d{11}$/.test(input)
}

// Helper: Get user email by phone number from local database
async function getEmailByPhoneNumber(phone) {
  try {
    // Search in local database for user by phone/mobile field or other identifiers
    // Users logged in via phone may have it stored in various fields
    const user = await UserGetter.promises.getUserByAnyEmail(phone, {
      email: 1,
    })
    
    if (user && user.email) {
      return user.email
    }
    
    // If not found by direct email search, search by other phone-related fields
    // This would require a direct database query since UserGetter may not expose it
    return null
  } catch (err) {
    logger.error({ err, phone }, 'error getting user by phone number')
    return null
  }
}

const CollaboratorsInviteController = {
  async getAllInvites(req, res) {
    const projectId = req.params.Project_id
    logger.debug({ projectId }, 'getting all active invites for project')
    const invites = await CollaboratorsInviteHandler.promises.getAllInvites(
      projectId
    )
    res.json({ invites })
  },

  async _checkShouldInviteEmail(email) {
    if (Settings.restrictInvitesToExistingAccounts === true) {
      logger.debug({ email }, 'checking if user exists with this email')
      const user = await UserGetter.promises.getUserByAnyEmail(email, {
        _id: 1,
      })
      const userExists = user?._id != null
      return userExists
    } else {
      return true
    }
  },

  async _checkRateLimit(userId) {
    let collabLimit =
      await LimitationsManager.promises.allowedNumberOfCollaboratorsForUser(
        userId
      )

    if (collabLimit == null || collabLimit === 0) {
      collabLimit = 1
    } else if (collabLimit < 0 || collabLimit > 20) {
      collabLimit = 20
    }

    // Consume enough points to hit the rate limit at 10 * collabLimit
    const maxRequests = 10 * collabLimit
    const points = Math.floor(RATE_LIMIT_POINTS / maxRequests)
    try {
      await rateLimiter.consume(userId, points)
    } catch (err) {
      if (err instanceof Error) {
        throw err
      } else {
        return false
      }
    }
    return true
  },

  async inviteToProject(req, res) {
    const projectId = req.params.Project_id
    let { email, privileges } = req.body
    const sendingUser = SessionManager.getSessionUser(req.session)
    const sendingUserId = sendingUser._id
    req.logger.addFields({ email, sendingUserId })

    // FIXED: 2026-11 校验邀请权限（此前不校验）：
    //   任意字符串会被原样存进 invite，接受邀请时才在
    //   CollaboratorsHandler.addUserIdToProject 抛 unknown privilegeLevel，
    //   邀请人只看到一个 500。未知值一律降级为 readOnly（安全降级，
    //   绝不降级成可写），并记日志方便排查前端传错值。
    const allowedPrivileges = [
      PrivilegeLevels.READ_ONLY,
      PrivilegeLevels.REVIEW,
      PrivilegeLevels.READ_AND_WRITE,
    ]
    if (!allowedPrivileges.includes(privileges)) {
      logger.warn(
        { projectId, privileges, sendingUserId },
        'invalid invite privileges, falling back to readOnly'
      )
      privileges = PrivilegeLevels.READ_ONLY
    }

    if (email === sendingUser.email) {
      logger.debug(
        { projectId, email, sendingUserId },
        'cannot invite yourself to project'
      )
      return res.json({ invite: null, error: 'cannot_invite_self' })
    }

    logger.debug({ projectId, email, sendingUserId }, 'inviting to project')

    const allowed = await LimitationsManager.promises.canAddXCollaborators(
      projectId,
      1
    )
    if (!allowed) {
      logger.debug(
        { projectId, email, sendingUserId },
        'not allowed to invite more users to project'
      )
      return res.json({ invite: null })
    }

    // Check if input is a phone number, if so, resolve to email via NE system
    let finalEmail = email
    if (isPhoneNumber(email)) {
      logger.debug({ phone: email }, 'resolving phone number to email')
      const resolvedEmail = await getEmailByPhoneNumber(email)
      if (resolvedEmail) {
        finalEmail = resolvedEmail
        logger.debug({ phone: email, email: resolvedEmail }, 'phone number resolved to email')
      } else {
        logger.debug({ phone: email }, 'failed to resolve phone number to email')
        return res.status(400).json({ errorReason: 'invalid_email' })
      }
    } else {
      // Standard email validation
      finalEmail = EmailHelper.parseEmail(email, true)
      if (finalEmail == null || finalEmail === '') {
        logger.debug({ projectId, email: finalEmail, sendingUserId }, 'invalid email address')
        return res.status(400).json({ errorReason: 'invalid_email' })
      }
    }

    const underRateLimit = await CollaboratorsInviteController._checkRateLimit(
      sendingUserId
    )
    if (!underRateLimit) {
      return res.sendStatus(429)
    }

    const shouldAllowInvite =
      await CollaboratorsInviteController._checkShouldInviteEmail(finalEmail)
    if (!shouldAllowInvite) {
      logger.debug(
        { email: finalEmail, projectId, sendingUserId },
        'not allowed to send an invite to this email address'
      )
      return res.json({
        invite: null,
        error: 'cannot_invite_non_user',
      })
    }

    const invite = await CollaboratorsInviteHandler.promises.inviteToProject(
      projectId,
      sendingUser,
      finalEmail,
      privileges
    )

    ProjectAuditLogHandler.addEntryInBackground(
      projectId,
      'send-invite',
      sendingUserId,
      req.ip,
      {
        inviteId: invite._id,
        privileges,
      }
    )

    logger.debug({ projectId, email: finalEmail, sendingUserId }, 'invite created')

    EditorRealTimeController.emitToRoom(
      projectId,
      'project:membership:changed',
      { invites: true }
    )
    res.json({ invite })
  },

  async revokeInvite(req, res) {
    const projectId = req.params.Project_id
    const inviteId = req.params.invite_id
    const user = SessionManager.getSessionUser(req.session)

    logger.debug({ projectId, inviteId }, 'revoking invite')

    const invite = await CollaboratorsInviteHandler.promises.revokeInvite(
      projectId,
      inviteId
    )

    if (invite != null) {
      ProjectAuditLogHandler.addEntryInBackground(
        projectId,
        'revoke-invite',
        user._id,
        req.ip,
        {
          inviteId: invite._id,
          privileges: invite.privileges,
        }
      )
      EditorRealTimeController.emitToRoom(
        projectId,
        'project:membership:changed',
        { invites: true }
      )
    }

    res.sendStatus(204)
  },

  async resendInvite(req, res) {
    const projectId = req.params.Project_id
    const inviteId = req.params.invite_id
    const user = SessionManager.getSessionUser(req.session)

    logger.debug({ projectId, inviteId }, 'resending invite')
    const sendingUser = SessionManager.getSessionUser(req.session)
    const underRateLimit = await CollaboratorsInviteController._checkRateLimit(
      sendingUser._id
    )
    if (!underRateLimit) {
      return res.sendStatus(429)
    }

    const invite = await CollaboratorsInviteHandler.promises.resendInvite(
      projectId,
      sendingUser,
      inviteId
    )

    if (invite != null) {
      ProjectAuditLogHandler.addEntryInBackground(
        projectId,
        'resend-invite',
        user._id,
        req.ip,
        {
          inviteId: invite._id,
          privileges: invite.privileges,
        }
      )
    }

    res.sendStatus(201)
  },

  async viewInvite(req, res) {
    const projectId = req.params.Project_id
    const { token } = req.params
    const _renderInvalidPage = function () {
      logger.debug({ projectId }, 'invite not valid, rendering not-valid page')
      res.render('project/invite/not-valid', { title: 'Invalid Invite' })
    }

    // check if the user is already a member of the project
    const currentUser = SessionManager.getSessionUser(req.session)
    const isMember =
      await CollaboratorsGetter.promises.isUserInvitedMemberOfProject(
        currentUser._id,
        projectId
      )
    if (isMember) {
      logger.debug(
        { projectId, userId: currentUser._id },
        'user is already a member of this project, redirecting'
      )
      return res.redirect(`/project/${projectId}`)
    }

    // get the invite
    const invite = await CollaboratorsInviteHandler.promises.getInviteByToken(
      projectId,
      token
    )

    // check if invite is gone, or otherwise non-existent
    if (invite == null) {
      logger.debug({ projectId }, 'no invite found for this token')
      return _renderInvalidPage()
    }

    // check the user who sent the invite exists
    const owner = await UserGetter.promises.getUser(
      { _id: invite.sendingUserId },
      { email: 1, first_name: 1, last_name: 1 }
    )
    if (owner == null) {
      logger.debug({ projectId }, 'no project owner found')
      return _renderInvalidPage()
    }

    // fetch the project name
    const project = await ProjectGetter.promises.getProject(projectId, {
      name: 1,
    })
    if (project == null) {
      logger.debug({ projectId }, 'no project found')
      return _renderInvalidPage()
    }

    // finally render the invite
    res.render('project/invite/show', {
      invite,
      project,
      owner,
      title: 'Project Invite',
    })
  },

  async acceptInvite(req, res) {
    const { Project_id: projectId, token } = req.params
    const currentUser = SessionManager.getSessionUser(req.session)
    logger.debug(
      { projectId, userId: currentUser._id },
      'got request to accept invite'
    )

    const invite = await CollaboratorsInviteHandler.promises.getInviteByToken(
      projectId,
      token
    )

    if (invite == null) {
      throw new Errors.NotFoundError('no matching invite found')
    }

    await ProjectAuditLogHandler.promises.addEntry(
      projectId,
      'accept-invite',
      currentUser._id,
      req.ip,
      {
        inviteId: invite._id,
        privileges: invite.privileges,
      }
    )

    await CollaboratorsInviteHandler.promises.acceptInvite(
      invite,
      projectId,
      currentUser
    )

    await EditorRealTimeController.emitToRoom(
      projectId,
      'project:membership:changed',
      { invites: true, members: true }
    )
    AnalyticsManager.recordEventForUser(
      currentUser._id,
      'project-invite-accept',
      {
        projectId,
      }
    )

    if (req.xhr) {
      res.sendStatus(204) //  Done async via project page notification
    } else {
      res.redirect(`/project/${projectId}`)
    }
  },
}

module.exports = {
  promises: CollaboratorsInviteController,
  getAllInvites: expressify(CollaboratorsInviteController.getAllInvites),
  inviteToProject: expressify(CollaboratorsInviteController.inviteToProject),
  revokeInvite: expressify(CollaboratorsInviteController.revokeInvite),
  resendInvite: expressify(CollaboratorsInviteController.resendInvite),
  viewInvite: expressify(CollaboratorsInviteController.viewInvite),
  acceptInvite: expressify(CollaboratorsInviteController.acceptInvite),
  _checkShouldInviteEmail: callbackify(
    CollaboratorsInviteController._checkShouldInviteEmail
  ),
  _checkRateLimit: callbackify(CollaboratorsInviteController._checkRateLimit),
}
