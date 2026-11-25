const crypto = require('crypto')
const { expressify } = require('@overleaf/promise-utils')
const logger = require('@overleaf/logger')

const ProjectGetter = require('../Project/ProjectGetter')
const ProjectEntityHandler = require('../Project/ProjectEntityHandler')
const ProjectOptionsHandler = require('../Project/ProjectOptionsHandler')
const TagsHandler = require('../Tags/TagsHandler')
const FileStoreHandler = require('../FileStore/FileStoreHandler')
const CompileManager = require('../Compile/CompileManager')
const ClsiManager = require('../Compile/ClsiManager')
const CompileController = require('../Compile/CompileController')
const SessionManager = require('../Authentication/SessionManager')
const { RateLimiter } = require('../../infrastructure/RateLimiter')
const Errors = require('../Errors/Errors')
const DesktopSyncLastModified = require('./DesktopSyncLastModified')

// 与 DesktopSync 保持同一套身份模型：requireApiKey 注入 req.session.user，
// 这里所有处理器都通过 SessionManager 取 userId，不依赖 cookie。
const compileLimiter = new RateLimiter('desktop-sync-compile', {
  points: 10,
  duration: 60,
})

const MAX_LOG_BYTES = 512 * 1024
const LOG_TAIL_LINES = 200
const MAX_LOG_ERRORS = 50
const SAFE_COMPILERS = ['xelatex', 'pdflatex', 'latex', 'lualatex']
const TAG_COLOR_REGEX = /^#[a-fA-F0-9]{6}$/
const MAX_TAG_LENGTH = 50

// FIXED: 2026-11-11 字体缺字。pdfTeX/xeTeX 缺字时不报错、不失败，只写这一行，
// 上层若不单独识别就会把「PDF 里有空白」当成编译成功。
const MISSING_CHARACTER_REGEX =
  /^Missing character: There is no (.+?) \(U\+([0-9A-Fa-f]+)\) in font (.+)$/

function stripLeadingSlash(path) {
  return path.startsWith('/') ? path.slice(1) : path
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function hashStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    let size = 0
    stream.on('data', chunk => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }))
  })
}

// 读取流并截断到 maxBytes，避免把超大日志整个塞进内存。
function readStreamCapped(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let truncated = false
    stream.on('data', chunk => {
      if (total >= maxBytes) {
        truncated = true
        return
      }
      const remaining = maxBytes - total
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        total = maxBytes
        truncated = true
      } else {
        chunks.push(chunk)
        total += chunk.length
      }
    })
    stream.on('error', reject)
    stream.on('end', () => {
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        truncated,
      })
    })
  })
}

/**
 * 从编译日志里抽取错误/警告。
 *
 * 只覆盖最常见的几类，够 Agent 定位即可；不做 Overleaf 前端那套完整规则匹配。
 * 目标：给出 file/line/message 三元组，让模型不必自己扫几万行日志。
 */
function parseLatexLog(log) {
  const entries = []
  const seen = new Set()
  const lines = log.split(/\r?\n/)

  const pushEntry = entry => {
    const key = `${entry.level}|${entry.file || ''}|${entry.line || ''}|${
      entry.message
    }`
    if (seen.has(key) || entries.length >= MAX_LOG_ERRORS) {
      return
    }
    seen.add(key)
    entries.push(entry)
  }

  const looksLikeNoise = line =>
    /^(Overfull|Underfull|Package .* Info:|LaTeX Font Info:|\(|\)|\s*$)/.test(
      line
    )

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 1) TeX 原生错误：以 "!" 开头，行号在后续的 "l.<n>" 或 "on input line <n>"
    const bang = /^!\s*(.*)$/.exec(line)
    if (bang) {
      const message = bang[1].trim() || 'LaTeX error'
      let lineNo = null
      let file = null
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const lLine = /^l\.(\d+)/.exec(lines[j])
        if (lLine) {
          lineNo = Number(lLine[1])
          break
        }
        const inputLine = /on input line (\d+)/.exec(lines[j])
        if (inputLine) {
          lineNo = Number(inputLine[1])
          break
        }
        const fileLine = /^\(\.\/([^\s()]+)/.exec(lines[j])
        if (fileLine && !file) {
          file = fileLine[1]
        }
      }
      pushEntry({ level: 'error', message, file, line: lineNo })
      continue
    }

    // 2) -file-line-error 格式： "./main.tex:12: Undefined control sequence."
    const fileLineError =
      /^(?:\.\/)?([^:\s]+\.(?:tex|sty|cls|bib)):(\d+):\s*(.+)$/.exec(line)
    if (fileLineError) {
      pushEntry({
        level: 'error',
        file: fileLineError[1],
        line: Number(fileLineError[2]),
        message: fileLineError[3].trim(),
      })
      continue
    }

    // 2.5) FIXED: 2026-11-11 字体缺字。
    //   Missing character: There is no 浥 (U+6D65) in font [FandolSong-Regular.otf]/OT:s
    // 这类行**不会**让 latexmk 失败，status 仍是 success，但 PDF 对应位置是空白。
    // 归为 warning（不是 error）：编译确实成功、PDF 也生成了，只是局部缺字；
    // 调用方需要看 level 才能区分「编译失败」与「内容不完整」。
    const missingChar = MISSING_CHARACTER_REGEX.exec(line)
    if (missingChar) {
      const [, char, codePoint, font] = missingChar
      pushEntry({
        level: 'warning',
        file: null,
        line: null,
        message: `Missing character: "${char}" (U+${codePoint.toUpperCase()}) not found in font ${font}`,
      })
      continue
    }

    // 3) 警告：只保留带行号的，避免噪声
    const warning = /^(?:LaTeX|Package\s+\S+)\s+Warning:\s*(.+)$/.exec(line)
    if (warning && !looksLikeNoise(line)) {
      const lineMatch = /on input line (\d+)/.exec(warning[1])
      pushEntry({
        level: 'warning',
        message: warning[1].replace(/\s*on input line \d+/, '').trim(),
        file: null,
        line: lineMatch ? Number(lineMatch[1]) : null,
      })
    }
  }

  return entries
}

/**
 * FIXED: 2026-11-11 把日志里的「字体缺字」单独抽成结构化列表。
 *
 * pdfTeX/xeTeX 缺字时不会报错、不会让 latexmk 失败，只在日志里留
 *   Missing character: There is no 浥 (U+6D65) in font [FandolSong-Regular.otf]/OT:s
 * 如果只返回 status=success + errors=[]，调用方会误判「改完了」。
 * 去重后按字符返回，便于一次性告知用户「哪几个字没排出来」。
 * 注意：日志被 max_print_line 折行时，字体名可能被截断，不影响 char/U+xxxx 的提取。
 */
function extractMissingCharacters(log) {
  const found = new Map()
  for (const line of log.split(/\r?\n/)) {
    const match = MISSING_CHARACTER_REGEX.exec(line)
    if (!match) {
      continue
    }
    const [, char, codePoint, font] = match
    const code = `U+${codePoint.toUpperCase()}`
    if (!found.has(code)) {
      found.set(code, { char, codePoint: code, fonts: [] })
    }
    const entry = found.get(code)
    const fontName = font.trim()
    if (!entry.fonts.includes(fontName)) {
      entry.fonts.push(fontName)
    }
  }
  return [...found.values()]
}

function runCompile(projectId, userId, options) {
  return new Promise((resolve, reject) => {
    CompileManager.compile(
      projectId,
      userId,
      options,
      (
        err,
        status,
        outputFiles,
        clsiServerId,
        limits,
        validationProblems,
        stats,
        timings
      ) => {
        if (err) {
          return reject(err)
        }
        resolve({
          status,
          outputFiles: outputFiles || [],
          clsiServerId,
          limits,
          validationProblems,
          stats,
          timings,
        })
      }
    )
  })
}

function runDeleteAuxFiles(projectId, userId, clsiServerId) {
  return new Promise((resolve, reject) => {
    CompileManager.deleteAuxFiles(projectId, userId, clsiServerId, err => {
      if (err) {
        return reject(err)
      }
      resolve()
    })
  })
}

function formatTag(tag) {
  return {
    id: tag._id.toString(),
    name: tag.name,
    color: tag.color || null,
  }
}

async function fetchProjectTags(userId, projectId) {
  const tags = await TagsHandler.promises.getTagsForProject(userId, projectId)
  return tags.map(formatTag)
}

async function fetchCompileLog(
  projectId,
  userId,
  limits,
  clsiServerId,
  buildId
) {
  if (!buildId || !limits?.compileGroup || !limits?.compileBackendClass) {
    return null
  }
  try {
    const stream = await ClsiManager.promises.getOutputFileStream(
      projectId,
      userId,
      {
        compileGroup: limits.compileGroup,
        compileBackendClass: limits.compileBackendClass,
      },
      clsiServerId,
      buildId,
      'output.log'
    )
    return await readStreamCapped(stream, MAX_LOG_BYTES)
  } catch (err) {
    logger.warn(
      { err, projectId, buildId, clsiServerId },
      '[desktop-sync] failed to fetch compile log'
    )
    return null
  }
}

function pickBuildId(outputFiles) {
  const preferred = outputFiles.find(
    file => file.path === 'output.log' || file.path === 'output.pdf'
  )
  const anyFile = preferred || outputFiles[0]
  return anyFile?.build || null
}

/**
 * FIXED: 2026-11-11 「空失败」兜底。
 *
 * 背景：latexmk 判定「无需重跑」时（stats['latex-runs-0']=1），不会重新生成
 * output.log，也不会产出带 buildId 的新产物 → fetchCompileLog 拿不到 buildId
 * 直接返回 null，于是响应变成 status=failure + errors=[] + logTail=null，
 * 调用方完全看不到原因（实测 128ms 返回，像是接口坏了）。
 *
 * 为什么不能「回退读上一次的 output.log」：ResourceWriter._removeExtraneousFiles
 * 会在每次编译同步资源时把 output.log 一并删掉，顶层根本没有上一份日志可读。
 * 所以只能在服务端补一次带 clean 的编译 —— 删掉 aux/.fdb_latexmk 后 latexmk
 * 必然重跑，就能拿到真正的原因。只重试一次，避免放大故障。
 */
async function runCompileCleaningIfEmptyFailure(projectId, userId, options) {
  const first = await runCompile(projectId, userId, options)
  if (first.status === 'success') {
    return { result: first, retriedWithClean: false }
  }

  const firstBuildId = pickBuildId(first.outputFiles)
  const firstLog = await fetchCompileLog(
    projectId,
    userId,
    first.limits,
    first.clsiServerId,
    firstBuildId
  )
  if (firstLog?.text) {
    return { result: first, retriedWithClean: false, logResult: firstLog }
  }

  // 空失败：没有日志可解释，删 aux 再来一次
  logger.warn(
    { projectId, userId, status: first.status },
    '[desktop-sync] compile failed without log, retrying with clean'
  )
  try {
    await runDeleteAuxFiles(projectId, userId)
  } catch (err) {
    logger.warn(
      { err, projectId, userId },
      '[desktop-sync] failed to clean aux files before retry'
    )
  }
  const retried = await runCompile(projectId, userId, options)
  return { result: retried, retriedWithClean: true }
}

async function findRootDocPath(projectId, rootDocId) {
  if (!rootDocId) {
    return null
  }
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  for (const [path, doc] of Object.entries(docs)) {
    if (doc._id && doc._id.toString() === rootDocId.toString()) {
      return stripLeadingSlash(path)
    }
  }
  return null
}

module.exports = {
  parseLatexLog,

  /**
   * GET /api/sync/project/:project_id
   * 项目元信息：CLI 用来判断远端是否变化、拿根文档和编译器。
   */
  getMeta: expressify(async function getMeta(req, res) {
    const projectId = req.params.project_id
    const project = await ProjectGetter.promises.getProject(projectId, {
      name: true,
      lastUpdated: true,
      rootDoc_id: true,
      compiler: true,
      owner_ref: true,
    })
    if (!project) {
      throw new Errors.NotFoundError('project not found')
    }
    const rootDoc = await findRootDocPath(projectId, project.rootDoc_id)
    const tags = await fetchProjectTags(
      SessionManager.getLoggedInUserId(req.session),
      projectId
    )
    res.json({
      id: projectId,
      name: project.name,
      lastModified: DesktopSyncLastModified.toMillis(project.lastUpdated),
      rootDoc,
      compiler: project.compiler || null,
      owner: project.owner_ref ? project.owner_ref.toString() : null,
      tags,
    })
  }),

  /**
   * GET /api/sync/project/:project_id/manifest[?hash=1]
   * 文件清单。hash=1 时返回与 zip 内字节一致的 sha256（doc 为 lines.join('\n')，
   * file 为原始字节），CLI 解压后按同样方式计算即可比对。
   */
  getManifest: expressify(async function getManifest(req, res) {
    const projectId = req.params.project_id
    const withHash = ['1', 'true', 'yes'].includes(
      String(req.query.hash || '').toLowerCase()
    )

    const project = await ProjectGetter.promises.getProject(projectId, {
      lastUpdated: true,
      rootDoc_id: true,
      compiler: true,
    })
    if (!project) {
      throw new Errors.NotFoundError('project not found')
    }

    const [docs, files, tags] = await Promise.all([
      ProjectEntityHandler.promises.getAllDocs(projectId),
      ProjectEntityHandler.promises.getAllFiles(projectId),
      fetchProjectTags(
        SessionManager.getLoggedInUserId(req.session),
        projectId
      ),
    ])

    const entries = []
    for (const [path, doc] of Object.entries(docs)) {
      const entry = { path: stripLeadingSlash(path), type: 'doc' }
      if (withHash) {
        const content = doc.lines.join('\n')
        entry.sha256 = sha256(content)
        entry.size = Buffer.byteLength(content, 'utf8')
      }
      entries.push(entry)
    }

    // 文件按 4 并发读取，避免一次打开过多 filestore 连接。
    const fileEntries = Object.entries(files)
    const concurrency = 4
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(concurrency, fileEntries.length) },
      async () => {
        while (cursor < fileEntries.length) {
          const [path, file] = fileEntries[cursor++]
          const entry = { path: stripLeadingSlash(path), type: 'file' }
          if (withHash) {
            try {
              const stream = await FileStoreHandler.promises.getFileStream(
                projectId,
                file._id,
                {}
              )
              const { sha256: fileHash, size } = await hashStream(stream)
              entry.sha256 = fileHash
              entry.size = size
            } catch (err) {
              logger.warn(
                { err, projectId, fileId: file._id },
                '[desktop-sync] failed to hash file'
              )
              entry.error = 'hash-failed'
            }
          }
          entries.push(entry)
        }
      }
    )
    await Promise.all(workers)

    entries.sort((a, b) => a.path.localeCompare(b.path))

    let rootDoc = null
    if (project.rootDoc_id) {
      for (const [path, doc] of Object.entries(docs)) {
        if (doc._id && doc._id.toString() === project.rootDoc_id.toString()) {
          rootDoc = stripLeadingSlash(path)
          break
        }
      }
    }

    res.json({
      id: projectId,
      lastModified: DesktopSyncLastModified.toMillis(project.lastUpdated),
      rootDoc,
      compiler: project.compiler || null,
      tags,
      hashes: withHash,
      entries,
    })
  }),

  /**
   * POST /api/sync/project/:project_id/compiler
   * 持久修改项目编译器。注意：compile 请求体里的 compiler 只对单次编译生效。
   */
  setCompiler: expressify(async function setCompiler(req, res) {
    const projectId = req.params.project_id
    const compiler = String(req.body?.compiler || '')
      .trim()
      .toLowerCase()

    if (!SAFE_COMPILERS.includes(compiler)) {
      return res.status(400).json({
        message: `invalid compiler: ${compiler || '(empty)'}`,
        allowed: SAFE_COMPILERS,
      })
    }

    await ProjectOptionsHandler.promises.setCompiler(projectId, compiler)

    res.json({ compiler })
  }),

  /**
   * POST /api/sync/project/:project_id/compile
   * 同步编译并返回状态 + 错误列表 + 日志尾部。
   * 请求体（可选）：{ compiler, draft, stopOnFirstError, clean }
   * clean=true 时先删除 aux 文件，避免 latexmk 复用旧构建目录。
   */
  compile: expressify(async function compile(req, res) {
    const projectId = req.params.project_id
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      await compileLimiter.consume(userId)
    } catch (err) {
      return res.status(429).json({
        message: 'compile rate limit exceeded, retry later',
      })
    }

    const body = req.body || {}
    const options = {
      isAutoCompile: false,
      fileLineErrors: true, // 让日志带 "file:line:"，便于解析
      stopOnFirstError: Boolean(body.stopOnFirstError),
      enablePdfCaching: false,
    }
    if (body.compiler) {
      options.compiler = String(body.compiler)
    }
    if (body.draft) {
      options.draft = true
    }
    if (body.rootDoc_id) {
      options.rootDoc_id = String(body.rootDoc_id)
    }

    if (body.clean) {
      try {
        await runDeleteAuxFiles(projectId, userId)
      } catch (err) {
        // 清理失败不阻断编译，但要让调用方在日志里看到。
        logger.warn(
          { err, projectId, userId },
          '[desktop-sync] failed to clean aux files before compile'
        )
      }
    }

    let result
    let retriedWithClean = false
    let logResult
    try {
      // FIXED: 2026-11-11 空失败（status=failure 且没有任何产物/日志）时，
      // 服务端自己带 clean 重编一次，避免调用方拿到「毫无信息」的失败。
      // 调用方已显式传 clean=true 时不再重试，避免重复删 aux。
      if (body.clean) {
        result = await runCompile(projectId, userId, options)
      } else {
        const outcome = await runCompileCleaningIfEmptyFailure(
          projectId,
          userId,
          options
        )
        result = outcome.result
        retriedWithClean = outcome.retriedWithClean
        logResult = outcome.logResult
      }
    } catch (err) {
      // 编译请求本身失败（clsi 不可用等）→ 502，便于 CLI 与「编译出错」区分。
      // 注意：publicApiRouter 的 handleApiError 只会给 500 且没有 body。
      logger.err(
        { err, projectId, userId },
        '[desktop-sync] compile request failed'
      )
      return res.status(502).json({
        message: 'compile request failed',
        detail: err.message,
      })
    }

    const buildId = pickBuildId(result.outputFiles)
    if (!logResult) {
      logResult = await fetchCompileLog(
        projectId,
        userId,
        result.limits,
        result.clsiServerId,
        buildId
      )
    }
    const log = logResult?.text || null

    res.json({
      status: result.status,
      buildId,
      clsiServerId: result.clsiServerId || null,
      compileGroup: result.limits?.compileGroup || null,
      outputs: result.outputFiles.map(file => ({
        path: file.path,
        type: file.type,
        build: file.build || null,
      })),
      errors: log ? parseLatexLog(log) : [],
      logTail: log
        ? log.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n')
        : null,
      log,
      logTruncated: Boolean(logResult?.truncated),
      // FIXED: 2026-11-11 true 表示首次编译「失败但没有任何日志」，服务端已
      // 带 clean 重编一次，这份结果来自第二次。
      retriedWithClean,
      // FIXED: 2026-11-11 字体缺字不会让编译失败（status 仍为 success），
      // 单拎出来告诉调用方「PDF 里有空白」，避免把成功当正确。
      missingCharacters: log ? extractMissingCharacters(log) : [],
      validationProblems: result.validationProblems || null,
      timings: result.timings || null,
      stats: result.stats || null,
    })
  }),

  /**
   * GET /api/sync/project/:project_id/tags
   * 当前 API Key 用户给该项目打的标签（标签本身是用户级资源）。
   */
  listProjectTags: expressify(async function listProjectTags(req, res) {
    const projectId = req.params.project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    res.json({ tags: await fetchProjectTags(userId, projectId) })
  }),

  /**
   * POST /api/sync/project/:project_id/tags
   * body: { name, color? }
   * 标签不存在则创建，然后把项目加入标签；重复调用幂等。
   */
  addProjectTag: expressify(async function addProjectTag(req, res) {
    const projectId = req.params.project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const name = String(req.body?.name || '').trim()
    const rawColor = req.body?.color
    const color =
      rawColor == null || rawColor === '' ? undefined : String(rawColor).trim()

    if (!name) {
      return res.status(400).json({ message: 'tag name is required' })
    }
    if (name.length > MAX_TAG_LENGTH) {
      return res.status(400).json({
        message: `tag name exceeds ${MAX_TAG_LENGTH} characters`,
      })
    }
    if (color && !TAG_COLOR_REGEX.test(color)) {
      return res.status(400).json({ message: 'invalid tag color' })
    }

    const tag = await TagsHandler.promises.createTag(userId, name, color)
    const updatedTag = await TagsHandler.promises.addProjectToTag(
      userId,
      tag._id,
      projectId
    )
    const tags = await fetchProjectTags(userId, projectId)

    res.json({ tag: formatTag(updatedTag || tag), tags })
  }),

  /**
   * DELETE /api/sync/project/:project_id/tags/:tag_id
   * 只解除项目与标签的关联，不删除标签本身；重复删除也返回成功。
   */
  removeProjectTag: expressify(async function removeProjectTag(req, res) {
    const projectId = req.params.project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const tagId = String(req.params.tag_id || '')

    // Tag 使用 ObjectId，非法 id 直接 400，避免 mongoose CastError 变成 500。
    if (!/^[a-fA-F0-9]{24}$/.test(tagId)) {
      return res.status(400).json({ message: 'invalid tag id' })
    }

    await TagsHandler.promises.removeProjectFromTag(userId, tagId, projectId)
    res.json({ tags: await fetchProjectTags(userId, projectId) })
  }),

  /**
   * GET /api/sync/project/:project_id/pdf
   * 最近一次成功编译的 PDF。委托给现有控制器，复用 clsi 代理与权限判断。
   */
  downloadPdf(req, res, next) {
    req.params = { Project_id: req.params.project_id }
    CompileController.downloadPdf(req, res, next)
  },

  /**
   * GET /api/sync/project/:project_id/build/:build_id/output/:file
   * 取任意编译产物（output.log / output.pdf / output.blg ...）。
   */
  getBuildOutput(req, res, next) {
    const file = String(req.params.file || '')
    // 只允许常规文件名；挡住 ../ 与协议注入
    if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.includes('..')) {
      return res.status(400).json({ message: 'invalid output file path' })
    }
    req.params = {
      Project_id: req.params.project_id,
      build_id: req.params.build_id,
      file,
    }
    CompileController.getFileFromClsi(req, res, next)
  },
}
