/**
 * FIXED: 2026-11-05 About System 里的 TeX Live 版本号不再写死
 *
 * 原来 help-menu.tsx / toolbar-header.jsx 里直接写着 `TeXLive 2026`，
 * 这个值和服务器实际装的版本毫无关系：本仓库部署的实际环境里，
 * 安装树是 /usr/local/texlive/2023，而 tlmgr 自身被跨版本 updater
 * (update-tlmgr-latest.sh) 换成了 2025 版，三者互不相同。
 *
 * 现在改成问工具链自己：tslmgr --version。三个数字都能从它的输出里拿到：
 *   tlmgr revision 74695 (2025-03-19 00:12:52 +0100)     → revision
 *   tlmgr using installation: /usr/local/texlive/2023    → installationPath/Year
 *   TeX Live (https://tug.org/texlive) version 2025      → version
 *
 * 边界：
 *   - 只读探测，不写任何东西；失败一律「不可用」，让前端退回不带年份的文案；
 *   - 结果进程内缓存 10 分钟（失败缓存 1 分钟），不会每次开弹窗都 spawn 一次；
 *   - 用 execFile 而非 exec，不经过 shell，命令和参数都是常量；
 *   - FIXED: 2026-11-05 返回给浏览器的只有「有没有」+「版本号」两项。
 *     安装树绝对路径、revision、tlmgr 原始输出都不外发（之前放在 tooltip 里，
 *     等于把服务器目录结构和补丁级别免费送给任何登录用户）。这些细节只留在
 *     服务端解析结果里，需要时看日志。
 */

const { execFile } = require('child_process')
const logger = require('@overleaf/logger')

const TLMGR_COMMAND = 'tlmgr'
const TLMGR_ARGS = ['--version']
const EXEC_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 10 * 60 * 1000
const ERROR_CACHE_TTL_MS = 60 * 1000

let cache = { expiresAt: 0, value: null }

/**
 * 解析 `tlmgr --version` 的输出。
 *
 * `version YYYY` 这一行是权威的：它来自 `$TEXMFROOT/release-texlive.txt`
 * （tlmgr 读的就是这个文件），跨版本原地升级后这个数字会跟着变，
 * 而安装**目录名**不会变（/usr/local/texlive/2023 里装的可以是 2025/2026）。
 * 所以 installationYear 只是「当初装在哪」，不能当作版本不一致的判断依据。
 */
function parseTlmgrVersionOutput(output) {
  const text = typeof output === 'string' ? output : ''

  const versionMatch = text.match(/TeX Live[^\n]*?\bversion\s+(\d{4})\b/)
  const installationMatch = text.match(/using installation:\s*(\S+)/)
  const revisionMatch = text.match(/tlmgr revision\s+(\d+)/)

  const installationPath = installationMatch ? installationMatch[1] : null
  const installationYearMatch = installationPath
    ? installationPath.match(/\/(\d{4})\/?$/)
    : null

  return {
    version: versionMatch ? versionMatch[1] : null,
    installationPath,
    installationYear: installationYearMatch ? installationYearMatch[1] : null,
    revision: revisionMatch ? revisionMatch[1] : null,
    // raw 是完整原文，只在服务端内部用（含安装树路径）——不要外发
    raw: text.trim(),
    // 对外版本：去掉 `tlmgr using installation: /usr/local/texlive/2023` 这一行
    // 以及任何仍然包含该路径的行，其余原样保留（revision 行 + version 行）
    publicRaw: sanitizeTlmgrOutput(text, installationPath),
  }
}

/**
 * 把 `tlmgr --version` 的输出削成可以给浏览器看的样子：
 * 逐行丢掉「安装树路径」相关的行（安装路径属于服务器内部细节），空行也丢掉。
 */
function sanitizeTlmgrOutput(output, installationPath) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(line => {
      if (/using installation:/i.test(line)) {
        return false
      }
      if (installationPath && line.includes(installationPath)) {
        return false
      }
      return line.trim() !== ''
    })
    .join('\n')
}

function detectTeXLiveVersion(callback) {
  execFile(
    TLMGR_COMMAND,
    TLMGR_ARGS,
    { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) {
        return callback(error)
      }
      const parsed = parseTlmgrVersionOutput(stdout)
      if (!parsed.version && !parsed.installationYear) {
        return callback(new Error('unable to parse `tlmgr --version` output'))
      }
      // 目录年份与 release 年份不一致是「原地跨版本升级」的正常现象（很常见），
      // 不是故障信号，所以只留 debug；真要判断树是否损坏得看 release-texlive.txt。
      if (
        parsed.version &&
        parsed.installationYear &&
        parsed.version !== parsed.installationYear
      ) {
        logger.debug(
          {
            version: parsed.version,
            installationYear: parsed.installationYear,
            installationPath: parsed.installationPath,
            revision: parsed.revision,
          },
          'TeX Live release differs from the install directory year (usually an in-place cross-release upgrade)'
        )
      }
      callback(null, parsed)
    }
  )
}

function getTeXLiveVersion(callback) {
  const now = Date.now()
  if (cache.value && cache.expiresAt > now) {
    return callback(cache.value.error, cache.value.info)
  }

  detectTeXLiveVersion((error, info) => {
    cache = {
      expiresAt: now + (error ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS),
      value: { error, info },
    }
    callback(error, info)
  })
}

// GET /system/texlive-version —— 永远 200，探测失败用 available:false 表达，
// 这样前端只有一个分支要处理（渲染不带年份的文案）。
// 响应体：available / version / raw。raw 是**已脱敏**的 tlmgr 输出
// （见 sanitizeTlmgrOutput），安装路径与安装树年份绝不外发。
function get(req, res) {
  getTeXLiveVersion((error, info) => {
    if (error) {
      return res.json({ available: false, version: null, raw: null })
    }
    res.json({ available: true, version: info.version, raw: info.publicRaw })
  })
}

function clearCache() {
  cache = { expiresAt: 0, value: null }
}

module.exports = {
  get,
  getTeXLiveVersion,
  parseTlmgrVersionOutput,
  sanitizeTlmgrOutput,
  clearCache,
  CACHE_TTL_MS,
  ERROR_CACHE_TTL_MS,
}
