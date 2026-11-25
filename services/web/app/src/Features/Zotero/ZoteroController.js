'use strict'

/**
 * FIXED: 2026-11-16 设置 → 关联 → Zotero，以及「插入引用」里的 Zotero 数据源。
 *
 * 设计取舍（为什么不照搬 Pro 的 linked-file 那套）：
 *   Pro 的 tpr-webmodule 把 Zotero 条目做成**项目里的链接文件**（可刷新的外来文件），
 *   代价是要维护文件实体、刷新代理、附件下载与权限；而写 LaTeX 真正需要的是
 *   「把条目变成 .bib 里的一条 + 插一个 \cite{}」——那是我们已有的链路
 *   （/project/:id/update-bib-file + 本地 .bib 索引补全）。
 *   所以这里只做「只读元数据代理」：列库 / 搜索 / 导出 BibTeX，不碰文件。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const RedisWrapper = require('../../infrastructure/RedisWrapper')
const SessionManager = require('../Authentication/SessionManager')
const AuthorizationManager = require('../Authorization/AuthorizationManager')
const ProjectGetter = require('../Project/ProjectGetter')
const FileSystemImportManager = require('../Uploads/FileSystemImportManager')
const Zotero = require('./ZoteroApiClient')
const ZoteroOAuth1 = require('./ZoteroOAuth1')

function userIdOf(req) {
  const user = SessionManager.getSessionUser(req.session)
  return user ? user._id.toString() : null
}

function fail(res, error) {
  const status =
    error && error.name === 'ZoteroApiError' ? error.statusCode : 500
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    code: 1,
    msg: (error && error.message) || 'Zotero 请求失败',
    data: null,
  })
}

async function requireCredentials(req, res) {
  const userId = userIdOf(req)
  const credentials = await Zotero.getCredentials(userId)
  if (!credentials) {
    res.json({
      code: 1,
      msg: '还没有绑定 Zotero 账号（设置 → 关联 → Zotero）',
      data: null,
    })
    return null
  }
  return { userId, credentials }
}

/** GET /api/zotero/status —— 是否已绑定、绑的是谁、库里有多少条目 */
async function status(req, res, next) {
  try {
    const userId = userIdOf(req)
    if (!userId) {
      return res.status(401).json({ code: 1, msg: '未授权的请求', data: null })
    }

    const credentials = await Zotero.getCredentials(userId)
    if (!credentials) {
      return res.json({
        code: 0,
        msg: 'ok',
        data: {
          linked: false,
          apiUrl: Zotero.apiBaseUrl(),
          oauthAvailable: ZoteroOAuth1.isConfigured(),
        },
      })
    }

    const described = Zotero.describeCredentials(credentials)
    let itemCount = null
    let collections = []
    let warning = null
    try {
      const collectionsResult = await Zotero.listCollections(credentials)
      collections = collectionsResult
      const itemsResult = await Zotero.listItems(credentials, { limit: 1 })
      itemCount = itemsResult.totalResults
    } catch (error) {
      // 已绑定但读不到：把原因说出来，不要伪装成"未绑定"
      warning = error.message
    }

    return res.json({
      code: 0,
      msg: 'ok',
      data: {
        linked: true,
        ...described,
        itemCount,
        collections,
        warning,
        oauthAvailable: ZoteroOAuth1.isConfigured(),
      },
    })
  } catch (error) {
    return fail(res, error)
  }
}

/** POST /api/zotero/link  body: { apiKey } */
async function link(req, res, next) {
  try {
    const userId = userIdOf(req)
    if (!userId) {
      return res.status(401).json({ code: 1, msg: '未授权的请求', data: null })
    }

    const apiKey =
      typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : ''
    // FIXED: 2026-11-16 允许手填 user ID（可留空：留空则用 /keys/current 自动推导）
    const userIdInput =
      typeof req.body.userId === 'string' || typeof req.body.userId === 'number'
        ? String(req.body.userId).trim()
        : ''
    if (!apiKey) {
      return res.json({ code: 1, msg: '请填写 Zotero API Key', data: null })
    }
    if (userIdInput && !/^\d{1,12}$/.test(userIdInput)) {
      return res.json({
        code: 1,
        msg: 'User ID 应是纯数字（在 zotero.org/settings/keys 页面能看到，如 22604681）',
        data: null,
      })
    }
    if (!/^[A-Za-z0-9]{16,64}$/.test(apiKey)) {
      return res.json({
        code: 1,
        msg: 'Key 格式不对：Zotero 的 API Key 是 16-64 位字母数字（在 zotero.org/settings/keys 生成）',
        data: null,
      })
    }

    // 先验证再用：手填了 user ID 就校验这个库；否则用 /keys/current 推导
    let keyInfo
    try {
      if (userIdInput) {
        await Zotero.verifyUserLibrary(apiKey, userIdInput)
        // 用户名取得到就带上（取不到不影响绑定）
        let username = ''
        try {
          const current = await Zotero.getKeyInfo(apiKey)
          username = current.username || ''
          if (!current.library) {
            return res.json({
              code: 1,
              msg: '这把 Key 没有勾选「Allow library access」，请在 Zotero 里编辑 Key 后重试',
              data: null,
            })
          }
        } catch {
          // /keys/current 不可用不算失败：手填的 user ID 已经能列条目了
        }
        keyInfo = {
          userID: Number(userIdInput),
          username,
          library: true,
          files: true,
        }
      } else {
        keyInfo = await Zotero.getKeyInfo(apiKey)
      }
    } catch (error) {
      return fail(res, error)
    }
    if (!keyInfo.library) {
      return res.json({
        code: 1,
        msg: '这把 Key 没有勾选「Allow library access」，请在 Zotero 里编辑 Key 后重试',
        data: null,
      })
    }

    await Zotero.saveCredentials(userId, { apiKey, keyInfo })

    let itemCount = null
    let collections = []
    try {
      const credentials = await Zotero.getCredentials(userId)
      collections = await Zotero.listCollections(credentials)
      itemCount = (await Zotero.listItems(credentials, { limit: 1 }))
        .totalResults
    } catch {
      // 统计失败不影响绑定成功
    }

    return res.json({
      code: 0,
      msg: '已绑定',
      data: {
        linked: true,
        username: keyInfo.username,
        itemCount,
        collections,
      },
    })
  } catch (error) {
    return fail(res, error)
  }
}

/** POST /api/zotero/unlink */
async function unlink(req, res, next) {
  try {
    const userId = userIdOf(req)
    if (!userId) {
      return res.status(401).json({ code: 1, msg: '未授权的请求', data: null })
    }
    await Zotero.clearCredentials(userId)
    return res.json({ code: 0, msg: '已解绑', data: { linked: false } })
  } catch (error) {
    return fail(res, error)
  }
}

/** GET /api/zotero/collections */
async function collections(req, res, next) {
  try {
    const ctx = await requireCredentials(req, res)
    if (!ctx) {
      return
    }
    const list = await Zotero.listCollections(ctx.credentials)
    return res.json({ code: 0, msg: 'ok', data: { collections: list } })
  } catch (error) {
    return fail(res, error)
  }
}

/** GET /api/zotero/items?q=&collection=&limit= */
async function items(req, res, next) {
  try {
    const ctx = await requireCredentials(req, res)
    if (!ctx) {
      return
    }
    const result = await Zotero.listItems(ctx.credentials, {
      q: typeof req.query.q === 'string' ? req.query.q : '',
      collectionKey:
        typeof req.query.collection === 'string' ? req.query.collection : '',
      limit: req.query.limit,
    })
    return res.json({
      code: 0,
      msg: 'ok',
      data: {
        items: result.items,
        totalResults: result.totalResults,
        // FIXED: 2026-11-17 库比一次能拉的量更大时告诉前端（前端会提示用关键词搜）
        truncated: Boolean(result.truncated),
      },
    })
  } catch (error) {
    return fail(res, error)
  }
}

/** POST /api/zotero/bibtex  body: { keys: [...] } */
async function bibtex(req, res, next) {
  try {
    const ctx = await requireCredentials(req, res)
    if (!ctx) {
      return
    }
    const keys = Array.isArray(req.body.keys) ? req.body.keys : []
    const list = await Zotero.getItemsBibtex(ctx.credentials, keys)
    return res.json({ code: 0, msg: 'ok', data: { items: list } })
  } catch (error) {
    return fail(res, error)
  }
}

/** POST /api/zotero/export-bibtex  body: { collectionKey?, maxEntries? } */
async function exportBibtex(req, res, next) {
  try {
    const ctx = await requireCredentials(req, res)
    if (!ctx) {
      return
    }
    const result = await Zotero.exportBibtex(ctx.credentials, {
      collectionKey:
        typeof req.body.collectionKey === 'string'
          ? req.body.collectionKey
          : '',
      maxEntries: req.body.maxEntries,
    })
    return res.json({ code: 0, msg: 'ok', data: result })
  } catch (error) {
    return fail(res, error)
  }
}

/**
 * POST /api/zotero/import-attachment  body: { projectId, itemKey, folderId? }
 * 把条目对应的 PDF 存进项目（走 FileSystemImportManager，与「上传」同一条链路）。
 */
async function importAttachment(req, res, next) {
  let tempPath = null
  try {
    const userId = userIdOf(req)
    if (!userId) {
      return res.status(401).json({ code: 1, msg: '未授权的请求', data: null })
    }
    const projectId =
      typeof req.body.projectId === 'string' ? req.body.projectId : ''
    const itemKey = typeof req.body.itemKey === 'string' ? req.body.itemKey : ''
    if (!projectId || !itemKey) {
      return res.json({ code: 1, msg: '缺少 projectId / itemKey', data: null })
    }

    // 与 aiChatService 同口径：写文件需要 owner 或 readAndWrite
    const privilegeLevel =
      await AuthorizationManager.promises.getPrivilegeLevelForProject(
        userId,
        projectId
      )
    if (privilegeLevel !== 'owner' && privilegeLevel !== 'readAndWrite') {
      return res.status(403).json({
        code: 1,
        msg: '当前账号没有编辑权限，无法写入文件',
        data: null,
      })
    }

    const credentials = await Zotero.getCredentials(userId)
    if (!credentials) {
      return res.json({ code: 1, msg: '还没有绑定 Zotero 账号', data: null })
    }

    const children = await Zotero.listChildren(credentials, itemKey)
    const attachment = Zotero.pickPdfAttachment(children)
    if (!attachment) {
      return res.json({
        code: 1,
        msg: '这条文献在 Zotero 里没有可用的 PDF 附件（只支持 Zotero 存储的 PDF）',
        data: null,
      })
    }

    const file = await Zotero.downloadAttachment(credentials, attachment.key)

    const project = await ProjectGetter.promises.getProject(projectId, {
      rootFolder: true,
    })
    if (!project || !project.rootFolder) {
      return res.json({ code: 1, msg: '项目不存在', data: null })
    }

    const safeName = (attachment.filename || file.filename || `${itemKey}.pdf`)
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(-120)
    const finalName = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`

    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'zotero-att-')
    )
    tempPath = path.join(tmpDir, finalName)
    await fs.promises.writeFile(tempPath, file.buffer)

    const entity = await FileSystemImportManager.promises.addEntity(
      userId,
      projectId,
      project.rootFolder._id,
      finalName,
      tempPath,
      false
    )

    return res.json({
      code: 0,
      msg: '已存入项目',
      data: { fileName: finalName, entityId: entity && entity._id },
    })
  } catch (error) {
    return fail(res, error)
  } finally {
    if (tempPath) {
      fs.promises
        .rm(path.dirname(tempPath), { recursive: true, force: true })
        .catch(() => {})
    }
  }
}

function oauthPendingStore() {
  return RedisWrapper.client('zotero_oauth_pending')
}

const OAUTH_PENDING_TTL_SECONDS = 15 * 60

/** GET /user/zotero/oauth —— 发起 OAuth1 授权 */
async function oauthStart(req, res, next) {
  try {
    if (!ZoteroOAuth1.isConfigured()) {
      return res
        .status(404)
        .send(
          'Zotero OAuth 未配置（见 config/settings.defaults.js 的 Settings.zotero.oauth）'
        )
    }
    // FIXED: 2026-11-16 oauthStart 里漏了 userId（重写时被我删掉了），
    // 线上直接 ReferenceError: userId is not defined → 500。
    const userId = userIdOf(req)
    if (!userId) {
      return res.status(401).send('需要登录后再授权 Zotero')
    }

    const siteUrl = (Settings.siteUrl || '').replace(/\/+$/, '')
    // FIXED: 2026-11-16 回调地址优先取环境变量：
    // 在 Zotero 申请 OAuth 应用时要登记一个**完全一致**的回调地址，
    // 我们两个前缀（/api/zotero 与 /user/zotero）都注册了同一个处理器，
    // 所以登记哪个都行；用 ZOTERO_OAUTH_CALLBACK_URL 可以钉死它，避免
    // siteUrl 配错导致 oauth_verifier 校验失败。
    // 回调地址来源优先级：env > 配置文件 > 用 siteUrl 拼默认值
    const callbackUrl =
      ZoteroOAuth1.resolveConfig().callbackUrl ||
      `${siteUrl}/api/zotero/oauth/callback`
    const { token, secret, authorizeUrl } =
      await ZoteroOAuth1.getRequestToken(callbackUrl)

    // FIXED: 2026-11-16 pending 放 Redis，**不再塞 session**。
    // 原因：Zotero 授权完是「从 zotero.org 跳到我们域名」的顶层跳转，
    // 若会话 cookie 是 SameSite=Strict，这一跳不会带 cookie → 回调被当成未登录
    // → 用户被踢去 /login（就是线上看到的「循环登录」）。
    // 现在回调只靠 URL 里的 oauth_token 找回 pending（含发起人 userId），不依赖 cookie。
    await oauthPendingStore().setex(
      `pending:${token}`,
      OAUTH_PENDING_TTL_SECONDS,
      JSON.stringify({ secret, userId })
    )

    return res.redirect(authorizeUrl)
  } catch (error) {
    // FIXED: 2026-11-16 别再把这种错误变成 500「Something went wrong」——
    // 常见原因是服务器出不了网（连不上 zotero.org）或凭据/回调地址不对。
    logger.warn({ err: error }, '[zotero] oauth start 失败')
    return res.status(502).type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Zotero 授权</title></head>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;color:#1f2937">
<h2 style="font-size:16px;margin:0 0 8px">没能开始 Zotero 授权</h2>
<p style="font-size:13px;line-height:1.7;color:#6b7785">原因：${String(
      error.message || error
    )
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</p>
<p style="font-size:13px"><a href="/project">返回项目列表</a></p>
</body></html>`)
  }
}

/** GET /user/zotero/oauth/callback?oauth_token=&oauth_verifier=（不需要登录态） */
async function oauthCallback(req, res, next) {
  const token = typeof req.query.oauth_token === 'string' ? req.query.oauth_token : ''
  const verifier = req.query.oauth_verifier

  try {
    if (!token || !verifier) {
      return respondOAuthResult(res, false)
    }

    const raw = await oauthPendingStore().get(`pending:${token}`)
    if (!raw) {
      logger.warn({ token: token.slice(0, 6) }, '[zotero] oauth pending 不存在或已过期')
      return respondOAuthResult(res, false)
    }
    const pending = JSON.parse(raw)
    await oauthPendingStore().del(`pending:${token}`)

    const result = await ZoteroOAuth1.getAccessToken({
      requestToken: token,
      requestTokenSecret: pending.secret,
      verifier,
    })

    // access token 就是可用的 API Key；用 /keys/current 再核一遍权限与 userID
    const keyInfo = await Zotero.getKeyInfo(result.apiKey)
    await Zotero.saveCredentials(pending.userId, {
      apiKey: result.apiKey,
      keyInfo: {
        ...keyInfo,
        userID: keyInfo.userID || result.userID,
        username: keyInfo.username || result.username,
      },
    })

    return respondOAuthResult(res, true)
  } catch (error) {
    logger.warn({ err: error }, '[zotero] oauth callback 失败')
    return respondOAuthResult(res, false)
  }
}

/**
 * FIXED: 2026-11-16 OAuth 回调的落地页。
 *
 * 用户从设置页点「用 Zotero 账号登录并授权」是**新窗口**打开的，
 * 认证完会回到这里。如果直接把窗口跳到 /user/settings，用户会得到两个设置页，
 * 而原来那个页面并不知道已经绑定成功。所以：
 *   · 有 window.opener → postMessage 告知结果并自动关闭自己（原页面刷新状态）
 *   · 没有 opener（被弹窗拦截、走了同标签页）→ 跳回设置页并带上结果参数
 * 注意：内联脚本在 CSP 关闭时可用（默认就是关闭）；万一 CSP 打开，
 * 兜底的 meta refresh 仍然会把用户送回设置页。
 */
function respondOAuthResult(res, ok) {
  // FIXED: 2026-11-16 落地页**不再自动跳转**。
  // 之前 meta refresh 到 /project，而 Zotero 会下发 COOP 头，opener 多半已被切断，
  // 于是用户看到的是「授权窗口跳到了项目列表」——分不清到底成没成。
  // 现在只显示结果，让用户自己关窗口；同时保留 postMessage（opener 还在的浏览器能用）。
  const title = ok ? 'Zotero 已绑定' : 'Zotero 授权没有完成'
  const detail = ok
    ? '可以关闭本窗口回到设置页，状态会自动刷新。'
    : '可能是授权被取消、pending 过期，或服务器连不上 Zotero。可以关掉本窗口再试一次，或改用「高级：用 API Key 绑定」。'
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:28px;color:#1f2937">
<h2 style="font-size:17px;margin:0 0 8px">${title}</h2>
<p style="font-size:13px;line-height:1.8;color:#6b7785">${detail}</p>
<p style="font-size:13px;margin-top:16px"><a href="/project">回到 FlyLaTeX</a></p>
<script>
try {
  if (window.opener) {
    window.opener.postMessage(
      { type: 'zotero-oauth', ok: ${ok ? 'true' : 'false'} },
      window.location.origin
    )
  }
} catch (e) {}
</script>
</body></html>`
  res.status(200).type('html').send(html)
}

module.exports = {
  status,
  link,
  unlink,
  collections,
  items,
  bibtex,
  exportBibtex,
  importAttachment,
  oauthStart,
  oauthCallback,
}
