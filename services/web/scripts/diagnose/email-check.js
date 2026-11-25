#!/usr/bin/env node
'use strict'
/**
 * 邮件链路自检（只读 + 可选发一封）
 *
 * FIXED: 2026-11-19 新增。排查「点了重发但没收到邮件」时用一条命令看清：
 *   - 当前进程实际读到的 transport / provider（不打印 key）
 *   - 某条 invite 是否存在、收件人是谁、projectId 是否与 URL 对得上
 *     （对不上时后端会静默返回 201、一封不发）
 *   - 可选：真的发一封，直接看到成功或 Brevo 返回码
 *
 * 用法（在 services/web 下）：
 *   node scripts/diagnose/email-check.js
 *   node scripts/diagnose/email-check.js --project <projectId> --invite <inviteId>
 *   node scripts/diagnose/email-check.js --send-to you@example.com
 */

// 必须在 require @overleaf/settings 之前切到 services/web，否则读不到 config
const path = require('path')
process.chdir(path.join(__dirname, '..', '..'))

const INTERNAL = require('../../config/internal-values')

function getArg(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

async function printConfig() {
  const internalEmail = (INTERNAL && INTERNAL.email) || {}
  const transport =
    process.env.EMAIL_TRANSPORT ||
    internalEmail.transport ||
    '(legacy: smtp/ses)'
  const provider =
    process.env.EMAIL_PROVIDER || internalEmail.provider || 'generic'
  const url = process.env.EMAIL_GATEWAY_URL || internalEmail.gatewayUrl || ''
  const token =
    process.env.EMAIL_GATEWAY_TOKEN || internalEmail.gatewayToken || ''
  console.log('== 配置 ==')
  console.log('transport :', transport)
  console.log('provider  :', provider)
  console.log('url       :', url || '(empty)')
  console.log('token     :', token ? 'set' : 'MISSING')
  console.log('senderName:', internalEmail.senderName || '(fallback)')
  console.log(
    'senderEmail:',
    process.env.EMAIL_SENDER_EMAIL ||
      internalEmail.senderEmail ||
      '(fallback: misc.adminEmail)'
  )
}

async function printInvite(projectId, inviteId) {
  const { db, waitForDb } = require('../../app/src/infrastructure/mongodb')
  const { ObjectId } = require('mongodb')
  await waitForDb()

  const pid = ObjectId(projectId)
  const iid = ObjectId(inviteId)
  const byId = await db.projectInvites.findOne({ _id: iid })
  const matchesProject = await db.projectInvites.findOne({
    _id: iid,
    projectId: pid,
  })
  const forProject = await db.projectInvites
    .find({ projectId: pid }, { email: 1 })
    .toArray()

  console.log('== invite ==')
  console.log('inviteExists    :', !!byId)
  console.log('inviteEmail     :', byId && byId.email)
  console.log('inviteProjectId :', byId && String(byId.projectId))
  console.log('matchesUrlProject:', !!matchesProject)
  console.log(
    'invitesOfProject:',
    JSON.stringify(forProject.map(i => ({ id: String(i._id), email: i.email })))
  )
  if (!byId) {
    console.log('=> invite 不存在：重发会静默返回 201，且一封邮件都不会发')
  } else if (!matchesProject) {
    console.log('=> invite 属于别的项目：重发同样静默 201、不发信')
  }
}

async function sendTestEmail(to) {
  const EmailSender = require('../../app/src/Features/Email/EmailSender')
  console.log('== send ==')
  console.log('to:', to)
  try {
    await EmailSender.promises.sendEmail({
      emailType: 'diagnostic',
      to,
      subject: 'FlyLaTeX 邮件链路自检',
      html: '<p>email-check</p>',
      text: 'email-check',
    })
    console.log('SEND_OK')
  } catch (err) {
    console.error('SEND_FAIL', err.message, JSON.stringify(err.info || {}))
    process.exitCode = 1
  }
}

async function main() {
  await printConfig()
  const projectId = getArg('--project')
  const inviteId = getArg('--invite')
  if (projectId && inviteId) {
    try {
      await printInvite(projectId, inviteId)
    } catch (err) {
      console.error('invite 查询失败:', err.message)
      process.exitCode = 1
    }
  } else if (projectId || inviteId) {
    console.error('--project 和 --invite 必须一起给')
    process.exitCode = 1
  }
  const sendTo = getArg('--send-to')
  if (sendTo) {
    await sendTestEmail(sendTo)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
