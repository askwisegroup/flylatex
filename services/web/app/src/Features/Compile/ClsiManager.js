const { callbackify } = require('util')
const { callbackifyMultiResult } = require('@overleaf/promise-utils')
const {
  fetchString,
  fetchStringWithResponse,
  fetchStream,
  RequestFailedError,
} = require('@overleaf/fetch-utils')
const Settings = require('@overleaf/settings')
const ProjectGetter = require('../Project/ProjectGetter')
const ProjectEntityHandler = require('../Project/ProjectEntityHandler')
const logger = require('@overleaf/logger')
const OError = require('@overleaf/o-error')
const { Cookie } = require('tough-cookie')
const ClsiCookieManager = require('./ClsiCookieManager')(
  Settings.apis.clsi?.backendGroupName
)
const NewBackendCloudClsiCookieManager = require('./ClsiCookieManager')(
  Settings.apis.clsi_new?.backendGroupName
)
const ClsiStateManager = require('./ClsiStateManager')
const CompileFreshness = require('./CompileFreshness')
const _ = require('underscore')
const ClsiFormatChecker = require('./ClsiFormatChecker')
const DocumentUpdaterHandler = require('../DocumentUpdater/DocumentUpdaterHandler')
const Metrics = require('@overleaf/metrics')
const Errors = require('../Errors/Errors')

const VALID_COMPILERS = ['pdflatex', 'latex', 'xelatex', 'lualatex']

// FIXED: 2026-11-08 请求对象 → 构建它时的项目结构 hash（供编译新鲜度指纹使用）。
// 用 WeakMap 而不是把字段挂到 req 上，避免多出来的字段被发到 CLSI。
const requestStateHashes = new WeakMap()
const OUTPUT_FILE_TIMEOUT_MS = 60000
const CLSI_COOKIES_ENABLED = (Settings.clsiCookie?.key ?? '') !== ''

// The timeout in services/clsi/app.js is 14 minutes, so we'll be on the safe side with 13 minutes.
// FIXED: 2026-11 CLSI 侧加了编译队列（排队等待上限 90s 计入同一个 HTTP 请求），
//   最坏情况 = 90s 排队 + 600s 编译 + 文件下载，12 分钟会不够，改成 13 分钟，
//   仍小于服务端的 14 分钟（客户端先超时，能拿到可读的错误）。
const COMPILE_REQUEST_TIMEOUT_MS =
  parseInt(process.env.WEB_COMPILE_REQUEST_TIMEOUT_MS, 10) || 13 * 60 * 1000

function collectMetricsOnBlgFiles(outputFiles) {
  let topLevel = 0
  let nested = 0
  for (const outputFile of outputFiles) {
    if (outputFile.type === 'blg') {
      if (outputFile.path.includes('/')) {
        nested++
      } else {
        topLevel++
      }
    }
  }
  Metrics.count('blg_output_file', topLevel, 1, { path: 'top-level' })
  Metrics.count('blg_output_file', nested, 1, { path: 'nested' })
}

async function sendRequest(projectId, userId, options) {
  if (options == null) {
    options = {}
  }
  let result = await sendRequestOnce(projectId, userId, options)
  if (result.status === 'conflict') {
    // Try again, with a full compile
    result = await sendRequestOnce(projectId, userId, {
      ...options,
      syncType: 'full',
    })
  } else if (result.status === 'unavailable') {
    // FIXED: 2026-11-11 overloaded 不进这个分支（见下方判断）。
    result = await sendRequestOnce(projectId, userId, {
      ...options,
      syncType: 'full',
      forceNewClsiServer: true,
    })
  }
  return result
}

// FIXED: 2026-11-11 从 CLSI 的 503 响应体里读出「是不是并发满载」。
// err.body 是原始文本（fetch-utils 走 response.text()），格式不确定时必须
// 优雅降级：解析失败一律当成真不可用，绝不能因为 parse 抛错把编译搞成 500。
function parseOverloadStatus(body) {
  if (typeof body !== 'string' || !body) {
    return 'unavailable'
  }
  try {
    const parsed = JSON.parse(body)
    if (parsed?.compile?.status === 'overloaded') {
      return 'overloaded'
    }
  } catch (err) {
    // 不是 JSON（网关返回的 HTML 错误页等），保持 unavailable
  }
  return 'unavailable'
}

async function sendRequestOnce(projectId, userId, options) {
  let req
  try {
    req = await _buildRequest(projectId, options)
  } catch (err) {
    if (err.message === 'no main file specified') {
      return {
        status: 'validation-problems',
        validationProblems: { mainFile: err.message },
      }
    } else {
      throw OError.tag(err, 'Could not build request to CLSI', {
        projectId,
        options,
      })
    }
  }
  // FIXED: 2026-11-08 编译成功后记录「输入指纹」，供 GET /compile/fresh 对比。
  // 只记 success：失败/超时的构建不能用来证明“内容没变就不用编”。
  const result = await _sendBuiltRequest(projectId, userId, req, options)
  if (result && result.status === 'success') {
    const stateHash = requestStateHashes.get(req)
    if (stateHash) {
      // 故意不 await：一次 Redis SETEX 不能拖慢/影响编译响应的返回
      // FIXED: 2026-11-08 连产物信息一起记下来，服务端才能“原样返回上次结果”
      CompileFreshness.record({
        projectId,
        userId,
        req,
        stateHash,
        result,
      }).catch(() => {})
    }
  }
  return result
}

/**
 * FIXED: 2026-11-08 供“新鲜度检查”使用：只构建要发给 CLSI 的请求 + 结构 hash，
 * 不发任何编译请求。这就是“上次编译时会送什么”与“现在会送什么”的对比基础。
 */
async function buildRequestForFreshnessCheck(projectId, options = {}) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    compiler: 1,
    rootDoc_id: 1,
    imageName: 1,
    rootFolder: 1,
  })
  if (project == null) {
    throw new Errors.NotFoundError(`project does not exist: ${projectId}`)
  }
  if (!VALID_COMPILERS.includes(project.compiler)) {
    project.compiler = 'pdflatex'
  }
  // 先算结构 hash（与编译成功后记录时用的完全同一函数，不含 options）
  const stateHash = ClsiStateManager.computeStructureHash(project)
  const req = await _buildRequest(projectId, options, project)
  return { req, stateHash }
}

// for public API requests where there is no project id
async function sendExternalRequest(submissionId, clsiRequest, options) {
  if (options == null) {
    options = {}
  }
  return await _sendBuiltRequest(submissionId, null, clsiRequest, options)
}

async function stopCompile(projectId, userId, options) {
  if (options == null) {
    options = {}
  }
  const { compileBackendClass, compileGroup } = options
  const url = _getCompilerUrl(
    compileBackendClass,
    compileGroup,
    projectId,
    userId,
    'compile/stop'
  )
  const opts = { method: 'POST' }
  await _makeRequest(
    projectId,
    userId,
    compileGroup,
    compileBackendClass,
    url,
    opts
  )
}

async function deleteAuxFiles(projectId, userId, options, clsiserverid) {
  if (options == null) {
    options = {}
  }
  const { compileBackendClass, compileGroup } = options
  const url = _getCompilerUrl(
    compileBackendClass,
    compileGroup,
    projectId,
    userId
  )
  const opts = {
    method: 'DELETE',
  }

  try {
    await _makeRequestWithClsiServerId(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      url,
      opts,
      clsiserverid
    )
  } finally {
    // always clear the project state from the docupdater, even if there
    // was a problem with the request to the clsi
    try {
      await DocumentUpdaterHandler.promises.clearProjectState(projectId)
    } finally {
      await ClsiCookieManager.promises.clearServerId(projectId, userId)
    }
  }
}

async function _sendBuiltRequest(projectId, userId, req, options, callback) {
  if (options.forceNewClsiServer) {
    await ClsiCookieManager.promises.clearServerId(projectId, userId)
  }
  const validationProblems =
    await ClsiFormatChecker.promises.checkRecoursesForProblems(
      req.compile?.resources
    )
  if (validationProblems != null) {
    logger.debug(
      { projectId, validationProblems },
      'problems with users latex before compile was attempted'
    )
    return {
      status: 'validation-problems',
      validationProblems,
    }
  }

  const { response, clsiServerId } = await _postToClsi(
    projectId,
    userId,
    req,
    options.compileBackendClass,
    options.compileGroup
  )

  const outputFiles = _parseOutputFiles(
    projectId,
    response && response.compile && response.compile.outputFiles
  )
  collectMetricsOnBlgFiles(outputFiles)
  const compile = response?.compile || {}
  return {
    status: compile.status,
    outputFiles,
    clsiServerId,
    stats: compile.stats,
    timings: compile.timings,
    outputUrlPrefix: compile.outputUrlPrefix,
  }
}

async function _makeRequestWithClsiServerId(
  projectId,
  userId,
  compileGroup,
  compileBackendClass,
  url,
  opts,
  clsiserverid
) {
  if (clsiserverid) {
    // ignore cookies and newBackend, go straight to the clsi node
    url.searchParams.set('compileGroup', compileGroup)
    url.searchParams.set('compileBackendClass', compileBackendClass)
    url.searchParams.set('clsiserverid', clsiserverid)

    let body
    try {
      body = await fetchString(url, opts)
    } catch (err) {
      throw OError.tag(err, 'error making request to CLSI', {
        userId,
        projectId,
      })
    }

    let json
    try {
      json = JSON.parse(body)
    } catch (err) {
      // some responses are empty. Ignore JSON parsing errors.
    }

    return { body: json }
  } else {
    return await _makeRequest(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      url,
      opts
    )
  }
}

async function _makeRequest(
  projectId,
  userId,
  compileGroup,
  compileBackendClass,
  url,
  opts
) {
  const currentBackendStartTime = new Date()
  const clsiServerId = await ClsiCookieManager.promises.getServerId(
    projectId,
    userId,
    compileGroup,
    compileBackendClass
  )
  opts.headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  if (CLSI_COOKIES_ENABLED) {
    const cookie = new Cookie({
      key: Settings.clsiCookie.key,
      value: clsiServerId,
    })
    opts.headers.Cookie = cookie.cookieString()
  }

  const timer = new Metrics.Timer('compile.currentBackend')

  let response, body
  try {
    ;({ body, response } = await fetchStringWithResponse(url, opts))
  } catch (err) {
    throw OError.tag(err, 'error making request to CLSI', {
      projectId,
      userId,
    })
  }

  Metrics.inc(`compile.currentBackend.response.${response.status}`)

  let json
  try {
    json = JSON.parse(body)
  } catch (err) {
    // some responses are empty. Ignore JSON parsing errors
  }

  timer.done()
  let newClsiServerId
  if (CLSI_COOKIES_ENABLED) {
    newClsiServerId = _getClsiServerIdFromResponse(response)
    await ClsiCookieManager.promises.setServerId(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      newClsiServerId,
      clsiServerId
    )
  }
  const currentCompileTime = new Date() - currentBackendStartTime

  // Start new backend request in the background
  const newBackendStartTime = new Date()
  _makeNewBackendRequest(
    projectId,
    userId,
    compileGroup,
    compileBackendClass,
    url,
    opts
  )
    .then(result => {
      if (result == null) {
        return
      }
      const { response: newBackendResponse } = result
      Metrics.inc(`compile.newBackend.response.${newBackendResponse.status}`)
      const newBackendCompileTime = new Date() - newBackendStartTime
      const currentStatusCode = response.status
      const newStatusCode = newBackendResponse.status
      const statusCodeSame = newStatusCode === currentStatusCode
      const timeDifference = newBackendCompileTime - currentCompileTime
      logger.debug(
        {
          statusCodeSame,
          timeDifference,
          currentCompileTime,
          newBackendCompileTime,
          projectId,
        },
        'both clsi requests returned'
      )
    })
    .catch(err => {
      logger.warn({ err }, 'Error making request to new CLSI backend')
    })

  return {
    body: json,
    clsiServerId: newClsiServerId || clsiServerId,
  }
}

async function _makeNewBackendRequest(
  projectId,
  userId,
  compileGroup,
  compileBackendClass,
  url,
  opts
) {
  if (Settings.apis.clsi_new?.url == null) {
    return null
  }
  url = url
    .toString()
    .replace(Settings.apis.clsi.url, Settings.apis.clsi_new.url)

  const clsiServerId =
    await NewBackendCloudClsiCookieManager.promises.getServerId(
      projectId,
      userId,
      compileGroup,
      compileBackendClass
    )
  opts.headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  if (CLSI_COOKIES_ENABLED) {
    const cookie = new Cookie({
      key: Settings.clsiCookie.key,
      value: clsiServerId,
    })
    opts.headers.Cookie = cookie.cookieString()
  }

  const timer = new Metrics.Timer('compile.newBackend')

  let response, body
  try {
    ;({ body, response } = await fetchStringWithResponse(url, opts))
  } catch (err) {
    throw OError.tag(err, 'error making request to new CLSI', {
      userId,
      projectId,
    })
  }

  let json
  try {
    json = JSON.parse(body)
  } catch (err) {
    // Some responses are empty. Ignore JSON parsing errors
  }
  timer.done()
  if (CLSI_COOKIES_ENABLED) {
    const newClsiServerId = _getClsiServerIdFromResponse(response)
    await NewBackendCloudClsiCookieManager.promises.setServerId(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      newClsiServerId,
      clsiServerId
    )
  }
  return { response, body: json }
}

function _getCompilerUrl(
  compileBackendClass,
  compileGroup,
  projectId,
  userId,
  action
) {
  const u = new URL(`/project/${projectId}`, Settings.apis.clsi.url)
  if (userId != null) {
    u.pathname += `/user/${userId}`
  }
  if (action != null) {
    u.pathname += `/${action}`
  }
  u.searchParams.set('compileBackendClass', compileBackendClass)
  u.searchParams.set('compileGroup', compileGroup)
  return u
}

async function _postToClsi(
  projectId,
  userId,
  req,
  compileBackendClass,
  compileGroup
) {
  const url = _getCompilerUrl(
    compileBackendClass,
    compileGroup,
    projectId,
    userId,
    'compile'
  )
  const opts = {
    json: req,
    method: 'POST',
    signal: AbortSignal.timeout(COMPILE_REQUEST_TIMEOUT_MS),
  }
  try {
    const { body, clsiServerId } = await _makeRequest(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      url,
      opts
    )
    return { response: body, clsiServerId }
  } catch (err) {
    if (err instanceof RequestFailedError) {
      if (err.response.status === 413) {
        return { response: { compile: { status: 'project-too-large' } } }
      } else if (err.response.status === 409) {
        return { response: { compile: { status: 'conflict' } } }
      } else if (err.response.status === 423) {
        return { response: { compile: { status: 'compile-in-progress' } } }
      } else if (err.response.status === 503) {
        // FIXED: 2026-11-11 503 现在要区分「并发满载」和「真宕机」。
        //   CLSI 在 err.body 里给了 status=overloaded 时说明只是编译器忙，
        //   稍后重试就好；拿不到该标记才当作服务不可用。
        //   err.body 是原始 text（fetch-utils 用 response.text()），所以要自己 parse。
        // OLD: return { response: { compile: { status: 'unavailable' } } }
        return { response: { compile: { status: parseOverloadStatus(err.body) } } }
      } else {
        throw new OError(
          `CLSI returned non-success code: ${err.response.status}`,
          {
            projectId,
            userId,
            compileOptions: req.compile.options,
            rootResourcePath: req.compile.rootResourcePath,
            clsiResponse: err.body,
            statusCode: err.response.status,
          }
        )
      }
    } else {
      throw new OError(
        'failed to make request to CLSI',
        {
          projectId,
          userId,
          compileOptions: req.compile.options,
          rootResourcePath: req.compile.rootResourcePath,
        },
        err
      )
    }
  }
}

function _parseOutputFiles(projectId, rawOutputFiles = []) {
  const outputFiles = []
  for (const file of rawOutputFiles) {
    const f = {
      path: file.path, // the clsi is now sending this to web
      url: new URL(file.url).pathname, // the location of the file on the clsi, excluding the host part
      type: file.type,
      build: file.build,
    }
    if (file.path === 'output.pdf') {
      f.contentId = file.contentId
      f.ranges = file.ranges || []
      f.size = file.size
      f.startXRefTable = file.startXRefTable
      f.createdAt = new Date()
    }
    outputFiles.push(f)
  }
  return outputFiles
}

/**
 * FIXED: 2026-11 决定这次真正送给 CLSI 的引擎
 *
 * 原来 _finaliseRequest 里写死 `compiler: project.compiler`，于是所有
 * 「单次覆盖」的 options.compiler 都被静默丢弃（CompileController 里
 * POST /compile、公共 API、以及 agent 的 compile_project 都在传它）。
 * 后果是最坏的那种死锁：
 *   agent 传 compiler=xelatex → CLSI 实际仍跑项目设置里的 pdflatex
 *   → ctex 在老引擎下必然编不过 → 「成功才落库」不成立 → 设置永不更新
 *   → 下一轮还是 pdflatex。用户看到的永远是 switched:false。
 * 这里只做「合法就覆盖、非法就忽略并留日志」，项目设置一行都不写。
 */
function resolveRequestCompiler(project, options) {
  const requested =
    typeof options.compiler === 'string'
      ? options.compiler.trim().toLowerCase()
      : null
  if (!requested) return project.compiler
  if (VALID_COMPILERS.includes(requested)) return requested
  logger.warn(
    { projectId: project._id, requested, fallback: project.compiler },
    '[clsi] ignoring invalid compiler override'
  )
  return project.compiler
}

async function _buildRequest(projectId, options, preloadedProject) {
  // FIXED: 2026-11-08 支持传入已加载的 project，供“新鲜度检查”复用，
  // 避免为了算一次指纹把 rootFolder 读两遍。
  // OLD: const project = await ProjectGetter.promises.getProject(projectId, {...})
  const project =
    preloadedProject ||
    (await ProjectGetter.promises.getProject(projectId, {
      compiler: 1,
      rootDoc_id: 1,
      imageName: 1,
      rootFolder: 1,
    }))
  if (project == null) {
    throw new Errors.NotFoundError(`project does not exist: ${projectId}`)
  }
  if (!VALID_COMPILERS.includes(project.compiler)) {
    project.compiler = 'pdflatex'
  }

  if (options.incrementalCompilesEnabled || options.syncType != null) {
    // new way, either incremental or full
    const timer = new Metrics.Timer('editor.compile-getdocs-redis')
    let projectStateHash, docUpdaterDocs
    try {
      ;({ projectStateHash, docs: docUpdaterDocs } =
        await getContentFromDocUpdaterIfMatch(projectId, project, options))
    } catch (err) {
      logger.error({ err, projectId }, 'error checking project state')
      // note: we don't bail out when there's an error getting
      // incremental files from the docupdater, we just fall back
      // to a normal compile below
    }
    timer.done()
    // see if we can send an incremental update to the CLSI
    if (docUpdaterDocs != null && options.syncType !== 'full') {
      Metrics.inc('compile-from-redis')
      return _buildRequestFromDocupdater(
        projectId,
        options,
        project,
        projectStateHash,
        docUpdaterDocs
      )
    } else {
      Metrics.inc('compile-from-mongo')
      return await _buildRequestFromMongo(
        projectId,
        options,
        project,
        projectStateHash
      )
    }
  } else {
    // old way, always from mongo
    const timer = new Metrics.Timer('editor.compile-getdocs-mongo')
    const { docs, files } = await _getContentFromMongo(projectId)
    timer.done()
    return _finaliseRequest(projectId, options, project, docs, files)
  }
}

async function getContentFromDocUpdaterIfMatch(projectId, project, options) {
  const projectStateHash = ClsiStateManager.computeHash(project, options)
  const docs = await DocumentUpdaterHandler.promises.getProjectDocsIfMatch(
    projectId,
    projectStateHash
  )
  return { projectStateHash, docs }
}

async function getOutputFileStream(
  projectId,
  userId,
  options,
  clsiServerId,
  buildId,
  outputFilePath
) {
  const { compileBackendClass, compileGroup } = options
  const url = new URL(
    `${Settings.apis.clsi.url}/project/${projectId}/user/${userId}/build/${buildId}/output/${outputFilePath}`
  )
  url.searchParams.set('compileBackendClass', compileBackendClass)
  url.searchParams.set('compileGroup', compileGroup)
  url.searchParams.set('clsiserverid', clsiServerId)
  try {
    const stream = await fetchStream(url, {
      signal: AbortSignal.timeout(OUTPUT_FILE_TIMEOUT_MS),
    })
    return stream
  } catch (err) {
    throw new Errors.OutputFileFetchFailedError(
      'failed to fetch output file from CLSI',
      {
        projectId,
        userId,
        url,
        status: err.response?.status,
      }
    )
  }
}

// FIXED: 2026-11-16 读取「最近一次编译」的产物（不带 buildId）。
// CLSI 的 GET /project/:id/user/:userId/output/* 端点直接服务编译目录顶层文件；
// 编译目录名只含 projectId-userId（与 compileGroup 无关），顶层 output.log 每次
// 编译都会覆盖，所以该端点返回的就是最近一次编译的日志/PDF。
async function getLastOutputFileStream(
  projectId,
  userId,
  options,
  clsiServerId,
  outputFilePath
) {
  const { compileBackendClass, compileGroup } = options || {}
  const url = new URL(
    `${Settings.apis.clsi.url}/project/${projectId}/user/${userId}/output/${outputFilePath}`
  )
  if (compileBackendClass != null) {
    url.searchParams.set('compileBackendClass', compileBackendClass)
  }
  if (compileGroup != null) {
    url.searchParams.set('compileGroup', compileGroup)
  }
  if (clsiServerId != null) {
    url.searchParams.set('clsiserverid', clsiServerId)
  }
  try {
    const stream = await fetchStream(url, {
      signal: AbortSignal.timeout(OUTPUT_FILE_TIMEOUT_MS),
    })
    return stream
  } catch (err) {
    throw new Errors.OutputFileFetchFailedError(
      'failed to fetch last output file from CLSI',
      {
        projectId,
        userId,
        url,
        status: err.response?.status,
      }
    )
  }
}

function _buildRequestFromDocupdater(
  projectId,
  options,
  project,
  projectStateHash,
  docUpdaterDocs
) {
  const docPath = ProjectEntityHandler.getAllDocPathsFromProject(project)
  const docs = {}
  for (const doc of docUpdaterDocs || []) {
    const path = docPath[doc._id]
    docs[path] = doc
  }
  // send new docs but not files as those are already on the clsi
  options = _.clone(options)
  options.syncType = 'incremental'
  options.syncState = projectStateHash
  // create stub doc entries for any possible root docs, if not
  // present in the docupdater. This allows finaliseRequest to
  // identify the root doc.
  const possibleRootDocIds = [options.rootDoc_id, project.rootDoc_id]
  for (const rootDocId of possibleRootDocIds) {
    if (rootDocId != null && rootDocId in docPath) {
      const path = docPath[rootDocId]
      if (docs[path] == null) {
        docs[path] = { _id: rootDocId, path }
      }
    }
  }
  return _finaliseRequest(projectId, options, project, docs, [])
}

async function _buildRequestFromMongo(
  projectId,
  options,
  project,
  projectStateHash
) {
  const { docs, files } = await _getContentFromMongo(projectId)
  options = {
    ...options,
    syncType: 'full',
    syncState: projectStateHash,
  }
  return _finaliseRequest(projectId, options, project, docs, files)
}

async function _getContentFromMongo(projectId) {
  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  const files = await ProjectEntityHandler.promises.getAllFiles(projectId)
  return { docs, files }
}

function _finaliseRequest(projectId, options, project, docs, files) {
  const resources = []
  let flags
  let rootResourcePath = null
  let rootResourcePathOverride = null
  let hasMainFile = false
  let numberOfDocsInProject = 0

  for (let path in docs) {
    const doc = docs[path]
    path = path.replace(/^\//, '') // Remove leading /
    numberOfDocsInProject++
    if (doc.lines != null) {
      // add doc to resources unless it is just a stub entry
      resources.push({
        path,
        content: doc.lines.join('\n'),
      })
    }
    if (
      project.rootDoc_id != null &&
      doc._id.toString() === project.rootDoc_id.toString()
    ) {
      rootResourcePath = path
    }
    if (
      options.rootDoc_id != null &&
      doc._id.toString() === options.rootDoc_id.toString()
    ) {
      rootResourcePathOverride = path
    }
    if (path === 'main.tex') {
      hasMainFile = true
    }
  }

  if (rootResourcePathOverride != null) {
    rootResourcePath = rootResourcePathOverride
  }
  if (rootResourcePath == null) {
    if (hasMainFile) {
      rootResourcePath = 'main.tex'
    } else if (numberOfDocsInProject === 1) {
      // only one file, must be the main document
      for (const path in docs) {
        // Remove leading /
        rootResourcePath = path.replace(/^\//, '')
      }
    } else {
      throw new OError('no main file specified', { projectId })
    }
  }

  for (let path in files) {
    const file = files[path]
    path = path.replace(/^\//, '') // Remove leading /
    resources.push({
      path,
      url: `${Settings.apis.filestore.url}/project/${project._id}/file/${file._id}`,
      modified: file.created?.getTime(),
    })
  }

  if (options.fileLineErrors) {
    flags = ['-file-line-error']
  }

  const builtRequest = {
    compile: {
      options: {
        // 单次覆盖（options.compiler）优先，不传则用项目设置
        compiler: resolveRequestCompiler(project, options),
        timeout: options.timeout,
        imageName: project.imageName,
        draft: Boolean(options.draft),
        stopOnFirstError: Boolean(options.stopOnFirstError),
        check: options.check,
        syncType: options.syncType,
        syncState: options.syncState,
        compileGroup: options.compileGroup,
        enablePdfCaching:
          (Settings.enablePdfCaching && options.enablePdfCaching) || false,
        pdfCachingMinChunkSize: options.pdfCachingMinChunkSize,
        flags,
        metricsMethod: options.compileGroup,
      },
      rootResourcePath,
      resources,
    },
  }

  // FIXED: 2026-11-08 把“构建这个请求时的项目结构 hash”跟着请求带上，
  // 编译成功后 CompileFreshness 需要它做指纹的一部分。
  // 注意：必须用 computeStructureHash（不含 options），不能再用 options.syncState
  // 或 computeHash(project, options) —— 那两个都掺了 options，而编译路径与
  // 新鲜度检查路径的 options 天生不同，会让指纹永远对不上（等于功能失效）。
  requestStateHashes.set(
    builtRequest,
    ClsiStateManager.computeStructureHash(project)
  )

  return builtRequest
}

async function wordCount(projectId, userId, file, options, clsiserverid) {
  const { compileBackendClass, compileGroup } = options
  // FIXED: 2026-11-14 字数统计改用 POST，并把项目文件一起发给 CLSI。
  //
  // 原来只发 GET ?file=main.tex，CLSI 直接在上一次编译残留的目录里跑 texcount。
  // 那个目录一旦不完整（被清理过、换了 user_id、换实例），texcount 对每个
  // \input 都报 "!!! File ./chapters/xxx not found in path [./]"，正文统计成 0
  // —— 线上表现就是「一本书字数统计为 0」。
  // 现在按编译同样的方式带上 resources（syncType 固定 full），CLSI 先落盘再统计。
  // OLD: const opts = { method: 'GET' }
  const req = await _buildRequest(projectId, { ...options, syncType: 'full' })
  const filename = file || req.compile.rootResourcePath
  const url = _getCompilerUrl(
    compileBackendClass,
    compileGroup,
    projectId,
    userId,
    'wordcount'
  )
  url.searchParams.set('file', filename)
  url.searchParams.set('image', req.compile.options.imageName)

  const opts = {
    method: 'POST',
    json: req,
    signal: AbortSignal.timeout(COMPILE_REQUEST_TIMEOUT_MS),
  }
  try {
    const { body } = await _makeRequestWithClsiServerId(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      url,
      opts,
      clsiserverid
    )
    return body
  } catch (err) {
    // 超大项目可能超 CLSI 的 body 上限（413）。这时退回旧的 GET 方式：
    // 结果可能不准，但至少不是 500，用户还能看到个大概。
    logger.warn(
      { err, projectId, userId },
      'word count with resources failed, falling back to GET'
    )
    const legacyUrl = _getCompilerUrl(
      compileBackendClass,
      compileGroup,
      projectId,
      userId,
      'wordcount'
    )
    legacyUrl.searchParams.set('file', filename)
    legacyUrl.searchParams.set('image', req.compile.options.imageName)
    const { body } = await _makeRequestWithClsiServerId(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      legacyUrl,
      { method: 'GET' },
      clsiserverid
    )
    return body
  }
}

function _getClsiServerIdFromResponse(response) {
  const setCookieHeaders = response.headers.raw()['set-cookie'] ?? []
  for (const header of setCookieHeaders) {
    const cookie = Cookie.parse(header)
    if (cookie.key === Settings.clsiCookie.key) {
      return cookie.value
    }
  }
  return null
}

module.exports = {
  sendRequest: callbackifyMultiResult(sendRequest, [
    'status',
    'outputFiles',
    'clsiServerId',
    'validationProblems',
    'stats',
    'timings',
    'outputUrlPrefix',
  ]),
  sendExternalRequest: callbackifyMultiResult(sendExternalRequest, [
    'status',
    'outputFiles',
    'clsiServerId',
    'validationProblems',
    'stats',
    'timings',
    'outputUrlPrefix',
  ]),
  stopCompile: callbackify(stopCompile),
  deleteAuxFiles: callbackify(deleteAuxFiles),
  getOutputFileStream: callbackify(getOutputFileStream),
  getLastOutputFileStream: callbackify(getLastOutputFileStream),
  wordCount: callbackify(wordCount),
  // FIXED: 2026-11-08 供 GET /project/:id/compile/fresh 使用（不触发编译）
  buildRequestForFreshnessCheck: callbackify(buildRequestForFreshnessCheck),
  promises: {
    sendRequest,
    sendExternalRequest,
    stopCompile,
    deleteAuxFiles,
    getOutputFileStream,
    getLastOutputFileStream,
    wordCount,
    buildRequestForFreshnessCheck,
  },
}
