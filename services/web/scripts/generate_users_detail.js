const { MongoClient, ObjectId } = require('mongodb')
const Settings = require('@overleaf/settings')
const fs = require('fs').promises
const path = require('path')

// MongoDB 连接配置
const mongoUrl = Settings.mongo.url
const dbName = Settings.mongo.db || 'sharelatex'
let db

// 输出文件路径
const OUTPUT_FILE = path.join(__dirname, 'users_detail.json')

// 格式化日期函数
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

// 初始化数据库连接
async function initDb() {
  if (!db) {
    const client = await MongoClient.connect(mongoUrl)
    db = client.db(dbName)
  }
  return db
}

async function calculateProjectSize(projectId) {
  try {
    const db = await initDb()
    const projectObjId = typeof projectId === 'string' ? ObjectId(projectId) : projectId

    // 1. 文档大小计算 (从 docs 集合)
    const docSizeResults = await db.collection('docs').aggregate([
      {
        $match: {
          project_id: projectObjId,
          deleted: { $ne: true }
        }
      },
      {
        $project: {
          size: {
            $reduce: {
              input: '$lines',
              initialValue: 0,
              in: {
                $add: [
                  '$$value',
                  { $strLenBytes: { $ifNull: ['$$this', ''] } }
                ]
              }
            }
          }
        }
      },
      {
        $group: {
          _id: null,
          totalSize: { $sum: '$size' }
        }
      }
    ]).toArray()

    const docSize = docSizeResults[0]?.totalSize || 0

    // 2. 文件大小计算 (从 projects 集合的 rootFolder)
    const project = await db.collection('projects').findOne({ 
      _id: projectObjId 
    })

    let fileSize = 0
    if (project?.rootFolder) {
      const processFolder = (folder) => {
        if (folder.fileRefs && Array.isArray(folder.fileRefs)) {
          folder.fileRefs.forEach(file => {
            // 确保 file.size 存在且是数字
            const size = parseInt(file.size, 10)
            if (!isNaN(size) && size > 0) {
              fileSize += size
            }
          })
        }
        if (folder.folders && Array.isArray(folder.folders)) {
          folder.folders.forEach(processFolder)
        }
      }
      processFolder(project.rootFolder)
    }

    // 3. 从 docstore 获取 docs 大小 (某些部署方式独立存储)
    let docstoreSize = 0
    try {
      const docstoreDocs = await db.collection('docstore.docs').find({
        project_id: projectObjId
      }).toArray()

      if (docstoreDocs && docstoreDocs.length > 0) {
        docstoreDocs.forEach(doc => {
          if (doc.lines && Array.isArray(doc.lines)) {
            docstoreSize += doc.lines.reduce((size, line) => {
              if (line) {
                return size + Buffer.byteLength(line, 'utf8')
              }
              return size
            }, 0)
          }
        })
      }
    } catch (err) {
      // docstore.docs 集合可能不存在，忽略错误
      console.warn(`Warning: Could not read docstore for project ${projectId}: ${err.message}`)
    }

    const totalSize = docSize + docstoreSize + fileSize
    
    if (totalSize > 0) {
      console.log(`[calculateProjectSize] Project ${projectId}: docs=${docSize}B + docstore=${docstoreSize}B + files=${fileSize}B = ${totalSize}B (${(totalSize / 1024 / 1024).toFixed(2)}MB)`)
    }

    return totalSize
  } catch (err) {
    console.error(`Error calculating size for project ${projectId}:`, err.message)
    return 0
  }
}


async function getUserDetails() {
  try {
    const db = await initDb()
    const users = await db.collection('users').find({}).toArray()
    const userDetailsMap = {}

    console.log(`Processing ${users.length} users...`)

    for (const user of users) {
      const email = user.email
      if (!email) continue

      // 获取用户的所有项目 (owned 和 shared)
      const ownedProjects = await db.collection('projects').find({
        owner_ref: user._id
      }).toArray()

      const sharedProjects = await db.collection('projects').find({
        collab_refs: user._id
      }).toArray()

      const allProjects = [...ownedProjects, ...sharedProjects]

      // 计算总文档数
      const docCount = await db.collection('docs').countDocuments({
        project_id: { $in: allProjects.map(p => p._id) },
        deleted: { $ne: true }
      })

      // 计算总存储大小
      let totalSize = 0
      for (const project of allProjects) {
        const projectSize = await calculateProjectSize(project._id)
        totalSize += projectSize
      }

      const totalSizeInMB = (totalSize / 1024 / 1024).toFixed(2)

      userDetailsMap[email] = {
        userId: user._id.toString(),
        userName: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
        totalSize: totalSize,  // 字节数
        totalSizeInMB: totalSizeInMB,  // MB
        lastLogin: formatDate(user.lastLoggedIn),
        lastLoginIp: user.lastLoginIp || null,
        documentCount: docCount,
        projectCount: allProjects.length,
        tokens: 0
      }

      console.log(`✓ ${email}: ${totalSizeInMB} MB (${allProjects.length} projects, ${docCount} docs)`)
    }

    return userDetailsMap
  } catch (err) {
    console.error('Error in getUserDetails:', err)
    return {}
  }
}


// 如果直接运行脚本
if (require.main === module) {
  getUserDetails()
    .then(async (userDetails) => {
      await fs.writeFile(OUTPUT_FILE, JSON.stringify(userDetails, null, 2))
      process.exit(0)
    })
    .catch(() => process.exit(1))
}

// 导出函数供其他模块使用
module.exports = {
  getUserDetails,
  async readUserDetails() {
    try {
      const data = await fs.readFile(OUTPUT_FILE, 'utf8')
      return JSON.parse(data)
    } catch (err) {
      return null
    }
  }
}
