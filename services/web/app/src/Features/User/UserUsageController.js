const { ObjectId } = require('mongodb')
const logger = require('@overleaf/logger')
const { db } = require('../../infrastructure/mongodb')
const fs = require('fs').promises
const path = require('path')
const UserPagesController = require('./UserPagesController')
const { collectFileRefs } = require('./usageFileRefs')
// 附件大小是增值信息：filestore 客户端加载失败（少装依赖、路径改名）不应该
// 把整个 web 进程带下水，所以这里只降级，不抛
let FileStoreHandler = null
try {
  FileStoreHandler = require('../FileStore/FileStoreHandler')
} catch (err) {
  logger.warn(
    { err },
    '[usage] FileStoreHandler unavailable, attachment sizes disabled'
  )
}

const USER_DETAILS_PATH = path.join(
  __dirname,
  '../../../../scripts/users_detail.json'
)

// 用于缓存文件的写锁，防止并发写入冲突
const fileLocks = new Map()

/**
 * 获取文件写锁
 */
async function acquireLock(key, timeout = 5000) {
  if (!fileLocks.has(key)) {
    fileLocks.set(key, [])
  }

  return new Promise(resolve => {
    const locks = fileLocks.get(key)
    const unlock = () => {
      const index = locks.indexOf(unlock)
      if (index > -1) {
        locks.splice(index, 1)
      }
    }
    locks.push(unlock)

    // 等待轮到自己
    const checkTurn = () => {
      if (locks[0] === unlock) {
        resolve(unlock)
      } else {
        setTimeout(checkTurn, 10)
      }
    }
    checkTurn()
  })
}

/**
 * 更新用户详情缓存文件
 */
/**
 * @param {string} userEmail
 * @param {object} usage
 * @param {string|null} fallbackIp 仅在账号从未记录过登录 IP 时使用
 * @param {string|ObjectId} [userId] 有 _id 时按 _id 查：按 email 查可能命中
 *        同邮箱的历史重复账号，从而把「上次登录」显示成另一个人的记录
 */
async function updateUserDetailCache(
  userEmail,
  usage,
  fallbackIp = null,
  userId = null
) {
  try {
    const unlock = await acquireLock('users_detail.json')

    try {
      let userDetailsMap = {}

      // 读取现有缓存
      try {
        const data = await fs.readFile(USER_DETAILS_PATH, 'utf8')
        userDetailsMap = JSON.parse(data)
      } catch (err) {
        // 文件不存在或格式错误，从空开始
        logger.warn(
          '[UserUsageController] Cache file not found or invalid, starting fresh'
        )
      }

      // 获取用户信息（用于完整字段）；优先按 _id，避免命中同邮箱的旧账号
      const query =
        userId && ObjectId.isValid(userId)
          ? { _id: new ObjectId(userId) }
          : { email: userEmail }
      const user = await db.users.findOne(query)

      // 更新该用户的数据
      userDetailsMap[userEmail] = {
        userId: user?._id?.toString() || '',
        userName: user
          ? `${user.first_name || ''} ${user.last_name || ''}`.trim()
          : '',
        totalSize: usage.totalSize,
        totalSizeInMB: usage.totalSizeInMB,
        lastLogin: user ? formatDate(user.lastLoggedIn) : null,
        // 「最后登录 IP」就是登录那一刻的 IP，不是这次打开设置页的 IP：
        // 原来把请求 IP 写进这个字段，等于给一个标签贴了两个含义
        lastLoginIp: user?.lastLoginIp || fallbackIp || null,
        documentCount: usage.docCount,
        projectCount: usage.projectCount,
        tokens: usage.tokens || 0,
      }

      // 写回缓存文件
      await fs.writeFile(
        USER_DETAILS_PATH,
        JSON.stringify(userDetailsMap, null, 2)
      )
      logger.info(
        { userEmail },
        '[UserUsageController] ✓ Updated cache for user'
      )

      // 清除 UserPagesController 的内存缓存，强制重新加载最新数据
      UserPagesController.clearUserDetailsCacheForUser(userEmail)
      logger.debug(
        { userEmail },
        '[UserUsageController] Cleared in-memory cache for user'
      )
    } finally {
      unlock()
    }
  } catch (err) {
    logger.error(
      { userEmail, err },
      '[UserUsageController] Failed to update cache file'
    )
    // 不要因为缓存更新失败而中断请求
  }
}

/**
 * 格式化日期为 YYYY-MM-DD HH:MM:SS
 */
function formatDate(date) {
  if (!date) return null
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

/**
 * 磁盘用量统计
 *
 * 口径（页面上要写清楚，否则用户只能凭感觉）：
 *   - 文本框：docs.lines 各行的 UTF-8 字节数
 *   - 附件：filestore 里文件的真实长度
 *   - 不含历史版本（project_history / docstore 里的快照），不含 PDF 编译产物
 *
 * 历史坑：这里原来读 fileRef.size，而 File 模型里**没有 size 字段**
 * （见 app/src/models/File.js），于是所有附件都算成 0 字节。用户传了几十张
 * 图、一堆 PDF，页面显示还是 2.87 MB。真实长度只能问 filestore。
 */

const FILE_SIZE_CACHE_TTL_MS = 10 * 60 * 1000
const FILE_SIZE_CONCURRENCY = 8
// `${projectId}:${fileId}:${rev}` -> { size, at }
const fileSizeCache = new Map()

function headFileSize(projectId, fileId) {
  return new Promise(resolve => {
    if (!FileStoreHandler) {
      return resolve(null)
    }
    FileStoreHandler.getFileSize(projectId, fileId, (err, size) => {
      if (err) {
        logger.debug(
          { err, projectId, fileId },
          '[usage] cannot read file size'
        )
        return resolve(null)
      }
      const bytes = parseInt(size, 10)
      resolve(Number.isFinite(bytes) ? bytes : null)
    })
  })
}

async function cachedFileSize(projectId, fileRef) {
  const key = `${projectId}:${fileRef._id}:${fileRef.rev || 0}`
  const hit = fileSizeCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < FILE_SIZE_CACHE_TTL_MS) {
    return hit.size
  }
  const size = await headFileSize(projectId, fileRef._id)
  // 读不到（filestore 挂了/文件被删）就不要缓存，下次还会重试
  if (size != null) {
    fileSizeCache.set(key, { size, at: now })
    if (fileSizeCache.size > 20000) fileSizeCache.clear()
  }
  // null 与"0 字节"必须分开：前者说明 filestore 没答上来，
  // 把它当 0 就是又一次"看起来正常但数字是假的"
  return size == null ? null : size
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (next < items.length) {
        const index = next++
        out[index] = await fn(items[index], index)
      }
    })
  await Promise.all(workers)
  return out
}

async function sumFileSizes(projectId, rootFolder) {
  const files = collectFileRefs(rootFolder)
  if (files.length === 0) return { size: 0, count: 0, failed: 0 }
  const sizes = await mapLimit(files, FILE_SIZE_CONCURRENCY, file =>
    // 链接进来的文件（URL / github 等）只存了一个指针，本来就没有字节
    file.linkedFileData ? 0 : cachedFileSize(projectId, file)
  )
  let size = 0
  let failed = 0
  for (const bytes of sizes) {
    if (bytes == null) failed++
    else size += bytes
  }
  return { size, count: files.length, failed }
}

/**
 * 文本字节数：一次聚合拿全部项目，避免每个项目一次 aggregate。
 */
async function textSizesByProject(projectIds) {
  if (projectIds.length === 0) return new Map()
  const rows = await db.docs
    .aggregate([
      {
        $match: {
          project_id: { $in: projectIds },
          deleted: { $ne: true },
        },
      },
      {
        $project: {
          project_id: 1,
          size: {
            $reduce: {
              input: { $ifNull: ['$lines', []] },
              initialValue: 0,
              in: {
                $add: [
                  '$$value',
                  { $strLenBytes: { $ifNull: ['$$this', ''] } },
                ],
              },
            },
          },
        },
      },
      {
        $group: {
          _id: '$project_id',
          size: { $sum: '$size' },
          docs: { $sum: 1 },
        },
      },
    ])
    .toArray()
  return new Map(rows.map(row => [row._id.toString(), row]))
}

const toMB = bytes => parseFloat((bytes / 1024 / 1024).toFixed(2))

/**
 * 计算单个项目的磁盘用量
 * @param {ObjectId} projectId 项目ID
 * @returns {Promise<number>} 项目总大小（字节）
 */
async function calculateProjectSize(projectId) {
  try {
    const projectObjId = ObjectId.isValid(projectId)
      ? ObjectId(projectId)
      : projectId
    const project = await db.projects.findOne(
      { _id: projectObjId },
      { projection: { rootFolder: 1 } }
    )
    const textSizes = await textSizesByProject([projectObjId])
    const textSize = textSizes.get(projectObjId.toString())?.size || 0
    const { size: fileSize } = await sumFileSizes(
      projectObjId,
      project?.rootFolder
    )
    return textSize + fileSize
  } catch (err) {
    logger.error(
      { projectId, err },
      '[UserUsageController] Error calculating project size'
    )
    return 0
  }
}

/**
 * 计算用户的总磁盘用量
 * @param {ObjectId} userId 用户ID
 */
async function calculateUserUsage(userId) {
  try {
    const userObjId = ObjectId.isValid(userId) ? ObjectId(userId) : userId

    // 自己拥有的 + 参与协作的，一次查完（原来查两次再按 _id 去重）
    const projects = await db.projects
      .find(
        {
          $and: [
            { $or: [{ owner_ref: userObjId }, { collab_refs: userObjId }] },
            { deletedByExternalDataSource: { $ne: true } },
          ],
        },
        // rootFolder 里同时嵌着 docs（正文）与 fileRefs。这里只用到 fileRefs，
        // 但 Mongo 无法只投影数组里的某个字段，所以整棵树都会读上来——好处是
        // 一次查询拿到全部项目结构，坏处是账号越大越占内存。
        { projection: { rootFolder: 1, trashed: 1 } }
      )
      .toArray()

    const textSizes = await textSizesByProject(projects.map(p => p._id))

    const active = []
    const trashed = []
    for (const project of projects) {
      const isTrashed = Array.isArray(project.trashed)
        ? project.trashed.some(id => id.toString() === userObjId.toString())
        : false
      const docStat = textSizes.get(project._id.toString())
      const entry = {
        id: project._id,
        rootFolder: project.rootFolder,
        textSize: docStat?.size || 0,
        docs: docStat?.docs || 0,
      }
      ;(isTrashed ? trashed : active).push(entry)
    }

    // 附件大小要问 filestore：回收站里的项目同样占磁盘，所以一起算进总量
    let textSize = 0
    let fileSize = 0
    let fileCount = 0
    let fileSizeFailedCount = 0
    let docCount = 0
    let trashedSize = 0
    let trashedDocCount = 0

    for (const entry of active) {
      const files = await sumFileSizes(entry.id, entry.rootFolder)
      textSize += entry.textSize
      fileSize += files.size
      fileCount += files.count
      fileSizeFailedCount += files.failed
      docCount += entry.docs
    }
    for (const entry of trashed) {
      const files = await sumFileSizes(entry.id, entry.rootFolder)
      textSize += entry.textSize
      fileSize += files.size
      fileCount += files.count
      fileSizeFailedCount += files.failed
      trashedSize += entry.textSize + files.size
      trashedDocCount += entry.docs
    }

    const totalSize = textSize + fileSize

    return {
      totalSize,
      totalSizeInMB: toMB(totalSize),
      // 分类明细：页面要说清楚「2.87 MB 是什么」，否则只能被当成错了
      textSize,
      textSizeInMB: toMB(textSize),
      fileSize,
      fileSizeInMB: toMB(fileSize),
      fileCount,
      // >0 表示有附件没问到长度（filestore 不可达 / 文件已丢），页面要说明白
      fileSizeFailedCount,
      projectCount: active.length,
      docCount,
      trashedProjectCount: trashed.length,
      trashedDocCount,
      trashedSize,
      trashedSizeInMB: toMB(trashedSize),
      updatedAt: new Date(),
    }
  } catch (err) {
    logger.error(
      { userId, err },
      '[UserUsageController] Error calculating user usage'
    )
    throw err
  }
}

/**
 * API 端点：获取当前用户的磁盘用量
 */
async function getUserUsage(req, res) {
  try {
    const userId = req.user?._id || req.session?.user?._id

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      })
    }

    // 获取用户信息（获取邮箱用于更新缓存）
    const user = await db.users.findOne({ _id: new ObjectId(userId) })
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      })
    }

    const usage = await calculateUserUsage(userId)

    // 同步更新缓存（等待完成后再返回）
    const requestIp =
      req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip
    try {
      await updateUserDetailCache(user.email, usage, requestIp, userId)
      logger.info(
        { userId, userEmail: user.email },
        '[UserUsageController] ✓ Cache updated and cleared'
      )
    } catch (err) {
      logger.error(
        { userId, userEmail: user.email, err },
        '[UserUsageController] Failed to update cache'
      )
      // 继续返回数据，不要因为缓存更新失败而影响 API
    }

    res.json({
      success: true,
      data: usage,
      cacheUpdated: true, // 标记缓存已更新
    })
  } catch (err) {
    logger.error(
      { userId: req.user?._id, err },
      '[UserUsageController] GET /api/user/usage failed'
    )
    res.status(500).json({
      success: false,
      message: 'Failed to calculate user usage',
    })
  }
}

/**
 * API 端点：获取指定用户的磁盘用量（仅管理员）
 */
async function getUserUsageAdmin(req, res) {
  try {
    const { userId } = req.params

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID',
      })
    }

    const usage = await calculateUserUsage(userId)

    res.json({
      success: true,
      data: usage,
    })
  } catch (err) {
    logger.error(
      { userId: req.params.userId, err },
      '[UserUsageController] GET /api/admin/user/:userId/usage failed'
    )
    res.status(500).json({
      success: false,
      message: 'Failed to calculate user usage',
    })
  }
}

module.exports = {
  calculateProjectSize,
  calculateUserUsage,
  getUserUsage,
  getUserUsageAdmin,
}
