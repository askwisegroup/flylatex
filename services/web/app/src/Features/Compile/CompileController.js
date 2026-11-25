let CompileController
const { URL, URLSearchParams } = require('url')
const { pipeline } = require('stream/promises')
const { Cookie } = require('tough-cookie')
const OError = require('@overleaf/o-error')
const Metrics = require('@overleaf/metrics')
const ProjectGetter = require('../Project/ProjectGetter')
const ProjectOptionsHandler = require('../Project/ProjectOptionsHandler')
const EditorRealTimeController = require('../Editor/EditorRealTimeController')
const CompilerAutoDetect = require('./CompilerAutoDetect')
// FIXED: 2026-11 编译前先确认「主文件」——没选主文件时 ClsiManager 会直接抛
// no main file specified，编译根本没开始，表现却像「编译目录不存在」。
const AgentMainFileResolver = require('./AgentMainFileResolver')
// FIXED: 2026-11-15 编译日志结构化解析（从前端 latex-log-parser 移植的 CommonJS 版）
const LatexLogParser = require('./LatexLogParser')
const { User } = require('../../models/User')
const UserVip = require('../User/UserVip')
const CompileManager = require('./CompileManager')
const ClsiManager = require('./ClsiManager')
const CompileFreshness = require('./CompileFreshness')
const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')
const SessionManager = require('../Authentication/SessionManager')
const { RateLimiter } = require('../../infrastructure/RateLimiter')
const ClsiCookieManager = require('./ClsiCookieManager')(
  Settings.apis.clsi?.backendGroupName
)
const Path = require('path')
const AnalyticsManager = require('../Analytics/AnalyticsManager')
const SplitTestHandler = require('../SplitTests/SplitTestHandler')
const { callbackify } = require('@overleaf/promise-utils')
const {
  fetchStreamWithResponse,
  RequestFailedError,
} = require('@overleaf/fetch-utils')

// FIXED: 2026-11-03 这个值原本是 10 * 60 * 1000，和 clsi 的最大编译时长（600 秒）**完全相等**，
//   而 res.setTimeout(ms) 不传 callback 时，Node 到点会直接 destroy socket。
//   结果：编译真的跑满 600 秒（VIP 配额）时，clsi 在 600 秒杀掉进程的同时，
//   web 到浏览器的这条连接也正好在 600 秒被翅断，浏览器拿不到 JSON，
//   前端只能归成 error → 用户看到「服务器错误 / 您的项目无法编译」，而不是「编译超时」。
//   抬高到 13 分钟：比 clsi 上限多留 3 分钟给响应/传输，同时仍低于 nginx 的 900s。
// OLD: const COMPILE_TIMEOUT_MS = 10 * 60 * 1000
const COMPILE_TIMEOUT_MS = 13 * 60 * 1000

const pdfDownloadRateLimiter = new RateLimiter('full-pdf-download', {
  points: 1000,
  duration: 60 * 60,
})

function getImageNameForProject(projectId, callback) {
  ProjectGetter.getProject(projectId, { imageName: 1 }, (err, project) => {
    if (err) return callback(err)
    if (!project) return callback(new Error('project not found'))
    callback(null, project.imageName)
  })
}

async function getPdfCachingMinChunkSize(req, res) {
  const { variant } = await SplitTestHandler.promises.getAssignment(
    req,
    res,
    'pdf-caching-min-chunk-size'
  )
  if (variant === 'default') return 1_000_000
  return parseInt(variant, 10)
}

const getSplitTestOptions = callbackify(async function (req, res) {
  // Use the query flags from the editor request for overriding the split test.
  let query = {}
  try {
    const u = new URL(req.headers.referer || req.url, Settings.siteUrl)
    query = Object.fromEntries(u.searchParams.entries())
  } catch (e) {}
  const editorReq = { ...req, query }

  const { variant: domainVariant } =
    await SplitTestHandler.promises.getAssignment(
      editorReq,
      res,
      'pdf-download-domain'
    )
  const pdfDownloadDomain =
    domainVariant === 'user' && Settings.compilesUserContentDomain
      ? Settings.compilesUserContentDomain
      : Settings.pdfDownloadDomain

  if (!req.query.enable_pdf_caching) {
    // The frontend does not want to do pdf caching.
    return {
      pdfDownloadDomain,
      enablePdfCaching: false,
    }
  }

  // Double check with the latest split test assignment.
  // We may need to turn off the feature on a short notice, without requiring
  //  all users to reload their editor page to disable the feature.
  const { variant } = await SplitTestHandler.promises.getAssignment(
    editorReq,
    res,
    'pdf-caching-mode'
  )
  const enablePdfCaching = variant === 'enabled'
  if (!enablePdfCaching) {
    // Skip the lookup of the chunk size when caching is not enabled.
    return {
      pdfDownloadDomain,
      enablePdfCaching: false,
    }
  }
  const pdfCachingMinChunkSize = await getPdfCachingMinChunkSize(editorReq, res)
  return {
    pdfDownloadDomain,
    enablePdfCaching,
    pdfCachingMinChunkSize,
  }
})

// ---------------------------------------------------------------------------
// FIXED: 2026-11-02 自动探测编译器（设置 → 编译与项目 → 自动探测编译器）
//
// 流程：pdflatex 编译失败 → 读本次构建的 output.log → 日志里明确说需要
// XeTeX/LuaTeX → 把项目编译器改过去 → 同一请求内重编译一次。
// 前端拿到 autoSwitchedCompiler 后弹一个短提示，并可通过 compilerUpdated
// 事件同步工具栏里的编译器下拉。
// ---------------------------------------------------------------------------

async function isCompilerAutoDetectEnabled(userId) {
  if (!userId) {
    return false
  }
  // 只在编译失败时查这一次，且只取一个字段
  const user = await User.findById(userId, {
    'ace.autoDetectCompiler': 1,
  }).exec()
  // FIXED: 2026-11 老用户文档里没有这个字段（默认关的年代建的账号），
  // 这里按「未设置=开启」处理，否则改了默认值对他们依然无效。
  // 用户在设置里显式选「关闭」后会写入 false，那就尊重 false。
  return user?.ace?.autoDetectCompiler !== false
}

async function fetchCompileLogText(
  projectId,
  userId,
  limits,
  clsiServerId,
  outputFiles
) {
  const logFile = (outputFiles || []).find(file => file.path === 'output.log')
  if (!logFile?.build || !limits?.compileGroup) {
    return null
  }
  const stream = await ClsiManager.promises.getOutputFileStream(
    projectId,
    userId,
    {
      compileGroup: limits.compileGroup,
      compileBackendClass: limits.compileBackendClass,
    },
    clsiServerId,
    logFile.build,
    'output.log'
  )
  return CompilerAutoDetect.readStreamCapped(stream)
}

// FIXED: 2026-11-08 服务端兜底跳过编译。
// POST /compile 进来后先问「内容与上次成功编译一致吗、产物还在吗」，
// 一致就把上次的结果原样返回，一个字节都不送 CLSI。
// 放在服务端的原因：前端旧 bundle 也立刻生效；不依赖浏览器 HEAD 产物；
// 判断逻辑只有一个出处。任何异常/不新鲜 → 返回 null → 走原来的编译。
async function maybeReuseLastCompile(projectId, userId, options) {
  if (!Settings.compileFreshness?.enabled) return null
  try {
    const { req: clsiReq, stateHash } =
      await ClsiManager.promises.buildRequestForFreshnessCheck(projectId, {
        ...options,
        incrementalCompilesEnabled: true,
        check: ['validate', 'error', 'silent'].includes(options.check)
          ? options.check
          : 'silent',
      })
    return await CompileFreshness.reuse({
      projectId,
      userId,
      req: clsiReq,
      stateHash,
    })
  } catch (err) {
    // 绝不因为「省一次编译」而让编译请求失败
    logger.warn({ err, projectId }, '[compile-freshness] reuse check failed')
    return null
  }
}

function compileOnce(projectId, userId, options) {
  return new Promise((resolve, reject) => {
    CompileManager.compile(
      projectId,
      userId,
      options,
      (
        error,
        status,
        outputFiles,
        clsiServerId,
        limits,
        validationProblems,
        stats,
        timings,
        outputUrlPrefix
      ) => {
        if (error) {
          return reject(error)
        }
        resolve({
          status,
          outputFiles,
          clsiServerId,
          limits,
          validationProblems,
          stats,
          timings,
          outputUrlPrefix,
        })
      }
    )
  })
}

/**
 * 尝试按编译日志自动切换编译器并重编译。
 * @returns {Promise<null|{ compiler: string, result: object }>}
 */
async function maybeAutoSwitchCompiler({
  projectId,
  userId,
  options,
  limits,
  clsiServerId,
  outputFiles,
}) {
  if (!(await isCompilerAutoDetectEnabled(userId))) {
    return null
  }
  const logText = await fetchCompileLogText(
    projectId,
    userId,
    limits,
    clsiServerId,
    outputFiles
  )
  let detectedCompiler = CompilerAutoDetect.detectCompilerFromLog(logText)

  // FIXED: 2026-11 日志不够用时（或只给了二义的 "XeTeX or LuaTeX"）再扫一眼源码。
  // 之前只看日志：\directlua 这种只报 "Undefined control sequence" 的项目探测不到；
  // fontspec 先报错时又会统一按 xelatex 切，Lua 项目照样编不过。
  if (detectedCompiler !== 'lualatex') {
    const fromSources =
      await CompilerAutoDetect.detectCompilerFromProjectSources(projectId)
    if (fromSources === 'lualatex') {
      detectedCompiler = 'lualatex'
    } else if (!detectedCompiler) {
      detectedCompiler = fromSources
    }
  }

  if (!detectedCompiler) {
    return null
  }
  const project = await ProjectGetter.promises.getProject(projectId, {
    compiler: 1,
  })
  if (
    !CompilerAutoDetect.shouldSwitchCompiler({
      currentCompiler: project?.compiler,
      detectedCompiler,
    })
  ) {
    return null
  }

  await ProjectOptionsHandler.promises.setCompiler(projectId, detectedCompiler)
  // 和 EditorController.setCompiler 保持一致：让打开着的编辑器同步下拉框
  EditorRealTimeController.emitToRoom(
    projectId,
    'compilerUpdated',
    detectedCompiler
  )
  logger.info(
    { projectId, compiler: detectedCompiler },
    'auto detected compiler from compile log and switched'
  )
  Metrics.inc('compile-auto-detected-compiler', 1, {
    compiler: detectedCompiler,
  })

  const result = await compileOnce(projectId, userId, {
    ...options,
    // 换了编译器，强制一次全量编译，避免复用旧编译器的中间状态
    incrementalCompilesEnabled: false,
  })
  return { compiler: detectedCompiler, result }
}

// ===========================================================================
// Agent 触发编译（AI 助手工具 compile_project 的后端）
//
// 为什么单独一个入口，而不是让 agent 去 POST /project/:id/compile：
//   1. 那个接口要 req/res，还要 session、split test、analytics；
//   2. agent 需要的是「结构化结果 + 日志摘录」，不是一坨 outputFiles；
//   3. 引擎设置与编译结果无关（因果顺序：先设置、再编译）：
//      用户点名的引擎、日志猜到的引擎都在编译前写入并广播；编译失败/超时不回滚。
//      把「编译成功」当落库前提会让「源码有错 + 用户选对引擎」永远落不了库。
//      /compile 走的是 options.compiler 单次覆盖，本来就不落库，
//      所以这里要自己调 setCompiler。
// ===========================================================================

// 必须与 ClsiManager.js 的 VALID_COMPILERS 保持一致
// （scripts/checks/compile-tool.check.js 会做静态比对，改一处漏一处会失败）
const AGENT_VALID_COMPILERS = ['pdflatex', 'latex', 'xelatex', 'lualatex']

// Agent 单次编译的硬上限：CLSI 自己会在 compileTimeout 处中断，
// 这里多留 15s 给网络与打包，避免「CLSI 已经停了、web 还在等」。
const AGENT_COMPILE_TIMEOUT_GRACE_MS = 15000

function normalizeCompilerValue(value) {
  if (typeof value !== 'string') return null
  const compiler = value.trim().toLowerCase()
  return AGENT_VALID_COMPILERS.includes(compiler) ? compiler : null
}

/**
 * 从完整日志里挑出「模型真正需要看」的部分
 *
 * 整份 output.log 动辄几百 KB，直接塞给模型既贵又会挤掉上下文。
 * 这里保留：错误行、`l.NNN` 位置行、以及它们上下各 1 行（缺文件/命令未定义
 * 的上下文通常就在相邻行），其余丢弃，最后整体截断到 limit。
 */
function extractCompileLogExcerpt(logText, limit = 4000) {
  if (!logText) return ''
  const lines = String(logText).split('\n')
  const keep = new Set()
  const interesting =
    /^!|^l\.\d+|LaTeX Error|Undefined control sequence|File .* not found|Runaway|Emergency stop|Too many|Missing \$|Extra \}|Package .* Error|\bError\b/

  for (let i = 0; i < lines.length; i++) {
    if (interesting.test(lines[i])) {
      for (
        let j = Math.max(0, i - 1);
        j <= Math.min(lines.length - 1, i + 1);
        j++
      ) {
        keep.add(j)
      }
    }
  }

  let excerpt
  if (keep.size === 0) {
    // 没有明显错误（编译成功但可能有 overfull 之类的警告）→ 取尾部
    excerpt = lines.slice(-60).join('\n')
  } else {
    const picked = []
    let previous = -2
    for (const index of [...keep].sort((a, b) => a - b)) {
      if (index !== previous + 1) picked.push('...')
      picked.push(lines[index])
      previous = index
    }
    excerpt = picked.join('\n')
  }

  return excerpt.length > limit
    ? `${excerpt.slice(0, limit)}\n…（日志已截断）`
    : excerpt
}

/**
 * 把编译日志解析成结构化诊断（errors / warnings），供 agent 一步拿到 file+line+message，
 * 省去「读日志→猜文件行号→再读源码」的多步。
 *
 * 只保留精简字段（file/line/message/level），去掉 raw/content 以控制 token 消耗；
 * 解析失败不阻塞编译结果（降级为空数组）。
 */
function parseCompileDiagnostics(logText) {
  if (!logText) return { errors: [], warnings: [] }
  try {
    const parsed = new LatexLogParser(logText, {
      ignoreDuplicates: true,
    }).parse()
    const simplify = item => ({
      file: item.file || null,
      line: item.line != null ? Number(item.line) : null,
      message: String(item.message || '').slice(0, 300),
      level: item.level,
    })
    return {
      errors: (parsed.errors || []).slice(0, 30).map(simplify),
      warnings: (parsed.warnings || []).slice(0, 30).map(simplify),
    }
  } catch (err) {
    logger.warn({ err }, '[agent-compile] failed to parse log diagnostics')
    return { errors: [], warnings: [] }
  }
}

/**
 * FIXED: 2026-11-16 读取「用户最近一次编译」的日志并解析成结构化诊断，**不重新编译**。
 *
 * 用户已经自己点过编译、报错了，agent 不该再浪费一次编译（5–30s + 几千 token）去拿
 * 日志：直接读 CLSI 编译目录顶层的 output.log（每次编译覆盖，即最近一次），解析返回。
 * 没编译过 / 日志被清理 → 返回 available:false + hint，让 agent 明确知道要不要补一次编译。
 */
async function readLastCompileDiagnostics(projectId, userId) {
  if (!projectId) throw new Error('missing_project_id')

  // sticky session：同一 projectId+userId 的编译用同一个 CLSI 实例（Redis 缓存），
  // compileGroup 只影响「缓存 miss 时的探测请求」，不影响最终的实例缓存 key，
  // 因此这里用默认组也能路由到上次编译的那台实例。
  const compileGroup = Settings.defaultFeatures?.compileGroup || 'standard'
  const compileBackendClass = null
  const clsiServerId = await ClsiCookieManager.promises.getServerId(
    projectId,
    userId,
    compileGroup,
    compileBackendClass
  )

  let logText = null
  try {
    const stream = await ClsiManager.promises.getLastOutputFileStream(
      projectId,
      userId,
      { compileGroup, compileBackendClass },
      clsiServerId,
      'output.log'
    )
    logText = await CompilerAutoDetect.readStreamCapped(stream)
  } catch (err) {
    const status = err?.info?.status ?? err?.status ?? err?.response?.status
    if (status === 404 || err?.name === 'OutputFileFetchFailedError') {
      return {
        available: false,
        reason: 'no_compile_log',
        diagnostics: { errors: [], warnings: [] },
        hint: '项目还没有编译记录（output.log 不存在），或上次编译的日志已被清理。请先调用 compile_project 编译一次，再回来读诊断。',
      }
    }
    logger.warn(
      { projectId, error: err.message },
      '[agent-compile] failed to read last compile log'
    )
    return {
      available: false,
      reason: 'fetch_failed',
      diagnostics: { errors: [], warnings: [] },
      hint: `读取上次编译日志失败：${err.message}。可以改调用 compile_project 重新编译一次。`,
    }
  }

  if (!logText) {
    return {
      available: false,
      reason: 'empty_log',
      diagnostics: { errors: [], warnings: [] },
      hint: '上次编译的日志是空的（可能还没编译完成或产物已被清理）。请调用 compile_project 重新编译。',
    }
  }

  return {
    available: true,
    diagnostics: parseCompileDiagnostics(logText),
    logExcerpt: extractCompileLogExcerpt(logText, 3000),
  }
}

/**
 * 带超时与取消的编译
 *
 * 超时后必须调 stopCompile：只 reject promise 的话 CLSI 那边还在跑，
 * 用户以为停了、CPU 还在烧（这正是「不要引入新 BUG」的一条）。
 */
async function compileOnceWithTimeout(projectId, userId, options, timeoutMs) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      CompileManager.stopCompile(projectId, userId, () => {})
      reject(new Error('compile_timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      compileOnce(projectId, userId, options),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 给 AI 助手用的编译入口
 *
 * 语义（与 UI 上的「重新编译」不同，注意区别）：
 *   - **因果顺序：先设置引擎，再编译。**引擎落库与编译结果无关，失败/超时都不回滚。
 *     理由：「编译成功」是设置生效之后才可能有的结果，源码报错不等于引擎选错；
 *     把编译成功当成落库前提，会让「源码有错 + 用户选对引擎」永远落不了库。
 *   - `compiler` 显式指定 = 用户点名要的引擎：编译**之前**写进项目设置并广播
 *     compilerUpdated，只编一次，不自动换其它引擎。
 *   - 未指定 `compiler` 时：按项目设置编一次；若失败则从日志→源码猜一个引擎，
 *     先把猜到的引擎落库，再用它重编一次（与 UI 的自动探测行为一致）。
 *   - 用户只是要「换引擎」而不需要编译结果时，走 set_compiler 工具，根本不进这里。
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {string} params.userId
 * @param {string} [params.compiler] 显式要求的引擎（白名单校验，非法值忽略）
 * @param {boolean} [params.draft] 草稿模式（不生成 PDF，排查错误时更快）
 * @param {string} [params.check] 'validate' | 'error' | 'silent'
 * @param {number} [params.timeoutMs]
 * @returns {Promise<Object>}
 */
async function compileForAgent({
  projectId,
  userId,
  compiler,
  draft = false,
  check,
  timeoutMs,
  // FIXED: 2026-11 「Agent 耐心程度」= 严格档时由调用方传 1，
  // 不要在这一次调用里连试两个引擎（那等于偷偷多编一次）。
  maxAttempts,
}) {
  if (!projectId) throw new Error('missing_project_id')

  const project = await ProjectGetter.promises.getProject(projectId, {
    compiler: 1,
    rootDoc_id: 1,
  })
  if (!project) throw new Error('project_not_found')

  const previousCompiler =
    normalizeCompilerValue(project.compiler) || 'pdflatex'
  const requestedCompiler = normalizeCompilerValue(compiler)
  let targetCompiler = requestedCompiler || previousCompiler

  // FIXED: 2026-11-15 Agent 编译按用户 VIP 状态放宽到 10 分钟。
  // OLD: 一律使用 Settings.defaultFeatures.compileTimeout（普通用户 300 秒）。
  // 注意：调用方显式传了 timeoutMs 时以调用方为准，避免外层已经设了更短的超时。
  const agentUser = userId
    ? await User.findById(userId, 'vipEndDate vipExpired')
    : null
  const agentVipCompileTimeout =
    !timeoutMs && UserVip.isVipUser(agentUser)
      ? Settings.userLimits?.vip?.agentCompileTimeout || 600
      : null
  const compileTimeoutSeconds =
    agentVipCompileTimeout ||
    Settings.defaultFeatures?.compileTimeout ||
    Settings.compileTimeouts?.default ||
    180
  const effectiveTimeoutMs =
    timeoutMs ||
    (compileTimeoutSeconds + 15) * 1000 + AGENT_COMPILE_TIMEOUT_GRACE_MS

  const startedAt = Date.now()

  // FIXED: 2026-11 主文件闸门。
  // 「没选主文件」是 Agent 报「编译目录不存在 / 请你自己点编译」最常见的真因：
  // 子文件工程、从 zip 导入后没跑过 setRootDocAutomatically、用户手动清了主文件……
  // 处理原则：能确定的就替用户定下来（并广播给编辑器），定不下来就交回去问用户，
  // 绝不假装编译过、也绝不把「你自己去点按钮」当结论交给用户。
  let mainFile = null
  try {
    mainFile = await AgentMainFileResolver.resolveMainFile(projectId)
  } catch (err) {
    logger.warn(
      { projectId, error: err.message },
      '[agent-compile] main file resolution failed'
    )
  }

  if (mainFile && mainFile.status !== 'ok') {
    const ambiguous = mainFile.status === 'ambiguous'
    return {
      status: 'no_main_file',
      success: false,
      checkOnly: false,
      compiler: targetCompiler,
      previousCompiler,
      requestedCompiler: requestedCompiler || null,
      switched: false,
      switchedBeforeCompile: false,
      attempts: [],
      outputFiles: [],
      compileGroup: null,
      timings: null,
      durationMs: Date.now() - startedAt,
      mainFile,
      error: ambiguous ? 'ambiguous_main_file' : 'no_main_file',
      logExcerpt: '',
      diagnostics: { errors: [], warnings: [] },
      hint: ambiguous
        ? '项目里有多份都含 \\documentclass 的文档，且没有设置主文件，所以无法编译。请让用户从 candidates 里挑一个，然后调用 set_main_file 定下来（不要自己猜）。'
        : '项目里找不到含 \\documentclass 的主文档，所以无法编译。请把这件事直接告诉用户（例如这份稿子可能只有章节片段，需要补一个带 documentclass/begin{document} 的主文件），不要让他去点「编译」按钮。',
    }
  }

  const attempts = []
  let result = null
  let lastError = null
  let switched = false
  let switchedBeforeCompile = false
  let suggestion = null

  // FIXED: 2026-11 显式引擎一律只编一次：不让 maxAttempts（耐心档位）把它抬到 2，
  // 否则失败后会自动换成探测到的另一个引擎再编一次 —— 既违背「用户指定哪个就哪个」，
  // 又白白多烧一次编译（5–30s + 几千 token 日志）。自动猜时才允许两次。
  // OLD: Math.max(1, Math.min(2, Number(maxAttempts) || (requestedCompiler ? 1 : 2)))
  const attemptLimit = requestedCompiler
    ? 1
    : Math.max(1, Math.min(2, Number(maxAttempts) || 2))

  // ---- FIXED: 2026-11 设置先于编译：显式指定的引擎立即落库 ----
  // 旧语义（错误的因果）：编译成功才写入，于是「源码本身有错」时，用户明明选对了引擎也
  // 永远没机会落库（选 xelatex → 实跑 xelatex → 源码报错 → 不写入 → 下次还是 pdflatex）。
  // 正确顺序：先改设置、设置成功，**然后**才有编译及其结果。
  // 所以任何引擎切换（用户指定 / 日志猜到的）都是先写库再编译，失败不回滚；
  // 源码报错要改的是稿子，不是把用户的引擎设置推翻。
  if (requestedCompiler && requestedCompiler !== previousCompiler) {
    try {
      await ProjectOptionsHandler.promises.setCompiler(
        projectId,
        requestedCompiler
      )
      // 与 EditorController.setCompiler 保持一致：让开着着的编辑器同步下拉框
      EditorRealTimeController.emitToRoom(
        projectId,
        'compilerUpdated',
        requestedCompiler
      )
      switched = true
      switchedBeforeCompile = true
    } catch (persistErr) {
      // 落库失败不影响「本次用该引擎编译」：真正进 CLSI 的是 options.compiler 覆盖
      logger.warn(
        { projectId, compiler: requestedCompiler, error: persistErr.message },
        '[agent-compile] failed to persist requested compiler'
      )
    }
  }

  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    let attemptResult
    try {
      attemptResult = await compileOnceWithTimeout(
        projectId,
        userId,
        {
          compiler: targetCompiler,
          // 自动判定出来的主文件同时作为本次编译的覆盖：万一 setRootDoc 落库失败，
          // 这一次编译仍然能找到主文件（ClsiManager 优先用 options.rootDoc_id）
          ...(mainFile && mainFile.autoSelected && mainFile.rootDocId
            ? { rootDoc_id: mainFile.rootDocId }
            : {}),
          draft: draft === true,
          stopOnFirstError: false,
          // 让 CLSI 用 -file-line-error 输出 ./file.tex:line: message，
          // 这样 LatexLogParser 才能解析出带 file+line 的结构化诊断。
          fileLineErrors: true,
          // 换引擎必须全量，避免复用上一个引擎的 aux/bbl 中间状态
          incrementalCompilesEnabled: false,
          // 只有 VIP 且调用方没显式限制时长时才放宽；CompileManager 会把它
          // 合并进 limits.timeout 后再删除，避免把内部参数传给 CLSI。
          ...(agentVipCompileTimeout ? { agentVipCompileTimeout } : {}),
          ...(check ? { check } : {}),
        },
        effectiveTimeoutMs
      )
    } catch (err) {
      lastError = err.message
      attempts.push({
        compiler: targetCompiler,
        status: 'error',
        error: err.message,
      })
      // 超时不再重试：再编一次大概率还是超时，只是让用户多等一倍
      if (err.message === 'compile_timeout') break
      break
    }

    attempts.push({ compiler: targetCompiler, status: attemptResult.status })
    result = attemptResult

    if (attemptResult.status === 'success') break

    // FIXED: 2026-11-11 并发满载（overloaded）不算「稿子有问题」，立即返回。
    // 以前会继续拉日志、猜下一个引擎，再编一次 —— 每次重试都往已经满载的
    // CLSI 上再压一个请求，只会让它更忙；而且换引擎跟"忙"毫无因果关系。
    // 调用方（前端 / ai-agent）拿到 overloaded 后应该提示「稍候重试」。
    if (attemptResult.status === 'overloaded') {
      lastError = 'compile_server_overloaded'
      break
    }

    // 失败 → 拿日志，猜下一个引擎
    let logText = null
    try {
      logText = await fetchCompileLogText(
        projectId,
        userId,
        attemptResult.limits,
        attemptResult.clsiServerId,
        attemptResult.outputFiles
      )
    } catch (logErr) {
      logger.warn(
        { projectId, error: logErr.message },
        '[agent-compile] failed to fetch compile log'
      )
    }

    if (attempt + 1 >= attemptLimit) {
      result.logText = logText
      break
    }

    let detected = null
    try {
      detected = CompilerAutoDetect.detectCompilerFromLog(logText)
      if (detected !== 'lualatex') {
        const fromSources =
          await CompilerAutoDetect.detectCompilerFromProjectSources(projectId)
        if (fromSources === 'lualatex') {
          detected = 'lualatex'
        } else if (!detected) {
          detected = fromSources
        }
      }
    } catch (detectErr) {
      logger.warn(
        { projectId, error: detectErr.message },
        '[agent-compile] compiler detection failed'
      )
    }

    suggestion = detected || suggestion
    if (!detected || detected === targetCompiler) {
      result.logText = logText
      break
    }

    // FIXED: 2026-11 因果顺序：先设置、再编译。
    // 探测到的引擎同样**立即落库**，不等下一次编译结果 —— 「编译成功」是设置生效
    // 之后才可能有的结果，不能反过来当成设置的前提（源码报错 ≠ 引擎选错）。
    targetCompiler = detected
    if (targetCompiler !== previousCompiler) {
      try {
        await ProjectOptionsHandler.promises.setCompiler(
          projectId,
          targetCompiler
        )
        EditorRealTimeController.emitToRoom(
          projectId,
          'compilerUpdated',
          targetCompiler
        )
        switched = true
      } catch (persistErr) {
        logger.warn(
          { projectId, compiler: targetCompiler, error: persistErr.message },
          '[agent-compile] failed to persist detected compiler'
        )
      }
    }
  }

  const status = result?.status || 'failure'

  // FIXED: 2026-11 check=validate/silent 是「只预检」，CLSI 同样回 status:'success'，
  // 但**不会产出 PDF**。它只用来告诉调用方「没有 PDF」，**不再参与落库判断**：
  // 引擎落库在编译之前就完成了，与编译结果无关。
  const checkOnly = Boolean(check)

  const logText = result?.logText ?? null
  return {
    status,
    success: status === 'success',
    // FIXED: 2026-11 告诉调用方「这次只是预检，没有 PDF」。
    // 否则 ai-agent 会把 check:'validate' 的成功当成排版已验证。
    checkOnly,
    compiler: targetCompiler,
    previousCompiler,
    requestedCompiler: requestedCompiler || null,
    suggestedCompiler: suggestion,
    switched,
    // 显式引擎在编译开始前就已写入项目设置（编译失败也不回滚）
    switchedBeforeCompile,
    attempts,
    outputFiles: (result?.outputFiles || [])
      .map(file => file && file.path)
      .filter(Boolean)
      .slice(0, 30),
    compileGroup: result?.limits?.compileGroup || null,
    timings: result?.timings || null,
    durationMs: Date.now() - startedAt,
    error: lastError,
    mainFile: mainFile
      ? {
          path: mainFile.path,
          autoSelected: mainFile.autoSelected === true,
          persisted: mainFile.persisted === true,
          reason: mainFile.reason,
        }
      : null,
    logExcerpt: extractCompileLogExcerpt(
      logText,
      status === 'success' ? 1500 : 4000
    ),
    // FIXED: 2026-11-15 结构化诊断：agent 一步拿到 file+line+message，
    // 能直接定位错误行、识别错误类型（缺字体/缺包/未定义控制序列等）并行动。
    diagnostics: parseCompileDiagnostics(logText),
  }
}

module.exports = CompileController = {
  compile(req, res, next) {
    res.setTimeout(COMPILE_TIMEOUT_MS)
    const projectId = req.params.Project_id
    const isAutoCompile = !!req.query.auto_compile
    const fileLineErrors = !!req.query.file_line_errors
    const stopOnFirstError = !!req.body.stopOnFirstError
    const userId = SessionManager.getLoggedInUserId(req.session)
    const options = {
      isAutoCompile,
      fileLineErrors,
      stopOnFirstError,
    }

    // temporary override to force the new compile timeout
    const forceNewCompileTimeout = req.query.force_new_compile_timeout
    if (
      forceNewCompileTimeout === 'active' ||
      forceNewCompileTimeout === 'changing'
    ) {
      options.forceNewCompileTimeout = forceNewCompileTimeout
    }

    if (req.body.rootDoc_id) {
      options.rootDoc_id = req.body.rootDoc_id
    } else if (
      req.body.settingsOverride &&
      req.body.settingsOverride.rootDoc_id
    ) {
      // Can be removed after deploy
      options.rootDoc_id = req.body.settingsOverride.rootDoc_id
    }
    if (req.body.compiler) {
      options.compiler = req.body.compiler
    }
    if (req.body.draft) {
      options.draft = req.body.draft
    }
    if (['validate', 'error', 'silent'].includes(req.body.check)) {
      options.check = req.body.check
    }
    if (req.body.incrementalCompilesEnabled) {
      options.incrementalCompilesEnabled = true
    }

    getSplitTestOptions(req, res, (err, splitTestOptions) => {
      if (err) return next(err)
      let { enablePdfCaching, pdfCachingMinChunkSize, pdfDownloadDomain } =
        splitTestOptions
      options.enablePdfCaching = enablePdfCaching
      if (enablePdfCaching) {
        options.pdfCachingMinChunkSize = pdfCachingMinChunkSize
      }

      const startCompile = () =>
        CompileManager.compile(
          projectId,
          userId,
          options,
          (
            error,
            status,
            outputFiles,
            clsiServerId,
            limits,
            validationProblems,
            stats,
            timings,
            outputUrlPrefix
          ) => {
            if (error) {
              Metrics.inc('compile-error')
              return next(error)
            }
            Metrics.inc('compile-status', 1, { status })
            // FIXED: 2026-11-02 pdfDownloadDomain 改成按“当次结果”拼，
            // 因为自动切换编译器后会多一次编译（否则会重复拼前缀）
            const pdfDownloadDomainBase = pdfDownloadDomain
            const pdfDownloadDomainFor = urlPrefix =>
              pdfDownloadDomainBase && urlPrefix
                ? pdfDownloadDomainBase + urlPrefix
                : pdfDownloadDomainBase

            if (limits) {
              // For a compile request to be sent to clsi we need limits.
              // If we get here without having the limits object populated, it is
              //  a reasonable assumption to make that nothing was compiled.
              // We need to know the limits in order to make use of the events.
              AnalyticsManager.recordEventForSession(
                req.session,
                'compile-result-backend',
                {
                  projectId,
                  ownerAnalyticsId: limits.ownerAnalyticsId,
                  status,
                  compileTime: timings?.compileE2E,
                  timeout: limits.timeout === 60 ? 'short' : 'long',
                  server: clsiServerId?.includes('-c2d-') ? 'faster' : 'normal',
                  isAutoCompile,
                  stopOnFirstError,
                }
              )
            }
            const sendResult = (result, extra = {}) => {
              res.json({
                status: result.status,
                outputFiles: result.outputFiles,
                compileGroup: result.limits?.compileGroup,
                clsiServerId: result.clsiServerId,
                validationProblems: result.validationProblems,
                stats: result.stats,
                timings: result.timings,
                pdfDownloadDomain: pdfDownloadDomainFor(result.outputUrlPrefix),
                pdfCachingMinChunkSize,
                ...extra,
              })
            }

            const firstResult = {
              status,
              outputFiles,
              clsiServerId,
              limits,
              validationProblems,
              stats,
              timings,
              outputUrlPrefix,
            }

            // FIXED: 2026-11-02 自动探测编译器：只在“确实编译失败”且用户开了开关时尝试；
            // 显式指定了编译器或 validate 预检时不动。每个请求最多重试一轮。
            if (
              status !== 'failure' ||
              options.compiler ||
              options.check === 'validate'
            ) {
              return sendResult(firstResult)
            }

            maybeAutoSwitchCompiler({
              projectId,
              userId,
              options,
              limits,
              clsiServerId,
              outputFiles,
            })
              .then(switched => {
                if (!switched) {
                  return sendResult(firstResult)
                }
                sendResult(switched.result, {
                  autoSwitchedCompiler: switched.compiler,
                })
              })
              .catch(err => {
                logger.warn(
                  { err, projectId },
                  'failed to auto detect compiler from compile log'
                )
                sendResult(firstResult)
              })
          }
        )

      // FIXED: 2026-11-08 先试「复用上次成功编译的结果」，成功则直接回包
      maybeReuseLastCompile(projectId, userId, options)
        .then(reused => {
          if (!reused || !reused.skip) {
            // 用 warn 而不是 info：默认日志级别下也能看到，
            // 一眼就知道这次为什么没复用（reason 会说明是哪一项不一致）。
            logger.warn(
              { projectId, reason: reused && reused.reason },
              '[compile-freshness] not reusing last result, compiling'
            )
            return startCompile()
          }
          logger.info(
            { projectId, recordedAt: reused.recordedAt },
            '[compile-freshness] served last compile result, no build'
          )
          const pdfDownloadDomainFor = urlPrefix =>
            pdfDownloadDomain && urlPrefix
              ? pdfDownloadDomain + urlPrefix
              : pdfDownloadDomain
          res.json({
            status: reused.result.status,
            outputFiles: reused.result.outputFiles,
            compileGroup: reused.result.compileGroup,
            clsiServerId: reused.result.clsiServerId,
            validationProblems: null,
            stats: {},
            timings: {},
            pdfDownloadDomain: pdfDownloadDomainFor(
              reused.result.outputUrlPrefix
            ),
            pdfCachingMinChunkSize,
            skippedCompile: true,
          })
        })
        .catch(err => next(err))
    })
  },

  stopCompile(req, res, next) {
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    CompileManager.stopCompile(projectId, userId, function (error) {
      if (error) {
        return next(error)
      }
      res.sendStatus(200)
    })
  },

  // FIXED: 2026-11-08 编译新鲜度检查（阶段 ②）。
  // 回答一个问题：“现在要送去编译的内容，与上次成功编译时是否完全一致？”
  // 不发任何编译请求，也不改变任何既有行为（阶段 ③ 前端接线后才用它跳过编译）。
  // 任何异常一律返回 fresh:false —— 宁可多编一次，也不能给出错的结论。
  async getCompileFreshness(req, res) {
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const truthy = value => value === 'true' || value === '1'
    const options = {
      draft: truthy(req.query.draft),
      stopOnFirstError: truthy(req.query.stop_on_first_error),
      fileLineErrors: truthy(req.query.file_line_errors),
      check: ['validate', 'error', 'silent'].includes(req.query.check)
        ? req.query.check
        : 'silent',
      // 与前端 POST /compile 时的 body 一致
      incrementalCompilesEnabled: true,
    }
    if (req.query.root_doc_id) {
      options.rootDoc_id = req.query.root_doc_id
    }
    if (req.query.compiler) {
      options.compiler = req.query.compiler
    }

    const skipEnabled = Boolean(Settings.compileFreshness?.enabled)

    try {
      const { req: clsiReq, stateHash } =
        await ClsiManager.promises.buildRequestForFreshnessCheck(
          projectId,
          options
        )
      const result = await CompileFreshness.check({
        projectId,
        userId,
        req: clsiReq,
        stateHash,
      })
      res.json({
        fresh: Boolean(result.fresh),
        reason: result.reason,
        recordedAt: result.recordedAt || null,
        checkedResources: result.checkedResources || 0,
        skipEnabled,
      })
    } catch (err) {
      // 例如项目没有主文件（no main file specified）—— 那就老老实实去编译
      logger.warn(
        { err, projectId, userId },
        '[compile-freshness] check endpoint failed'
      )
      res.json({ fresh: false, reason: 'error', skipEnabled })
    }
  },

  // Used for submissions through the public API
  compileSubmission(req, res, next) {
    res.setTimeout(COMPILE_TIMEOUT_MS)
    const submissionId = req.params.submission_id
    const options = {}
    if (req.body?.rootResourcePath != null) {
      options.rootResourcePath = req.body.rootResourcePath
    }
    if (req.body?.compiler) {
      options.compiler = req.body.compiler
    }
    if (req.body?.draft) {
      options.draft = req.body.draft
    }
    if (['validate', 'error', 'silent'].includes(req.body?.check)) {
      options.check = req.body.check
    }
    options.compileGroup =
      req.body?.compileGroup || Settings.defaultFeatures.compileGroup
    options.compileBackendClass = Settings.apis.clsi.submissionBackendClass
    options.timeout =
      req.body?.timeout || Settings.defaultFeatures.compileTimeout
    ClsiManager.sendExternalRequest(
      submissionId,
      req.body,
      options,
      function (error, status, outputFiles, clsiServerId, validationProblems) {
        if (error) {
          return next(error)
        }
        res.json({
          status,
          outputFiles,
          clsiServerId,
          validationProblems,
        })
      }
    )
  },

  _compileAsUser(req, callback) {
    // callback with userId if per-user, undefined otherwise
    if (!Settings.disablePerUserCompiles) {
      const userId = SessionManager.getLoggedInUserId(req.session)
      callback(null, userId)
    } else {
      callback()
    }
  }, // do a per-project compile, not per-user

  _downloadAsUser(req, callback) {
    // callback with userId if per-user, undefined otherwise
    if (!Settings.disablePerUserCompiles) {
      const userId = SessionManager.getLoggedInUserId(req.session)
      callback(null, userId)
    } else {
      callback()
    }
  }, // do a per-project compile, not per-user

  downloadPdf(req, res, next) {
    Metrics.inc('pdf-downloads')
    const projectId = req.params.Project_id
    const rateLimit = function (callback) {
      pdfDownloadRateLimiter
        .consume(req.ip)
        .then(() => {
          callback(null, true)
        })
        .catch(err => {
          if (err instanceof Error) {
            callback(err)
          } else {
            callback(null, false)
          }
        })
    }

    ProjectGetter.getProject(projectId, { name: 1 }, function (err, project) {
      if (err) {
        return next(err)
      }
      res.contentType('application/pdf')
      const filename = `${CompileController._getSafeProjectName(project)}.pdf`

      if (req.query.popupDownload) {
        res.setContentDisposition('attachment', { filename })
      } else {
        res.setContentDisposition('inline', { filename })
      }

      rateLimit(function (err, canContinue) {
        if (err) {
          logger.err({ err }, 'error checking rate limit for pdf download')
          res.sendStatus(500)
        } else if (!canContinue) {
          logger.debug(
            { projectId, ip: req.ip },
            'rate limit hit downloading pdf'
          )
          res.sendStatus(500)
        } else {
          CompileController._downloadAsUser(req, function (error, userId) {
            if (error) {
              return next(error)
            }
            const url = CompileController._getFileUrl(
              projectId,
              userId,
              req.params.build_id,
              'output.pdf'
            )
            CompileController.proxyToClsi(
              projectId,
              'output-file',
              url,
              {},
              req,
              res,
              next
            )
          })
        }
      })
    })
  },

  _getSafeProjectName(project) {
    return project.name.replace(/[^\p{L}\p{Nd}]/gu, '_')
  },

  deleteAuxFiles(req, res, next) {
    const projectId = req.params.Project_id
    const { clsiserverid } = req.query
    CompileController._compileAsUser(req, function (error, userId) {
      if (error) {
        return next(error)
      }
      CompileManager.deleteAuxFiles(
        projectId,
        userId,
        clsiserverid,
        function (error) {
          if (error) {
            return next(error)
          }
          res.sendStatus(200)
        }
      )
    })
  },

  // this is only used by templates, so is not called with a userId
  compileAndDownloadPdf(req, res, next) {
    const projectId = req.params.project_id
    // pass userId as null, since templates are an "anonymous" compile
    CompileManager.compile(projectId, null, {}, function (err) {
      if (err) {
        logger.err(
          { err, projectId },
          'something went wrong compile and downloading pdf'
        )
        res.sendStatus(500)
        return
      }
      const url = `/project/${projectId}/output/output.pdf`
      CompileController.proxyToClsi(
        projectId,
        'output-file',
        url,
        {},
        req,
        res,
        next
      )
    })
  },

  getFileFromClsi(req, res, next) {
    const projectId = req.params.Project_id
    CompileController._downloadAsUser(req, function (error, userId) {
      if (error) {
        return next(error)
      }
      const url = CompileController._getFileUrl(
        projectId,
        userId,
        req.params.build_id,
        req.params.file
      )
      CompileController.proxyToClsi(
        projectId,
        'output-file',
        url,
        {},
        req,
        res,
        next
      )
    })
  },

  getFileFromClsiWithoutUser(req, res, next) {
    const submissionId = req.params.submission_id
    const url = CompileController._getFileUrl(
      submissionId,
      null,
      req.params.build_id,
      req.params.file
    )
    const limits = {
      compileGroup:
        req.body?.compileGroup ||
        req.query?.compileGroup ||
        Settings.defaultFeatures.compileGroup,
      compileBackendClass: Settings.apis.clsi.submissionBackendClass,
    }
    CompileController.proxyToClsiWithLimits(
      submissionId,
      'output-file',
      url,
      {},
      limits,
      req,
      res,
      next
    )
  },

  // compute a GET file url for a given project, user (optional), build (optional) and file
  _getFileUrl(projectId, userId, buildId, file) {
    let url
    if (userId != null && buildId != null) {
      url = `/project/${projectId}/user/${userId}/build/${buildId}/output/${file}`
    } else if (userId != null) {
      url = `/project/${projectId}/user/${userId}/output/${file}`
    } else if (buildId != null) {
      url = `/project/${projectId}/build/${buildId}/output/${file}`
    } else {
      url = `/project/${projectId}/output/${file}`
    }
    return url
  },

  // compute a POST url for a project, user (optional) and action
  _getUrl(projectId, userId, action) {
    let path = `/project/${projectId}`
    if (userId != null) {
      path += `/user/${userId}`
    }
    return `${path}/${action}`
  },

  proxySyncPdf(req, res, next) {
    const projectId = req.params.Project_id
    const { page, h, v } = req.query
    if (!page?.match(/^\d+$/)) {
      return next(new Error('invalid page parameter'))
    }
    if (!h?.match(/^-?\d+\.\d+$/)) {
      return next(new Error('invalid h parameter'))
    }
    if (!v?.match(/^-?\d+\.\d+$/)) {
      return next(new Error('invalid v parameter'))
    }
    // whether this request is going to a per-user container
    CompileController._compileAsUser(req, function (error, userId) {
      if (error) {
        return next(error)
      }
      getImageNameForProject(projectId, (error, imageName) => {
        if (error) return next(error)

        const url = CompileController._getUrl(projectId, userId, 'sync/pdf')
        CompileController.proxyToClsi(
          projectId,
          'sync-to-pdf',
          url,
          { page, h, v, imageName },
          req,
          res,
          next
        )
      })
    })
  },

  proxySyncCode(req, res, next) {
    const projectId = req.params.Project_id
    const { file, line, column } = req.query
    if (file == null) {
      return next(new Error('missing file parameter'))
    }
    // Check that we are dealing with a simple file path (this is not
    // strictly needed because synctex uses this parameter as a label
    // to look up in the synctex output, and does not open the file
    // itself).  Since we have valid synctex paths like foo/./bar we
    // allow those by replacing /./ with /
    const testPath = file.replace('/./', '/')
    if (Path.resolve('/', testPath) !== `/${testPath}`) {
      return next(new Error('invalid file parameter'))
    }
    if (!line?.match(/^\d+$/)) {
      return next(new Error('invalid line parameter'))
    }
    if (!column?.match(/^\d+$/)) {
      return next(new Error('invalid column parameter'))
    }
    CompileController._compileAsUser(req, function (error, userId) {
      if (error) {
        return next(error)
      }
      getImageNameForProject(projectId, (error, imageName) => {
        if (error) return next(error)

        const url = CompileController._getUrl(projectId, userId, 'sync/code')
        CompileController.proxyToClsi(
          projectId,
          'sync-to-code',
          url,
          { file, line, column, imageName },
          req,
          res,
          next
        )
      })
    })
  },

  proxyToClsi(projectId, action, url, qs, req, res, next) {
    CompileManager.getProjectCompileLimits(projectId, function (error, limits) {
      if (error) {
        return next(error)
      }
      CompileController.proxyToClsiWithLimits(
        projectId,
        action,
        url,
        qs,
        limits,
        req,
        res,
        next
      )
    })
  },

  proxyToClsiWithLimits(projectId, action, url, qs, limits, req, res, next) {
    _getPersistenceOptions(
      req,
      projectId,
      limits.compileGroup,
      limits.compileBackendClass,
      (err, persistenceOptions) => {
        if (err) {
          OError.tag(err, 'error getting cookie jar for clsi request')
          return next(err)
        }
        url = new URL(`${Settings.apis.clsi.url}${url}`)
        url.search = new URLSearchParams({
          ...persistenceOptions.qs,
          ...qs,
        }).toString()
        const timer = new Metrics.Timer(
          'proxy_to_clsi',
          1,
          { path: action },
          [0, 100, 1000, 2000, 5000, 10000, 15000, 20000, 30000, 45000, 60000]
        )
        Metrics.inc('proxy_to_clsi', 1, { path: action, status: 'start' })
        fetchStreamWithResponse(url.href, {
          method: req.method,
          signal: AbortSignal.timeout(60 * 1000),
          headers: persistenceOptions.headers,
        })
          .then(({ stream, response }) => {
            if (req.destroyed) {
              // The client has disconnected already, avoid trying to write into the broken connection.
              Metrics.inc('proxy_to_clsi', 1, {
                path: action,
                status: 'req-aborted',
              })
              return
            }
            Metrics.inc('proxy_to_clsi', 1, {
              path: action,
              status: response.status,
            })

            for (const key of ['Content-Length', 'Content-Type']) {
              res.setHeader(key, response.headers.get(key))
            }
            res.writeHead(response.status)
            return pipeline(stream, res)
          })
          .then(() => {
            timer.labels.status = 'success'
            timer.done()
          })
          .catch(err => {
            const reqAborted = Boolean(req.destroyed)
            const status = reqAborted ? 'req-aborted-late' : 'error'
            timer.labels.status = status
            const duration = timer.done()
            Metrics.inc('proxy_to_clsi', 1, { path: action, status })
            const streamingStarted = Boolean(res.headersSent)
            if (!streamingStarted) {
              if (err instanceof RequestFailedError) {
                res.sendStatus(err.response.status)
              } else {
                res.sendStatus(500)
              }
            }
            if (
              streamingStarted &&
              reqAborted &&
              err.code === 'ERR_STREAM_PREMATURE_CLOSE'
            ) {
              // Ignore noisy spurious error
              return
            }
            logger.warn(
              {
                err,
                projectId,
                url,
                action,
                reqAborted,
                streamingStarted,
                duration,
              },
              'CLSI proxy error'
            )
          })
      }
    )
  },

  wordCount(req, res, next) {
    const projectId = req.params.Project_id
    const file = req.query.file || false
    const { clsiserverid } = req.query
    CompileController._compileAsUser(req, function (error, userId) {
      if (error) {
        return next(error)
      }
      CompileManager.wordCount(
        projectId,
        userId,
        file,
        clsiserverid,
        function (error, body) {
          if (error) {
            return next(error)
          }
          res.json(body)
        }
      )
    })
  },
}

function _getPersistenceOptions(
  req,
  projectId,
  compileGroup,
  compileBackendClass,
  callback
) {
  const { clsiserverid } = req.query
  const userId = SessionManager.getLoggedInUserId(req)
  if (clsiserverid && typeof clsiserverid === 'string') {
    callback(null, {
      qs: { clsiserverid, compileGroup, compileBackendClass },
      headers: {},
    })
  } else {
    ClsiCookieManager.getServerId(
      projectId,
      userId,
      compileGroup,
      compileBackendClass,
      (err, clsiServerId) => {
        if (err) return callback(err)
        callback(null, {
          qs: { compileGroup, compileBackendClass },
          headers: clsiServerId
            ? {
                Cookie: new Cookie({
                  key: Settings.clsiCookie.key,
                  value: clsiServerId,
                }).cookieString(),
              }
            : {},
        })
      }
    )
  }
}

// agent 工具入口（见上方 compileForAgent 注释）
CompileController.compileForAgent = compileForAgent
CompileController.readLastCompileDiagnostics = readLastCompileDiagnostics
