'use strict'

/**
 * FIXED: 2026-11-16 Zotero Web API 客户端（服务端代理）。
 *
 * 为什么必须在服务端：Zotero 的 API Key 是用户的私人凭据，不能下发到浏览器；
 * 而且 `api.zotero.org` 从国内浏览器直连不稳定，走我们自己的服务器更可控。
 * 出网策略：默认直连 api.zotero.org；如果部署环境要走内网代理，
 * 用 `ZOTERO_API_URL` 指向你们自己的反代即可（代理侧负责鉴权/转发），
 * 本进程不内置代理支持（Node 自带 fetch 没有 ProxyAgent，避免为一个可选能力引新依赖）。
 *
 * 只读接口，覆盖 v1 需要的四件事：
 *   - 验证 key 并拿到 userID（GET /keys/current）
 *   - 列 collections
 *   - 列/搜 top 级条目（不含附件与子条目的噪音）
 *   - 把指定条目导出成 BibTeX（GET /items/{key}?format=bibtex）
 */

const Settings = require('@overleaf/settings')
const { User } = require('../../models/User')
const Cipher = require('./ZoteroCredentialCipher')

// FIXED: 2026-11-16 配置统一从 Settings.zotero 读（见 config/settings.defaults.js），
// 模块里不再散落 process.env —— 开源出去别人只需看一处。
function zoteroSettings() {
  return Settings.zotero || {}
}

// FIXED: 2026-11-17 列表分页参数（原来只有一个硬钳 50）
//   Zotero 服务端 limit 上限是 100 条/次，所以 200 条要拉两页。
const LIST_PAGE_SIZE = 100
const LIST_DEFAULT_ITEMS = 200
const LIST_MAX_ITEMS = 500

function requestTimeoutMs() {
  return Number(zoteroSettings().timeoutMs) || 12000
}

function maxBibtexItems() {
  return Number(zoteroSettings().maxBibtexItems) || 20
}

function apiBaseUrl() {
  return String(zoteroSettings().apiUrl || 'https://api.zotero.org').replace(
    /\/+$/,
    ''
  )
}

class ZoteroApiError extends Error {
  constructor(message, statusCode, detail) {
    super(message)
    this.name = 'ZoteroApiError'
    this.statusCode = statusCode
    this.detail = detail
  }
}

/**
 * 统一请求：带 API Key、超时、把 Zotero 的错误翻译成人话。
 * 返回 { json, totalResults }
 */
async function request(apiKey, path, { query } = {}) {
  const url = new URL(`${apiBaseUrl()}${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const controller = new AbortController()
  const timeoutMs = requestTimeoutMs()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(url, {
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-API-Version': '3',
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    if (error.name === 'AbortError') {
      throw new ZoteroApiError(
        `Zotero 请求超时（${timeoutMs}ms）：${path}`,
        504
      )
    }
    throw new ZoteroApiError(
      `连不上 Zotero（${
        error.message
      }）。服务器需要能出网访问 ${apiBaseUrl()}；若走内网代理，把 ZOTERO_API_URL 指到你们的反代地址即可`,
      502
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()

  if (!response.ok) {
    let detail = text.slice(0, 300)
    try {
      detail = JSON.parse(text).message || detail
    } catch {
      // 保持原文
    }
    const status =
      response.status === 403 || response.status === 401 ? 403 : 502
    throw new ZoteroApiError(
      response.status === 403 || response.status === 401
        ? `Zotero 拒绝了这把 Key（${response.status}）：${detail}`
        : `Zotero 返回 ${response.status}：${detail}`,
      status
    )
  }

  // 有的接口返回 BibTeX（?format=bibtex）而不是 JSON，这里不能无脑 parse
  let json = null
  if (text) {
    const firstChar = text.trim()[0]
    if (firstChar === '{' || firstChar === '[') {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
  }

  return {
    text,
    json,
    totalResults: Number(response.headers.get('total-results')) || null,
  }
}

/**
 * FIXED: 2026-11-16 校验「手填的 user ID」是否可用。
 * Zotero 的路径是 /users/{userID}/items，userID 也可以由 /keys/current 推导；
 * 但用户明确要求能自己填（团队共用一把 key、或 key 读不到 /keys/current 时），
 * 所以这里提供一条独立的校验：能列出 1 条条目就算通过。
 */
async function verifyUserLibrary(apiKey, userId) {
  const { totalResults } = await request(apiKey, `/users/${userId}/items/top`, {
    query: { limit: 1 },
  })
  return { ok: true, itemCount: totalResults }
}

/** 验证 key 并返回 userID / username / 权限 */
async function getKeyInfo(apiKey) {
  const { json } = await request(apiKey, '/keys/current')
  return {
    userID: json.userID,
    username: json.username,
    library: Boolean(
      json.access && json.access.user && json.access.user.library
    ),
    files: Boolean(json.access && json.access.user && json.access.user.files),
  }
}

function libraryPath(credentials) {
  const type = credentials.libraryType === 'group' ? 'groups' : 'users'
  return `/${type}/${credentials.libraryId}`
}

async function listCollections(credentials) {
  const { json } = await request(
    credentials.apiKey,
    `${libraryPath(credentials)}/collections`,
    { query: { limit: 100 } }
  )
  return (json || []).map(collection => ({
    key: collection.key,
    name: collection.data && collection.data.name,
    itemCount: collection.meta && collection.meta.numItems,
  }))
}

/**
 * 列/搜条目。只取 top 级（排除附件与 note 子条目），
 * 这样列表里出现的都是"能引用"的东西。
 *
 * FIXED: 2026-11-17 支持分页拉取（原来硬钳 50 条）。
 *   前端要做「选中分类后一次拉下来 + 输入即内存过滤」，一条只在几百字节，
 *   一次拉 200 条（上限 500）比每敲一个字一个网络往返干净得多。
 *   OLD: const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 50)
 *   OLD: 单次 request，return { items, totalResults }
 */
async function listItems(credentials, { q, collectionKey, limit } = {}) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || LIST_DEFAULT_ITEMS, 1),
    LIST_MAX_ITEMS
  )
  const path = collectionKey
    ? `${libraryPath(credentials)}/collections/${collectionKey}/items/top`
    : `${libraryPath(credentials)}/items/top`

  const items = []
  let totalResults = null
  let start = 0

  while (items.length < safeLimit) {
    const pageSize = Math.min(LIST_PAGE_SIZE, safeLimit - items.length)
    const page = await request(credentials.apiKey, path, {
      query: {
        limit: pageSize,
        start,
        q: q || undefined,
        // 最近修改优先：用户刚加的文献一般就在前面
        sort: 'dateModified',
        direction: 'desc',
      },
    })
    const json = page.json
    if (page.totalResults != null) {
      totalResults = page.totalResults
    }
    const batch = json || []
    if (!batch.length) {
      break
    }
    for (const item of batch) {
      items.push(mapListItem(item))
    }
    start += batch.length
    if (totalResults != null && start >= totalResults) {
      break
    }
    if (items.length >= LIST_MAX_ITEMS) {
      break // 兜底，别把极端大库拖太久
    }
  }

  return {
    items,
    totalResults,
    // 库比一次能拉的量更大：前端要提示「用关键词搜索」而不是假装拉全了
    truncated: totalResults != null && items.length < totalResults,
  }
}

/** 把 Zotero 原始条目映射成前端渲染用的字段（字段名与结果表一致） */
function mapListItem(item) {
  const data = item.data || {}
  return {
    key: item.key || data.key,
    version: item.version,
    itemType: data.itemType,
    title: data.title || data.name || '(未命名条目)',
    creators: (data.creators || []).map(
      creator =>
        creator.name ||
        [creator.lastName, creator.firstName].filter(Boolean).join(', ')
    ),
    date: data.date || '',
    year: (data.date || '').match(/^\d{4}/)?.[0] || '',
    publication:
      data.publicationTitle || data.bookTitle || data.publisher || '',
    url: data.url || '',
    doi: data.DOI || '',
    abstractNote: data.abstractNote || '',
    citationKey: data.citationKey || '',
    collections: data.collections || [],
    dateModified: data.dateModified || '',
  }
}

/** 把条目里的引用键解析出来（@book{citeKey, ...） */
function parseCitationKey(bibtex) {
  const match = /@\w+\s*\{\s*([^,\s]+)\s*,/.exec(bibtex || '')
  return match ? match[1] : ''
}

/** 单条条目导出 BibTeX（带引用键），供「插入引用」直接写进 .bib */
async function getItemBibtex(credentials, itemKey) {
  const { text } = await request(
    credentials.apiKey,
    `${libraryPath(credentials)}/items/${itemKey}`,
    { query: { format: 'bibtex' } }
  )
  const bibtex = (text || '').trim()
  return { key: itemKey, bibtex, citationKey: parseCitationKey(bibtex) }
}

/** 批量导出（并发，上限见 Settings.zotero.maxBibtexItems） */
async function getItemsBibtex(credentials, itemKeys) {
  const keys = Array.isArray(itemKeys)
    ? [...new Set(itemKeys.filter(k => typeof k === 'string' && k))]
    : []
  if (!keys.length) {
    return []
  }
  const limit = maxBibtexItems()
  if (keys.length > limit) {
    throw new ZoteroApiError(`一次最多导出 ${limit} 条，请分批插入`, 400)
  }
  return Promise.all(keys.map(key => getItemBibtex(credentials, key)))
}

/**
 * 整库 / 整分类导出 BibTeX（分页拉，服务端合并）。
 * 用 Zotero 自己的 `?format=bibtex`，不自己拼条目 —— 它对转义（C\#）和
 * 各类 itemType 的处理比我们手写准。
 */
async function exportBibtex(credentials, { collectionKey, maxEntries } = {}) {
  const cap = Math.min(Math.max(Number(maxEntries) || 500, 1), 2000)
  const pageSize = 100
  const path = collectionKey
    ? `${libraryPath(credentials)}/collections/${collectionKey}/items/top`
    : `${libraryPath(credentials)}/items/top`

  const chunks = []
  let entryCount = 0
  let start = 0
  let total = null

  while (entryCount < cap) {
    const { text, totalResults } = await request(credentials.apiKey, path, {
      query: { format: 'bibtex', limit: pageSize, start },
    })
    if (totalResults != null) {
      total = totalResults
    }
    const chunk = (text || '').trim()
    if (!chunk) {
      break
    }
    chunks.push(chunk)
    entryCount += (chunk.match(/^@\w+\s*\{/gm) || []).length
    start += pageSize
    if (total != null && start >= total) {
      break
    }
    if (start >= 2000) {
      break // 兜底，别把极端库拖太久
    }
  }

  return {
    bibtex: chunks.join('\n\n'),
    entryCount,
    truncated: total != null && start < total,
  }
}

/** 条目的子条目（附件 / note），用来找 PDF */
async function listChildren(credentials, itemKey) {
  const { json } = await request(
    credentials.apiKey,
    `${libraryPath(credentials)}/items/${itemKey}/children`,
    { query: { limit: 50 } }
  )
  return (json || []).map(child => {
    const data = child.data || {}
    return {
      key: child.key || data.key,
      itemType: data.itemType,
      title: data.title || data.filename || '',
      filename: data.filename || '',
      contentType: data.contentType || '',
      linkMode: data.linkMode || '',
      md5: data.md5 || null,
    }
  })
}

/** 选一个可下载的 PDF 附件（imported_file 才是 Zotero 存着的） */
function pickPdfAttachment(children) {
  const list = Array.isArray(children) ? children : []
  const pdfs = list.filter(
    child =>
      child &&
      child.itemType === 'attachment' &&
      (child.contentType === 'application/pdf' ||
        /\.pdf$/i.test(child.filename || ''))
  )
  if (!pdfs.length) {
    return null
  }
  // 优先 imported_file（Zotero 自己存的），linked_url 需要额外鉴权
  return pdfs.find(pdf => pdf.linkMode === 'imported_file') || pdfs[0]
}

/**
 * 下载附件文件本体。返回 { buffer, filename, contentType }。
 * 注意：需要 key 有 files 权限，且用户 Zotero 存储配额允许。
 */
async function downloadAttachment(credentials, attachmentKey) {
  const url = new URL(
    `${apiBaseUrl()}${libraryPath(credentials)}/items/${attachmentKey}/file`
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  let response
  try {
    response = await fetch(url, {
      headers: { 'Zotero-API-Key': credentials.apiKey },
      signal: controller.signal,
    })
  } catch (error) {
    throw new ZoteroApiError(
      error.name === 'AbortError'
        ? '下载 Zotero 附件超时（30s）'
        : `下载 Zotero 附件失败：${error.message}`,
      502
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new ZoteroApiError(
      response.status === 403
        ? 'Zotero 拒绝了附件下载：这把 Key 没有 files 权限，或该附件不在你的存储里'
        : `下载 Zotero 附件失败（${response.status}）：${text.slice(0, 200)}`,
      response.status === 403 ? 403 : 502
    )
  }

  const arrayBuffer = await response.arrayBuffer()
  const disposition = response.headers.get('content-disposition') || ''
  const filenameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(
    disposition
  )
  return {
    buffer: Buffer.from(arrayBuffer),
    filename: filenameMatch ? decodeURIComponent(filenameMatch[1]) : '',
    contentType: response.headers.get('content-type') || 'application/pdf',
  }
}

// ---------------- 用户侧凭据读写 ----------------

/**
 * 读取并解密当前用户的 Zotero 凭据；未绑定 / 解密失败都返回 null。
 */
async function getCredentials(userId) {
  const user = await User.findOne(
    { _id: userId },
    { 'refProviders.zotero': 1 }
  ).exec()
  const stored = user && user.refProviders && user.refProviders.zotero
  if (!stored) {
    return null
  }
  const apiKey = stored.encrypted
    ? Cipher.decrypt(stored.encrypted)
    : stored.apiKey || null // 兼容早期明文（不该出现，但别把用户锁死）
  if (!apiKey) {
    return null
  }
  return {
    apiKey,
    libraryType: stored.libraryType || 'user',
    libraryId: String(stored.libraryId || stored.userID || ''),
    username: stored.username || '',
    files: Boolean(stored.files),
    linkedAt: stored.linkedAt || null,
  }
}

async function saveCredentials(userId, { apiKey, keyInfo }) {
  const record = {
    encrypted: Cipher.encrypt(apiKey),
    libraryType: 'user',
    libraryId: String(keyInfo.userID),
    username: keyInfo.username || '',
    files: Boolean(keyInfo.files),
    linkedAt: new Date().toISOString(),
  }
  await User.updateOne(
    { _id: userId },
    { $set: { 'refProviders.zotero': record } }
  ).exec()
  return record
}

async function clearCredentials(userId) {
  await User.updateOne(
    { _id: userId },
    { $unset: { 'refProviders.zotero': 1 } }
  ).exec()
}

/** 供设置页展示：不返回明文 key */
function describeCredentials(credentials) {
  if (!credentials) {
    return null
  }
  return {
    username: credentials.username,
    libraryType: credentials.libraryType,
    libraryId: credentials.libraryId,
    files: credentials.files,
    linkedAt: credentials.linkedAt,
    apiKeyMasked: Cipher.maskKey(credentials.apiKey),
    apiUrl: apiBaseUrl(),
  }
}

module.exports = {
  ZoteroApiError,
  maxBibtexItems,
  verifyUserLibrary,
  exportBibtex,
  listChildren,
  pickPdfAttachment,
  downloadAttachment,
  getKeyInfo,
  listCollections,
  listItems,
  getItemBibtex,
  getItemsBibtex,
  getCredentials,
  saveCredentials,
  clearCredentials,
  describeCredentials,
  parseCitationKey,
  apiBaseUrl,
  // 供测试
  __test: { request, Settings },
}
