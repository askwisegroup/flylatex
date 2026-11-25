/**
 * GitUrlUtil - 纯函数工具集（无依赖，便于单独测试）
 *
 * 只做三件事：
 *   1. 把仓库地址里的凭据脱敏（前端「仓库信息」弹窗要显示地址，绝不能吐出明文 token）
 *   2. 把地址拆成 host / path / webUrl / provider，便于展示与点击跳转
 *   3. 解析 git log / git status 的机器可读输出
 *
 * 之所以单独抽一个文件：GitService 依赖 @overleaf/settings、child_process 等，
 * 在测试里不好直接 require；这里没有任何依赖，可以直接单测。
 */

// 占位符用「圆点 + 末 4 位」，与常见托管平台的显示习惯一致
const MASK_CHAR = '•'
const MASK_KEEP_TAIL = 4

/**
 * 脱敏单个密钥
 * @param {string} secret
 * @returns {string} 形如 ••••••3f9a；太短时全遮
 */
function maskSecret(secret) {
  if (!secret) {
    return ''
  }
  const value = String(secret)
  if (value.length <= MASK_KEEP_TAIL) {
    return MASK_CHAR.repeat(Math.max(value.length, 3))
  }
  return MASK_CHAR.repeat(6) + value.slice(-MASK_KEEP_TAIL)
}

// URL 里、query 里常见的密钥参数名（命中即脱敏）
const SECRET_QUERY_KEYS = [
  'access_token',
  'auth_token',
  'private_token',
  'token',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
]

/**
 * 解析并脱敏 Git 仓库地址
 *
 * 支持：
 *   https://oauth2:{{PASSWORD_zz8cqm2u}}@github.com/a/b.git
 *   https://user:pass@gitlab.example.com/group/repo.git
 *   https://github.com/a/b.git?access_token=xxx
 *   git@github.com:a/b.git          （scp 语法，无凭据）
 *   /local/path/repo.git
 *
 * @param {string} rawUrl
 * @returns {{
 *   url: string, maskedUrl: string, hasCredentials: boolean,
 *   username: string|null, credentialMask: string|null,
 *   protocol: string, host: string, path: string, webUrl: string,
 *   provider: string
 * }}
 */
function parseGitRemote(rawUrl) {
  const empty = {
    url: '',
    maskedUrl: '',
    hasCredentials: false,
    username: null,
    credentialMask: null,
    protocol: '',
    host: '',
    path: '',
    webUrl: '',
    provider: 'other',
  }

  if (!rawUrl || typeof rawUrl !== 'string') {
    return empty
  }

  const url = rawUrl.trim()
  let protocol = ''
  let host = ''
  let path = ''
  let username = null
  let credentialMask = null
  let hasCredentials = false
  let maskedUrl = url

  // 1) scp 语法：git@host:path（不是标准 URL，直接手工拆）
  const scpMatch = url.match(/^(?:([^@/]+)@)?([^:/]+):(.+)$/)
  const isStandardUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)

  if (!isStandardUrl && scpMatch) {
    username = scpMatch[1] || null
    host = scpMatch[2]
    path = scpMatch[3]
    protocol = 'ssh'
    // ssh 用户名不是密钥，原样保留
  } else if (isStandardUrl) {
    try {
      const urlObj = new URL(url)
      protocol = urlObj.protocol.replace(':', '')
      host = urlObj.hostname
      path = decodeURIComponent(urlObj.pathname.replace(/^\//, ''))
      username = urlObj.username ? decodeURIComponent(urlObj.username) : null

      if (urlObj.password) {
        hasCredentials = true
        credentialMask = maskSecret(decodeURIComponent(urlObj.password))
      }
      // 用户名里带 token 的情况（x-access-token:xxx 已在 password 分支处理；
      // 少数平台把 token 直接当用户名：https://<token>@host/repo.git）
      if (!urlObj.password && urlObj.username && urlObj.username.length >= 20) {
        hasCredentials = true
        credentialMask = maskSecret(decodeURIComponent(urlObj.username))
      }

      // query 参数里的 token
      for (const key of SECRET_QUERY_KEYS) {
        const value = urlObj.searchParams.get(key)
        if (value) {
          hasCredentials = true
          if (!credentialMask) {
            credentialMask = maskSecret(value)
          }
          urlObj.searchParams.set(key, credentialMask)
        }
      }

      if (urlObj.password) {
        urlObj.password = credentialMask
      }
      if (urlObj.username && urlObj.password) {
        // 用户名本身也不算秘密，但用户名就是 token 时同样要遮
        urlObj.username =
          username && username.length >= 20 ? credentialMask : username
      }
      maskedUrl = urlObj.toString()
      // URL 序列化会把圆点编码成 %E2%80%A2，脱敏串看着像乱码，这里还原回来
      maskedUrl = maskedUrl.replace(/%E2%80%A2/g, MASK_CHAR)
    } catch (error) {
      // URL 解析失败（极少见），退化成正则脱敏
      maskedUrl = maskCredentialsByRegex(url)
      hasCredentials = maskedUrl !== url
      credentialMask = hasCredentials ? maskSecret('') : null
      const hostMatch = url.match(/^[a-zA-Z]+:\/\/([^/]+)/)
      host = hostMatch ? hostMatch[1].replace(/^[^@]*@/, '') : ''
      protocol = (url.match(/^([a-zA-Z]+):\/\//) || [])[1] || ''
    }
  } else {
    // 本地路径
    path = url
  }

  // scp 语法同样可能带 token（形如 https 之外的写法较少见），统一再兜一次
  if (!isStandardUrl && scpMatch) {
    maskedUrl = url
  }

  const webUrl = buildWebUrl({
    protocol,
    host,
    path,
    hasCredentials,
    maskedUrl,
  })
  const provider = detectProvider(host)

  return {
    url,
    maskedUrl: maskCredentialsByRegex(maskedUrl),
    hasCredentials,
    username,
    credentialMask,
    protocol,
    host,
    path,
    webUrl,
    provider,
  }
}

/**
 * 正则兜底脱敏：//user:pass@host —— 保留用户名，密码整体替换
 */
function maskCredentialsByRegex(url) {
  if (!url) {
    return ''
  }
  return String(url).replace(
    /(\/\/[^/@:\s]+:)([^@/\s]+)(@)/g,
    (match, head, secret, tail) => head + maskSecret(secret) + tail
  )
}

/**
 * 生成可直接在浏览器打开的仓库地址（去掉凭据与 .git 后缀）
 */
function buildWebUrl({ protocol, host, path, hasCredentials }) {
  if (!host || !path) {
    return ''
  }
  const cleanPath = String(path).replace(/\.git$/, '')
  const scheme = protocol === 'http' ? 'http' : 'https'
  if (protocol === 'ssh' || protocol === 'git') {
    // ssh / scp 语法也拼一个 https 页面地址，方便点开
    return `https://${host}/${cleanPath}`
  }
  return `${scheme}://${host}/${cleanPath}`
}

/**
 * 根据 host 识别托管平台（仅用于展示）
 */
function detectProvider(host) {
  const value = (host || '').toLowerCase()
  if (!value) {
    return 'other'
  }
  if (value === 'github.com' || value.endsWith('.github.com')) {
    return 'github'
  }
  if (value === 'gitee.com' || value.endsWith('.gitee.com')) {
    return 'gitee'
  }
  if (value === 'gitlab.com' || value.endsWith('.gitlab.com')) {
    return 'gitlab'
  }
  if (value.includes('gitlab')) {
    return 'gitlab'
  }
  if (value === 'bitbucket.org' || value.endsWith('.bitbucket.org')) {
    return 'bitbucket'
  }
  if (value === 'codeberg.org') {
    return 'codeberg'
  }
  return 'other'
}

// git log --format 用的分隔符（\x1f 不会出现在提交信息里）
const LOG_FIELD_SEP = '\u001f'
const LOG_FORMAT = [
  '%H', // 完整 hash
  '%h', // 短 hash
  '%an', // 作者名
  '%ae', // 作者邮箱
  '%aI', // ISO 时间
  '%s', // 标题
].join('%x1f')

/**
 * 解析 git log 输出
 * @param {string} stdout
 * @param {number} limit
 * @returns {Array<Object>}
 */
function parseGitLog(stdout, limit = 10) {
  if (!stdout) {
    return []
  }
  return String(stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map(line => {
      const [hash, shortHash, author, email, date, subject] =
        line.split(LOG_FIELD_SEP)
      return {
        hash: hash || '',
        shortHash: shortHash || (hash || '').slice(0, 7),
        author: author || '',
        email: email || '',
        date: date || '',
        subject: subject || '',
      }
    })
}

/**
 * 解析 git status --porcelain=v1，按状态归类
 * @param {string} stdout
 * @returns {{total:number, files:Array<{status:string,path:string}>, untracked:number, modified:number, staged:number, deleted:number}}
 */
function parseGitStatus(stdout) {
  const result = {
    total: 0,
    files: [],
    untracked: 0,
    modified: 0,
    staged: 0,
    deleted: 0,
  }
  if (!stdout) {
    return result
  }

  const lines = String(stdout)
    .split('\n')
    .filter(line => line.trim().length > 0)

  for (const line of lines) {
    // 注意：git status --porcelain 的格式是固定的 "XY <path>"，
    // 但调用方 _execGit 会对 stdout 做 trim()，把 XY 前那个「索引未修改」
    // 的空格吃掉（" M main.tex" → "M main.tex"）。
    // 所以这里不能死按固定列切，要用正则兜住「被 trim 过」的情况，
    // 否则路径会少一个字符（main.tex → ain.tex）。
    const match = line.match(/^([ MADRCU?!]{1,2})\s+(.+)$/)
    let indexStatus
    let workTreeStatus
    let filePath
    if (match) {
      const code = match[1]
      filePath = match[2].trim()
      indexStatus = code[0]
      workTreeStatus = code[1] || ' '
    } else {
      indexStatus = line[0]
      workTreeStatus = line[1] || ' '
      filePath = line.slice(2).replace(/^\s+/, '')
    }
    result.total++

    if (indexStatus === '?' || workTreeStatus === '?') {
      result.untracked++
      result.files.push({ status: 'untracked', path: filePath })
      continue
    }
    if (indexStatus === 'D' || workTreeStatus === 'D') {
      result.deleted++
    }
    if (indexStatus !== ' ' && indexStatus !== '?') {
      result.staged++
    }
    if (workTreeStatus === 'M' || workTreeStatus === 'A') {
      result.modified++
    }
    result.files.push({
      status: `${indexStatus}${workTreeStatus}`.trim() || '?',
      path: filePath,
    })
  }

  return result
}

module.exports = {
  LOG_FORMAT,
  LOG_FIELD_SEP,
  maskSecret,
  maskCredentialsByRegex,
  parseGitRemote,
  buildWebUrl,
  detectProvider,
  parseGitLog,
  parseGitStatus,
}
