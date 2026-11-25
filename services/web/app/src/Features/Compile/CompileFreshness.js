const crypto = require('crypto')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const RedisWrapper = require('../../infrastructure/RedisWrapper')

/**
 * FIXED: 2026-11-08 编译「新鲜度」指纹（阶段 ① + ②，暂不改变任何编译行为）
 *
 * 背景：前端每次打开项目都会无条件发一次 compile
 * （local-compile-context.jsx「always compile the PDF once after opening the project」），
 * 而 CLSI 每次编译前都会删掉 output.pdf、并重写所有打开的 doc
 * （ResourceWriter 的 _removeExtraneousFiles / saveIncrementalResourcesToDisk），
 * 于是 latexmk 每次都得真跑 2~3 遍 —— 什么都没改也照样烧 CPU。
 *
 * 这里做的事：
 *   ① 每次编译成功后，把「这次编译的输入指纹」记进 Redis；
 *   ② 提供一个廉价的 GET 接口，重算当前指纹并对比，告诉调用方
 *      “内容跟上次成功编译时一模一样”。
 *
 * 指纹 = 这次发给 CLSI 的请求本身：
 *   · optionsKey  —— 编译器 / draft / stopOnFirstError / check / flags / 根文件 / 镜像
 *                     （任何一个变了，产物就可能不同）
 *   · stateHash   —— ClsiStateManager 的项目结构 hash（文件增删改名、上传文件 rev）
 *   · resources   —— 每个资源的内容摘要：doc 用内容 sha1，上传文件用 url+modified
 *
 * 采用「子集匹配」而不是「集合相等」：
 *   编译时的请求里可能包含当时打开着的所有 doc，而检查时（刚打开项目）redis 里
 *   可能只有根文档。只要当前请求里的每个资源都与记录一致，就说明要送去编译的
 *   内容没变；反过来“记录里有、当前没有”是安全的（那些 doc 没被改过，磁盘上还是
 *   上次编译时的样子）。
 *
 * 阶段 ③（前端据此跳过编译）尚未接线，所以本模块现在只写 Redis + 打日志，
 * 不改变任何既有行为。
 */

const KEY_PREFIX = 'clsiCompileFreshness'
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 天
const VERSION = 1

const rclient = RedisWrapper.client('clsi_compile_freshness')

function buildKey(projectId) {
  // 按项目存，不按用户：同一个项目的内容对谁编译来说都一样，
  // 而 AI / 脚本直写 Mongo 后需要一次 DEL 就能让所有人的指纹失效。
  // 用户个性的差异（draft / 编译器 / 停止策略）都进了 optionsKey，不影响正确性。
  return `${KEY_PREFIX}:${projectId}`
}

function sha1(input) {
  return crypto.createHash('sha1').update(String(input), 'utf8').digest('hex')
}

/**
 * 从发给 CLSI 的请求里抽取指纹。
 * 只取“会影响产物”的字段，避免 timeout / compileGroup / syncState 之类的
 * 每次都可能变化的量把指纹搅乱。
 */
function collectFingerprint(req) {
  const compile = (req && req.compile) || {}
  const options = compile.options || {}

  const optionsKey = [
    `root:${compile.rootResourcePath}`,
    `compiler:${options.compiler}`,
    `draft:${Boolean(options.draft)}`,
    `stopOnFirstError:${Boolean(options.stopOnFirstError)}`,
    `check:${options.check}`,
    `flags:${JSON.stringify(options.flags || null)}`,
    `image:${options.imageName}`,
  ].join('|')

  const resources = {}
  for (const resource of compile.resources || []) {
    if (resource.content != null) {
      resources[resource.path] = `doc:${sha1(resource.content)}`
    } else if (resource.url) {
      resources[resource.path] = `file:${resource.url}:${
        resource.modified || ''
      }`
    }
  }

  return { optionsKey, resources }
}

function ttlSeconds() {
  const configured = Settings.compileFreshness?.ttlSeconds
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TTL_SECONDS
}

function setexAsync(key, ttl, value) {
  return new Promise((resolve, reject) => {
    rclient.setex(key, ttl, value, (err, result) =>
      err ? reject(err) : resolve(result)
    )
  })
}

function getAsync(key) {
  return new Promise((resolve, reject) => {
    rclient.get(key, (err, result) => (err ? reject(err) : resolve(result)))
  })
}

/**
 * ① 编译成功后记录指纹。调用方不需要 await，失败只打日志。
 */
function compactResult(result) {
  // FIXED: 2026-11-08 只留「把上次 PDF 重新呈现给用户」所必需的东西。
  // 存下来之后，服务端可以完全不发编译请求就把上次的结果原样返回，
  // 前端不需要额外接口、也不需要自己拼产物地址。
  if (!result || result.status !== 'success') return null
  const outputFiles = (result.outputFiles || []).map(file => ({
    path: file.path,
    url: file.url,
    type: file.type,
    build: file.build || null,
  }))
  if (!outputFiles.length) return null
  return {
    status: 'success',
    outputFiles,
    clsiServerId: result.clsiServerId || null,
    outputUrlPrefix: result.outputUrlPrefix || null,
    compileGroup: result.limits?.compileGroup || null,
  }
}

async function record({ projectId, userId, req, stateHash, result }) {
  try {
    if (!projectId || !req || !stateHash) return
    const { optionsKey, resources } = collectFingerprint(req)
    const payload = JSON.stringify({
      v: VERSION,
      stateHash,
      optionsKey,
      resources,
      result: compactResult(result),
      at: Date.now(),
      lastUserId: userId || null,
    })
    await setexAsync(buildKey(projectId), ttlSeconds(), payload)
    // 用 info 而不是 debug：阶段 ② 要靠这条日志观察命中率（编译日志本身是 debug）
    logger.info(
      {
        projectId,
        userId,
        resources: Object.keys(resources).length,
      },
      '[compile-freshness] recorded'
    )
  } catch (err) {
    // 记录失败不能影响编译结果
    logger.warn(
      { err, projectId, userId },
      '[compile-freshness] failed to record fingerprint'
    )
  }
}

/**
 * ② 对比指纹。任何异常都返回 fresh:false（宁可多编一次，也不能给错结论）。
 */
async function check({ projectId, userId, req, stateHash }) {
  const startedAt = Date.now()
  const result = await checkInner({ projectId, userId, req, stateHash })
  logger.info(
    {
      projectId,
      userId,
      fresh: result.fresh,
      reason: result.reason,
      recordedAt: result.recordedAt,
      ms: Date.now() - startedAt,
      // 只有不一致时才有这几个字段（见 checkInner）
      storedOptionsKey: result.storedOptionsKey,
      optionsKey: result.optionsKey,
      storedStateHash: result.storedStateHash,
      stateHash: result.stateHash,
    },
    '[compile-freshness] check'
  )
  return result
}

async function checkInner({ projectId, userId, req, stateHash }) {
  try {
    const raw = await getAsync(buildKey(projectId))
    if (!raw) {
      return { fresh: false, reason: 'no-record' }
    }

    let stored
    try {
      stored = JSON.parse(raw)
    } catch (err) {
      return { fresh: false, reason: 'bad-record' }
    }
    if (!stored || stored.v !== VERSION) {
      return { fresh: false, reason: 'record-version-mismatch' }
    }

    const { optionsKey, resources } = collectFingerprint(req)

    // FIXED: 2026-11-08 不匹配时把「记录值 vs 当前值」一起带出去，
    // 这样线上只看一行日志就能知道到底是哪个字段变了，不用再猜。
    if (stored.optionsKey !== optionsKey) {
      return {
        fresh: false,
        reason: 'options-changed',
        recordedAt: stored.at,
        storedOptionsKey: stored.optionsKey,
        optionsKey,
      }
    }
    if (stored.stateHash !== stateHash) {
      return {
        fresh: false,
        reason: 'structure-changed',
        recordedAt: stored.at,
        storedStateHash: stored.stateHash,
        stateHash,
      }
    }

    for (const [path, digest] of Object.entries(resources)) {
      if (stored.resources[path] !== digest) {
        return {
          fresh: false,
          reason: `content-changed:${path}`,
          recordedAt: stored.at,
          storedDigest: stored.resources[path],
          digest,
        }
      }
    }

    return {
      fresh: true,
      reason: 'match',
      recordedAt: stored.at,
      checkedResources: Object.keys(resources).length,
    }
  } catch (err) {
    logger.warn(
      { err, projectId, userId },
      '[compile-freshness] failed to check fingerprint'
    )
    return { fresh: false, reason: 'error', message: err.message }
  }
}

/**
 * FIXED: 2026-11-08 服务端兜底：POST /compile 进来时先问一句
 * 「内容跟上次成功编译一样吗？产物还在吗？」
 * 是的话直接把上次的结果原样返回，一次编译都不发。
 *
 * 为什么放在服务端而不是前端：
 *   · 前端老 bundle（没重新 webpack）也能立刻生效，不依赖前端部署；
 *   · 不需要浏览器自己去 HEAD 产物地址，少一个必错点；
 *   · 判断只有一个出处，出问题只有一个地方要看。
 *
 * 返回 { skip: true, result } 或 { skip: false, reason }。任何异常都 skip:false。
 */
async function reuse({ projectId, userId, req, stateHash }) {
  const checked = await check({ projectId, userId, req, stateHash })
  if (!checked.fresh) {
    return { skip: false, reason: checked.reason }
  }
  const stored = await readRecord(projectId)
  const result = stored && stored.result
  if (!result) {
    return { skip: false, reason: 'no-result-recorded' }
  }
  const alive = await outputFilesStillAvailable(
    projectId,
    userId,
    result.outputFiles,
    result.compileGroup,
    result.clsiServerId
  )
  if (!alive) {
    return { skip: false, reason: 'output-missing' }
  }
  logger.info(
    { projectId, userId, recordedAt: stored.at },
    '[compile-freshness] skipped compile, reusing last result'
  )
  return { skip: true, result, recordedAt: stored.at || null }
}

async function readRecord(projectId) {
  try {
    const raw = await getAsync(buildKey(projectId))
    return raw ? JSON.parse(raw) : null
  } catch (err) {
    return null
  }
}

/**
 * 产物可能被 CLSI 的输出缓存清掉了（按 build 分目录，有 TTL）。
 * 用一次 HEAD 确认，确认不了就当不可复用 —— 宁可多编一次。
 */
async function outputFilesStillAvailable(
  projectId,
  userId,
  outputFiles,
  compileGroup,
  clsiServerId
) {
  const pdf =
    (outputFiles || []).find(file => file.type === 'pdf') ||
    (outputFiles || [])[0]
  if (!pdf || !pdf.url) return false
  if (typeof fetch !== 'function') {
    // 老 node 没有全局 fetch：验证不了就当作不可复用（安全方向）
    return false
  }
  try {
    const url = new URL(`${Settings.apis.clsi.url}${pdf.url}`)
    if (compileGroup) url.searchParams.set('compileGroup', compileGroup)
    if (clsiServerId) url.searchParams.set('clsiserverid', clsiServerId)
    const signal =
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(2500)
        : undefined
    const res = await fetch(url, { method: 'HEAD', signal })
    return res.ok
  } catch (err) {
    logger.warn(
      { err, projectId, userId },
      '[compile-freshness] failed to verify last output files'
    )
    return false
  }
}

/**
 * 项目内容被绕过 docupdater 改动（例如 AI 直接写 MongoDB）时，
 * 指纹就不可信了，必须显式失效。
 */
async function invalidate(projectId) {
  try {
    await new Promise((resolve, reject) => {
      rclient.del(buildKey(projectId), err => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    logger.warn(
      { err, projectId },
      '[compile-freshness] failed to invalidate fingerprint'
    )
  }
}

module.exports = {
  buildKey,
  collectFingerprint,
  record,
  reuse,
  check,
  invalidate,
}
