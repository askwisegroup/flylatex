/**
 * FIXED: 2026-11-02 自动探测编译器（设置 → 编译与项目 → 自动探测编译器）
 *
 * 为什么不做「猜主文档 + 扫源码」：
 *   导入外部项目时主文档本身就是猜的（ProjectRootDocManager 按「层级浅 → 文件小 →
 *   文件名」排序后取第一个含 \documentclass 的），在一套可能是错的猜测上再叠一层
 *   文本启发式，误判概率叠乘。而且 编译器是项目级设置（Project.compiler），
 *   和「哪个文件是 main」本来就没有必然联系。
 *
 * 所以判据改成「TeX 引擎自己的报错」：
 *   pdflatex 编不过、日志里明确说需要 XeTeX / LuaTeX → 才建议切换。
 *   这条路径与主文档是谁完全无关，也不会因为项目里有多个 \documentclass 而失效。
 *
 * 边界：
 *   - 只做「建议」，切换 + 重新编译由调用方（CompileController）执行；
 *   - 只从 pdflatex / latex 切到 xelatex / lualatex，反向不切（否则可能来回震荡）；
 *   - 每个请求最多触发一次（CompileController 只重试一轮）。
 */

// 日志只看前 512KB：TeX 的关键报错都在开头，避免把几百 MB 的日志拉进内存
const MAX_LOG_BYTES = 512 * 1024

// LuaLaTeX 必须优先于 XeLaTeX 判断：fontspec 的报错是
// "requires either XeTeX or LuaTeX"，两种引擎都能满足，先看有没有更强的 Lua 信号
const LUALATEX_SIGNATURES = [
  /requires\s+LuaTeX/i,
  /LuaTeX\s+is\s+required/i,
  /luacode\s+(?:package\s+)?requires\s+LuaTeX/i,
  /\bLuaTeX\s+only\b/i,
  /must\s+be\s+(?:compiled|run|processed)\s+with\s+LuaLaTeX/i,
  // FIXED: 2026-11 \directlua / \luaexec 在 pdflatex 下只会报
  // "Undefined control sequence."，日志里根本不会出现 "LuaTeX" 字样，
  // 之前因此永远探测不到「其实是 LuaLaTeX 项目」。
  // 日志标准化之后是一行：! Undefined control sequence. l.12 \directlua
  /Undefined control sequence[\s\S]{0,200}\\(?:directlua|luadirect|luaexec|latelua)\b/i,
  // luatexja / luaotfload / luamplib 等包在 pdflatex 下的报错（各种措辞）
  /Package\s+(?:luatexja|luatexja-fontspec|luaotfload|luamplib|luapstricks|lua-?unicode)\s+Error[\s\S]{0,200}(?:LuaTeX|LuaLaTeX)/i,
  /(?:luatexja|luaotfload|luamplib)\s+(?:requires|needs|must be used with)\s+Lua/i,
]

const XELATEX_SIGNATURES = [
  // fontspec / unicode-math / polyglossia 在 pdflatex 下的标准报错
  /requires\s+(?:either\s+)?XeTeX\s+or\s+LuaTeX/i,
  // ctex / xeCJK 在 pdflatex 下的标准报错
  /requires\s+XeTeX\s+or\s+LuaLaTeX/i,
  /requires\s+XeTeX/i,
  /requires\s+XeLaTeX/i,
  /must\s+be\s+(?:compiled|run|processed)\s+with\s+XeLaTeX/i,
  /please\s+(?:use|switch\s+to|compile\s+with)\s+XeLaTeX/i,
  /only\s+works?\s+with\s+XeLaTeX/i,
  /XeLaTeX\s+is\s+required/i,
]

// 允许自动切换的「起点」编译器：从 pdflatex/latex 出发才有意义。
// 已经是 xelatex 还报「需要 XeTeX」，那是字体/包缺失，切编译器不解决问题。
const SWITCHABLE_FROM = ['pdflatex', 'latex']

/**
 * 把日志整理成「一行一段」便于匹配。
 *
 * 真实日志里报错经常被 TeX 折行拆开，例如：
 *   ! Package fontspec Error: The fontspec package requires either XeTeX or
 *   (fontspec)                LuaTeX.
 * 所以不能直接对原文做 \s+ 匹配，先把「换行 + (pkgname) 缩进前缀」压成一个空格。
 * @param {string|Buffer} logText
 * @returns {string}
 */
function normalizeLogForMatching(logText) {
  return (
    String(logText)
      .slice(0, MAX_LOG_BYTES)
      .replace(/\r\n?/g, '\n')
      // 折行：换行 + 可选的 "(pkgname)" 续行前缀 + 缩进 → 一个空格
      .replace(/\n[ \t]*(?:\([A-Za-z0-9 .@_-]{1,40}\))?[ \t]*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
  )
}

/**
 * 从编译日志里推断该用哪个编译器。
 * @param {string|Buffer} logText
 * @returns {'xelatex'|'lualatex'|null}
 */
function detectCompilerFromLog(logText) {
  if (!logText) {
    return null
  }
  const text = normalizeLogForMatching(logText)

  if (LUALATEX_SIGNATURES.some(re => re.test(text))) {
    return 'lualatex'
  }
  if (XELATEX_SIGNATURES.some(re => re.test(text))) {
    return 'xelatex'
  }
  return null
}

/**
 * 日志里只有「需要 XeTeX 或 LuaTeX」这类二义信号时，用源码再确认一次
 *
 * 例子：项目是 LuaLaTeX（用了 luacode/directlua），但先撞上 fontspec 的报错，
 * 日志只说 "requires either XeTeX or LuaTeX" → 只看日志会切到 xelatex，
 * 换完还是编不过。这时扫一眼 .tex 里的 Lua 特征就能纠正成 lualatex。
 *
 * @param {string} projectId
 * @returns {Promise<'xelatex'|'lualatex'|null>}
 */
async function detectCompilerFromProjectSources(projectId) {
  try {
    // 延迟 require：避免 Compile/Project/Docstore 之间的循环依赖
    const ProjectGetter = require('../Project/ProjectGetter')
    const DocstoreManager = require('../Docstore/DocstoreManager')
    const DocumentHelper = require('../Documents/DocumentHelper')

    const project = await ProjectGetter.promises.getProject(projectId, {
      rootFolder: 1,
      rootDoc_id: 1,
    })
    if (!project?.rootFolder) {
      return null
    }

    const MAX_DOCS = 30
    const MAX_CHARS_PER_DOC = 60000
    const rootDocId = project.rootDoc_id ? project.rootDoc_id.toString() : null

    // 收集文档：主文档排最前，其余按遍历顺序
    const docs = []
    const walk = folder => {
      if (!folder || docs.length >= MAX_DOCS) {
        return
      }
      for (const doc of folder.docs || []) {
        if (doc?._id) {
          docs.push(doc)
        }
      }
      for (const child of folder.folders || []) {
        walk(child)
      }
    }
    walk(project.rootFolder)

    docs.sort((a, b) => {
      const aRoot = a._id.toString() === rootDocId ? 0 : 1
      const bRoot = b._id.toString() === rootDocId ? 0 : 1
      return aRoot - bRoot
    })

    const contents = []
    for (const doc of docs.slice(0, MAX_DOCS)) {
      try {
        const data = await DocstoreManager.promises.getDoc(
          projectId.toString(),
          doc._id.toString()
        )
        if (Array.isArray(data?.lines)) {
          contents.push(data.lines.join('\n').slice(0, MAX_CHARS_PER_DOC))
        }
      } catch (err) {
        // 个别文档读不到不影响整体判断
      }
    }

    if (contents.length === 0) {
      return null
    }
    const compiler = DocumentHelper.getCompilerFromTexContents(contents)
    return compiler === 'lualatex' || compiler === 'xelatex' ? compiler : null
  } catch (err) {
    return null
  }
}

/**
 * 是否应该按探测结果切换。
 * @param {{ currentCompiler?: string, detectedCompiler?: string|null }}  }
 * @returns {boolean}
 */
function shouldSwitchCompiler({ currentCompiler, detectedCompiler }) {
  if (!detectedCompiler) {
    return false
  }
  const current = String(currentCompiler || '').toLowerCase()
  if (!SWITCHABLE_FROM.includes(current)) {
    return false
  }
  return current !== detectedCompiler
}

/**
 * 读取流并截断，避免超大日志吃内存。
 * @param {import('stream').Readable} stream
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
function readStreamCapped(stream, maxBytes = MAX_LOG_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    stream.on('data', chunk => {
      if (size >= maxBytes) {
        return
      }
      // 兼容字符串流（测试里用 Readable.from(['a','b'])），真实 CLSI 流是 Buffer
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      chunks.push(buf)
      size += buf.length
      if (size >= maxBytes) {
        stream.destroy()
      }
    })
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('close', () =>
      resolve(Buffer.concat(chunks).slice(0, maxBytes).toString('utf8'))
    )
    stream.on('error', reject)
  })
}

module.exports = {
  detectCompilerFromProjectSources,
  MAX_LOG_BYTES,
  LUALATEX_SIGNATURES,
  XELATEX_SIGNATURES,
  SWITCHABLE_FROM,
  normalizeLogForMatching,
  detectCompilerFromLog,
  shouldSwitchCompiler,
  readStreamCapped,
}
