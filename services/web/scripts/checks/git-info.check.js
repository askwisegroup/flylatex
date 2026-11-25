/**
 * Git「仓库信息」弹窗的静态检查
 *
 * 三类事情，任何一条错了都只会在浏览器里表现为「弹窗空白 / 显示裸 key / token 泄露」，
 * 不跑一遍很难发现，所以钉成脚本：
 *
 *   1. 脱敏：仓库地址里的凭据绝不能明文出现在返回给前端的数据里
 *   2. 解析：git log / git status 的机器可读输出能被正确解析
 *   3. 接线：路由、控制器、i18n key 都在（少一个弹窗就是空白或裸 key）
 *
 * Run: cd services/web && node scripts/checks/git-info.check.js
 */

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '../..')
const GitUrlUtil = require(path.join(root, 'app/src/Features/Git/GitUrlUtil'))
const GitErrorUtil = require(path.join(
  root,
  'app/src/Features/Git/GitErrorUtil'
))
const DocumentHelper = require(path.join(
  root,
  'app/src/Features/Documents/DocumentHelper'
))

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${err.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

// ---------------------------------------------------------------
// 1. 凭据脱敏
// ---------------------------------------------------------------
const TOKEN = '{{SECRET_x9ks2hdf}}'

check('https 地址里的令牌被脱敏，末 4 位保留', () => {
  const parsed = GitUrlUtil.parseGitRemote(
    `https://oauth2:${TOKEN}@github.com/foo/bar.git`
  )
  assert(parsed.hasCredentials === true, 'hasCredentials 应为 true')
  assert(
    !parsed.maskedUrl.includes(TOKEN),
    `maskedUrl 仍包含明文令牌：${parsed.maskedUrl}`
  )
  assert(
    parsed.credentialMask.endsWith(TOKEN.slice(-4)),
    '脱敏串应保留末 4 位，便于用户确认是哪个令牌'
  )
  assert(parsed.provider === 'github', 'provider 应为 github')
  assert(
    parsed.webUrl === 'https://github.com/foo/bar',
    'webUrl 不应带凭据与 .git'
  )
})

check('query 参数里的 token 被脱敏且不被 URL 编码成乱码', () => {
  const parsed = GitUrlUtil.parseGitRemote(
    `https://github.com/foo/bar.git?access_token=${TOKEN}`
  )
  assert(!parsed.maskedUrl.includes(TOKEN), 'maskedUrl 仍包含明文 token')
  assert(!parsed.maskedUrl.includes('%E2%80%A2'), '脱敏圆点被 URL 编码了')
  assert(parsed.hasCredentials === true, 'hasCredentials 应为 true')
})

check('scp 语法不误判成凭据', () => {
  const parsed = GitUrlUtil.parseGitRemote('git@github.com:foo/bar.git')
  assert(parsed.hasCredentials === false, 'ssh 的 git@ 不是凭据')
  assert(parsed.protocol === 'ssh', 'protocol 应为 ssh')
  assert(parsed.provider === 'github', 'provider 应为 github')
})

check('无凭据地址原样保留', () => {
  const parsed = GitUrlUtil.parseGitRemote('https://gitee.com/foo/bar')
  assert(parsed.hasCredentials === false, 'hasCredentials 应为 false')
  assert(parsed.maskedUrl === 'https://gitee.com/foo/bar', '地址不应被改写')
})

check('Gitee / GitLab / 自建 GitLab 都能识别平台', () => {
  assert(
    GitUrlUtil.parseGitRemote('https://gitee.com/a/b.git').provider === 'gitee',
    'gitee 未识别'
  )
  assert(
    GitUrlUtil.parseGitRemote('https://gitlab.com/a/b.git').provider ===
      'gitlab',
    'gitlab 未识别'
  )
  assert(
    GitUrlUtil.parseGitRemote('https://gitlab.example.com/a/b.git').provider ===
      'gitlab',
    '自建 gitlab 未识别'
  )
  assert(
    GitUrlUtil.parseGitRemote('https://git.example.com/a/b.git').provider ===
      'other',
    '未知平台应为 other'
  )
})

// ---------------------------------------------------------------
// 2. git 输出解析
// ---------------------------------------------------------------
check('git log 解析出 hash / 作者 / 时间 / 标题', () => {
  const sep = '\u001f'
  const line = [
    'a'.repeat(40),
    'aaaaaaa',
    '张三',
    'z@example.com',
    '2026-01-02T03:04:05+08:00',
    'fix: 修正摘要换行',
  ].join(sep)
  const commits = GitUrlUtil.parseGitLog(line)
  assert(commits.length === 1, '应解析出 1 条提交')
  assert(commits[0].shortHash === 'aaaaaaa', '短 hash 不对')
  assert(commits[0].author === '张三', '作者不对')
  assert(commits[0].subject === 'fix: 修正摘要换行', '标题不对')
})

check('git log 最多返回 10 条', () => {
  const sep = '\u001f'
  const output = Array.from({ length: 25 })
    .map((v, i) =>
      [
        `${String(i).padStart(40, '0')}`,
        `c${i}`,
        'a',
        'a@b.c',
        '2026-01-01T00:00:00Z',
        `commit ${i}`,
      ].join(sep)
    )
    .join('\n')
  const commits = GitUrlUtil.parseGitLog(output)
  assert(commits.length === 10, `应只返回 10 条，实际 ${commits.length}`)
})

check('git status 被 trim 过（丢了前导空格）也不会截掉路径首字母', () => {
  // _execGit 会对 stdout 做 trim，" M main.tex" 会变成 "M main.tex"。
  // 之前按固定列 slice(3) 解析，路径会变成 "ain.tex"。
  const status = GitUrlUtil.parseGitStatus('M main.tex')
  assert(
    status.files[0].path === 'main.tex',
    `路径被截断：${status.files[0].path}`
  )
})

check('git status --porcelain 归类正确', () => {
  const status = GitUrlUtil.parseGitStatus(
    [' M main.tex', '?? new.tex', 'A  added.tex', ' D gone.tex'].join('\n')
  )
  assert(status.total === 4, `total 应为 4，实际 ${status.total}`)
  assert(status.untracked === 1, 'untracked 应为 1')
  assert(status.staged === 1, 'staged 应为 1')
  assert(status.deleted === 1, 'deleted 应为 1')
})

// ---------------------------------------------------------------
// 2.5 push 结果语义（不能把「没推」「没权限」当成成功）
// ---------------------------------------------------------------
check('push 失败原因归类：没有写权限 / 认证失败 / 分支保护 …', () => {
  const cases = [
    [
      'remote: Permission to foo/bar.git denied to someone.\nfatal: unable to access ... 403',
      'permission_denied',
    ],
    [
      'remote: You are not allowed to push code to this project.',
      'permission_denied',
    ],
    ['! [rejected] main -> main (fetch first)', 'non_fast_forward'],
    [
      'remote: error: GH006: Protected branch update failed',
      'branch_protected',
    ],
    [
      'fatal: Authentication failed for https://github.com/foo/bar.git/',
      'auth_failed',
    ],
    ['Permission denied (publickey).', 'auth_failed'],
    ['remote: Repository not found.', 'repo_not_found'],
    ['fatal: unable to access: Could not resolve host: github.com', 'network'],
    ['something totally unexpected', 'unknown'],
  ]
  for (const [message, expected] of cases) {
    const { reason } = GitErrorUtil.classifyPushError(message)
    assert(
      reason === expected,
      `${message.split('\n')[0]} → ${reason}，期望 ${expected}`
    )
  }
})

check('前端文案映射覆盖后端所有 reason', () => {
  const mappingSrc = fs.readFileSync(
    path.join(
      root,
      'frontend/js/features/editor-navigation-toolbar/components/git-result-message.js'
    ),
    'utf8'
  )
  const reasons = new Set()
  for (const match of mappingSrc.matchAll(/^  ([a-z_]+):\s*\{/gm)) {
    reasons.add(match[1])
  }
  const required = [
    ...GitErrorUtil.REASONS,
    'no_changes',
    'up_to_date',
    'no_local_repository',
    'internal_error',
  ]
  const missing = required.filter(reason => !reasons.has(reason))
  assert(
    missing.length === 0,
    `前端缺少这些 reason 的文案：${missing.join(', ')}`
  )

  // 映射里用到的 i18n key 必须四种语言都有
  const keys = new Set()
  for (const match of mappingSrc.matchAll(/key:\s*'([a-z_]+)'/g)) {
    keys.add(match[1])
  }
  keys.add('git_push_success')
  const missingKeys = []
  for (const lang of ['en', 'zh-CN', 'zh-TW', 'ru']) {
    const bundle = JSON.parse(
      fs.readFileSync(path.join(root, `locales/${lang}.json`), 'utf8')
    )
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(bundle, key)) {
        missingKeys.push(`${lang}: ${key}`)
      }
    }
  }
  assert(
    missingKeys.length === 0,
    `缺少翻译：\n      ${missingKeys.join('\n      ')}`
  )
})

check('push 输出能区分「真的推了」和「Everything up-to-date」', () => {
  assert(
    GitErrorUtil.parsePushOutput('Everything up-to-date').pushed === false,
    'Everything up-to-date 不应算推送成功'
  )
  assert(
    GitErrorUtil.parsePushOutput(
      'To github.com:a/b.git\n   abc..def  main -> main'
    ).pushed === true,
    '正常的 push 输出应算成功'
  )
})

// ---------------------------------------------------------------
// 2.6 编译器自动探测
// ---------------------------------------------------------------
check('LuaLaTeX 特征能探测出来', () => {
  const docs = [
    '\\documentclass{article}\n\\usepackage{luacode}\n\\begin{luacode}\nx=1\n\\end{luacode}',
    '\\documentclass{article}\n\\directlua{tex.print(1)}',
    '\\documentclass{book}\n\\usepackage{luatexja-fontspec}',
  ]
  for (const doc of docs) {
    assert(
      DocumentHelper.getCompilerFromTexContent(doc) === 'lualatex',
      `未识别为 lualatex：${doc.split('\n')[1]}`
    )
  }
})

check('XeLaTeX 特征能探测出来', () => {
  const docs = [
    '\\documentclass{article}\n\\usepackage{xeCJK}\n\\setCJKmainfont{Songti SC}',
    '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Times}',
    '\\documentclass{article}\n\\usepackage{unicode-math}',
  ]
  for (const doc of docs) {
    assert(
      DocumentHelper.getCompilerFromTexContent(doc) === 'xelatex',
      `未识别为 xelatex：${doc.split('\n')[1]}`
    )
  }
})

check('普通 pdflatex 文档不被误改', () => {
  const doc =
    '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}x\\end{document}'
  assert(
    DocumentHelper.getCompilerFromTexContent(doc) === null,
    '普通文档不应被判定成 xelatex/lualatex'
  )
})

check('子文件里的 Lua 特征也能探测到', () => {
  const compiler = DocumentHelper.getCompilerFromTexContents([
    '\\documentclass{article}\n\\begin{document}\\input{ch1}\\end{document}',
    '\\usepackage{luacode}\n\\directlua{print(1)}',
  ])
  assert(compiler === 'lualatex', `多文件探测失败：${compiler}`)
})

check('魔数注释优先于特征推断', () => {
  const doc =
    '% !TeX program = pdflatex\n\\documentclass{article}\n\\directlua{1}'
  assert(
    DocumentHelper.getCompilerFromTexContent(doc) === 'pdflatex',
    '% !TeX program 应当优先'
  )
})

check('导入路径都走 CompilerDetector（看全部 .tex，不只看主文档）', () => {
  const uploadSrc = fs.readFileSync(
    path.join(root, 'app/src/Features/Uploads/ProjectUploadManager.js'),
    'utf8'
  )
  assert(
    uploadSrc.includes('CompilerDetector.detectCompilerFromDirectory'),
    'zip 导入没有使用 CompilerDetector'
  )
  const gitControllerSrc = fs.readFileSync(
    path.join(root, 'app/src/Features/Git/GitController.js'),
    'utf8'
  )
  assert(
    gitControllerSrc.includes('CompilerDetector.detectCompilerFromDirectory'),
    'git 导入 / 拉取没有使用 CompilerDetector'
  )
})

// ---------------------------------------------------------------
// 3. 接线检查
// ---------------------------------------------------------------
const routerSrc = fs.readFileSync(
  path.join(root, 'app/src/Features/Git/GitRouter.js'),
  'utf8'
)
const controllerSrc = fs.readFileSync(
  path.join(root, 'app/src/Features/Git/GitController.js'),
  'utf8'
)
const serviceSrc = fs.readFileSync(
  path.join(root, 'app/src/Features/Git/GitService.js'),
  'utf8'
)
const modalSrc = fs.readFileSync(
  path.join(
    root,
    'frontend/js/features/editor-navigation-toolbar/components/git-info-modal.jsx'
  ),
  'utf8'
)
const buttonSrc = fs.readFileSync(
  path.join(
    root,
    'frontend/js/features/editor-navigation-toolbar/components/git-sync-button.jsx'
  ),
  'utf8'
)

check('路由 GET /project/:Project_id/git/info 已注册', () => {
  assert(
    routerSrc.includes("'/project/:Project_id/git/info'"),
    'GitRouter 里没有 /git/info 路由'
  )
  assert(
    routerSrc.includes('GitController.getGitInfo'),
    '路由没有指向 GitController.getGitInfo'
  )
})

check('控制器导出 getGitInfo 且返回脱敏字段', () => {
  assert(controllerSrc.includes('getGitInfo'), 'GitController 没有 getGitInfo')
  assert(
    controllerSrc.includes('canWrite'),
    '缺少 canWrite（前端用它判断只读）'
  )
})

check('服务层提供 getRepositoryInfo 且不回传明文地址', () => {
  assert(
    serviceSrc.includes('async getRepositoryInfo'),
    'GitService 没有 getRepositoryInfo'
  )
  // 只允许出现 maskedUrl / masked，不允许把 remote url 原样塞进返回值
  assert(
    !/url:\s*remoteUrl\b/.test(serviceSrc),
    'getRepositoryInfo 把明文 remoteUrl 直接返回了'
  )
})

check('Git 菜单里有「信息」入口', () => {
  assert(buttonSrc.includes('GitInfoModal'), 'Git 菜单没有引入 GitInfoModal')
  assert(buttonSrc.includes("t('git_info'"), 'Git 菜单没有「信息」按钮文案')
})

check('两处 Git 菜单（菜单栏下拉 / 顶栏 Git 面板）都有「信息」入口', () => {
  // 新人最容易漏的就是这里：同一个功能有两套 UI，
  // 只给 git-sync-button 加，菜单栏里那个下拉就没有「信息」。
  const toolbarSrc = fs.readFileSync(
    path.join(
      root,
      'frontend/js/features/editor-navigation-toolbar/components/toolbar-header.jsx'
    ),
    'utf8'
  )
  assert(
    toolbarSrc.includes('setShowGitInfo(true)'),
    '菜单栏 Git 下拉里没有「信息」菜单项'
  )
  assert(toolbarSrc.includes('<GitInfoModal'), '菜单栏没有渲染 GitInfoModal')
  assert(toolbarSrc.includes('GitInfoModal'), '菜单栏没有引入 GitInfoModal')
})

const gitI18nSources = () =>
  [
    'frontend/js/features/editor-navigation-toolbar/components/git-info-modal.jsx',
    'frontend/js/features/editor-navigation-toolbar/components/git-sync-button.jsx',
    'frontend/js/features/editor-navigation-toolbar/components/toolbar-header.jsx',
    'frontend/js/features/editor-navigation-toolbar/components/git-result-message.js',
    // 项目列表里的「已关联 Git」图标也用到 git_* 文案
    'frontend/js/features/project-list/components/table/project-list-table-row.tsx',
  ].map(rel => fs.readFileSync(path.join(root, rel), 'utf8'))

// 源码里出现的 git_* 字面量（t('…') 与映射表里的 key 都算）
const collectGitKeys = () => {
  const keys = new Set()
  for (const src of gitI18nSources()) {
    for (const match of src.matchAll(/'(git_[a-z0-9_]+)'/g)) keys.add(match[1])
  }
  return keys
}

const readLocale = lang =>
  JSON.parse(fs.readFileSync(path.join(root, `locales/${lang}.json`), 'utf8'))

check('所有 git 文案 key 都登记进了 extracted-translations.json', () => {
  // 这是最容易踩的坑：webpack 的 translations-loader 只把
  // extracted-translations.json 里列出的 key 打进语言包，
  // 没登记的 key 在浏览器里根本不存在 → t() 一律回落英文默认值，
  // 表现就是「中文界面里弹窗全是英文」。
  const extracted = JSON.parse(
    fs.readFileSync(
      path.join(root, 'frontend/extracted-translations.json'),
      'utf8'
    )
  )
  const en = readLocale('en')
  const keys = [...collectGitKeys()].filter(key =>
    Object.prototype.hasOwnProperty.call(en, key)
  )
  assert(keys.length > 40, `git 文案 key 数量异常：${keys.length}`)

  const missing = keys.filter(key => !(key in extracted))
  assert(
    missing.length === 0,
    `以下 key 没进打包白名单（浏览器里会被丢掉）：\n      ${missing.join(
      '\n      '
    )}`
  )
})

check('四种语言里的 git 文案都是真翻译（不是把 key 当值）', () => {
  // 之前这里只检查「key 存在」，于是 zh-CN 里写着 "git_info_title": "git_info_title"
  // 也能一路绿灯，界面上直接显示裸 key。
  const en = readLocale('en')
  const keys = [...collectGitKeys()].filter(key =>
    Object.prototype.hasOwnProperty.call(en, key)
  )
  const problems = []
  for (const lang of ['en', 'zh-CN', 'zh-TW', 'ru']) {
    const bundle = readLocale(lang)
    for (const key of keys) {
      if (!(key in bundle)) {
        problems.push(`${lang}: 缺少 ${key}`)
        continue
      }
      const value = bundle[key]
      if (!value || !value.trim()) problems.push(`${lang}: ${key} 为空`)
      else if (value === key) problems.push(`${lang}: ${key} 的值就是 key 本身`)
    }
  }
  assert(
    problems.length === 0,
    `翻译有问题：\n      ${problems.join('\n      ')}`
  )
})

check('繁体/俄文文案没有串味（不是简体或中文照抄）', () => {
  const cjk = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/
  const en = readLocale('en')
  const keys = [...collectGitKeys()].filter(key =>
    Object.prototype.hasOwnProperty.call(en, key)
  )
  const zhCN = readLocale('zh-CN')
  const zhTW = readLocale('zh-TW')
  const ru = readLocale('ru')

  // 俄文里出现汉字 = 复制粘贴串行
  const ruBad = keys.filter(key => cjk.test(ru[key] || ''))
  assert(ruBad.length === 0, `俄文里混进了中文：${ruBad.join(', ')}`)

  // 繁体与简体完全一致的长句 = 大概率忘了写繁体（短词如「分支」本就同形，放行）
  const twBad = keys.filter(key => {
    const a = zhCN[key] || ''
    const b = zhTW[key] || ''
    return a.length >= 8 && a === b
  })
  assert(twBad.length === 0, `繁体与简体完全相同：${twBad.join(', ')}`)
})

// ---------------------------------------------------------------- 令牌与同步操作
const readSrc = rel => fs.readFileSync(path.join(root, rel), 'utf8')

check('保存令牌的接口只写不读（响应里不含明文）', () => {
  const src = controllerSrc
  const start = src.indexOf('async function saveGitToken')
  assert(start !== -1, 'GitController 里没有 saveGitToken')
  const end = src.indexOf('\n}\n', start)
  const body = src.slice(start, end === -1 ? undefined : end)

  assert(
    /credentialMask/.test(body),
    'saveGitToken 没有返回脱敏后的 credentialMask'
  )
  assert(/hasToken/.test(body), 'saveGitToken 没有返回 hasToken')
  // 响应里绝不能把明文塞回去：不允许出现 token: <某个变量>
  const leak = body.match(/res\.json\(\{[\s\S]*?\}\)/g) || []
  for (const block of leak) {
    assert(
      !/\btoken:\s*(?!gitConfig\.token\s*\?)/.test(block),
      `saveGitToken 的响应里出现了明文 token：\n${block}`
    )
  }
})

check('令牌字段 select:false，用到它的查询都显式 +token', () => {
  const schema = readSrc('app/src/Features/Git/GitConfig.js')
  assert(
    /token:\s*\{[\s\S]{0,160}?select:\s*false/.test(schema),
    'GitConfig.token 没有设置 select:false（默认查询会带出明文令牌）'
  )

  // 需要令牌的四条路径：拉取、推送、信息、保存令牌。
  // 少一处 select('+token') 就会「令牌明明存了却提示没存」。
  const needsToken = [
    'async function pullFromGit',
    'async function pushToGit',
    'async function getGitInfo',
    'async function saveGitToken',
  ]
  for (const marker of needsToken) {
    const start = controllerSrc.indexOf(marker)
    assert(start !== -1, `GitController 里没有 ${marker}`)
    // 取到下一个顶层函数定义为止
    const rest = controllerSrc.slice(start + marker.length)
    const nextFn = rest.indexOf('\nasync function ')
    const body = nextFn === -1 ? rest : rest.slice(0, nextFn)
    assert(
      /\.select\('\+token'\)/.test(body),
      `${marker} 里的 findOne 没有 .select('+token')，读不到已保存的令牌`
    )
  }
})

check('拉取支持私有仓库令牌与 rebase 合并策略', () => {
  const src = serviceSrc
  assert(/'--rebase'/.test(src), 'pullChanges 不支持 --rebase')
  const pullStart = src.indexOf('async pullChanges')
  const body = src.slice(pullStart, src.indexOf('\n  }', pullStart) + 2000)
  assert(
    /_buildAuthUrl\(gitConfig\.url, token\)/.test(body),
    'pullChanges 没有用令牌构建认证 URL（私有仓库拉不下来）'
  )
  assert(
    /token = token \|\| \(gitConfig && gitConfig\.token\)/.test(body),
    'pullChanges 没有做令牌兜底'
  )
})

check('路由注册 PUT /project/:Project_id/git/token', () => {
  const src = routerSrc
  assert(
    /'\/project\/:Project_id\/git\/token'/.test(src),
    'GitRouter 没有注册令牌路由'
  )
  assert(/webRouter\.put\(/.test(src), '令牌路由应该是 PUT')
})

check('信息弹窗提供令牌 / 提交信息 / 提交并推送入口', () => {
  const src = modalSrc
  assert(src.includes('/git/token'), '弹窗不能保存令牌')
  assert(/\/git\/push/.test(src), '弹窗不能触发推送')
  assert(/runPull\(/.test(src), '弹窗不能触发拉取')
  assert(/commitMessage/.test(src), '弹窗没有提交信息输入框')
  assert(/sync\.diverged/.test(src), '分叉时没有「合并远端」入口')
})

check('推送/拉取失败会打开「信息」弹窗（补令牌的闭环）', () => {
  const src = readSrc(
    'frontend/js/features/editor-navigation-toolbar/components/toolbar-header.jsx'
  )
  assert(
    /setShowGitInfo\(true\)/.test(src),
    '菜单栏推送失败后没有引导用户去填令牌'
  )
  assert(
    /auth_failed/.test(src) && /permission_denied/.test(src),
    '只在认证/权限类失败时才应该打开弹窗'
  )
})

check('项目列表标出「已关联 Git 仓库」的项目', () => {
  const listSrc = readSrc('app/src/Features/Project/ProjectListController.js')
  assert(/_injectGitFlags/.test(listSrc), '项目列表没有注入 gitLinked 标记')
  assert(
    /\$in:\s*projects\.map/.test(listSrc),
    'gitLinked 应该用一次 $in 查询，否则每个项目各查一次'
  )

  const rowSrc = readSrc(
    'frontend/js/features/project-list/components/table/project-list-table-row.tsx'
  )
  assert(/gitLinked/.test(rowSrc), '项目列表行没有读取 gitLinked')
  assert(/fa fa-code-fork/.test(rowSrc), '项目列表行没有渲染分支图标')
  assert(/t\('git_linked_project'\)/.test(rowSrc), '图标缺少 i18n 提示文案')
})

check('所有写请求都带 CSRF token（线上 403 的真因）', () => {
  // 线上表现：POST /project/:id/git/pull 返回 403 Forbidden。
  // 不是 nginx 也不是权限白名单：webRouter 全局挂了 CSRF 中间件，只有 /ft-ai*
  // 这类接口 disableDefaultCsrfProtection。手写 fetch 只要漏了 X-CSRF-Token 就 403。
  const components = [
    'frontend/js/features/editor-navigation-toolbar/components/git-info-modal.jsx',
    'frontend/js/features/editor-navigation-toolbar/components/git-sync-button.jsx',
    'frontend/js/features/editor-navigation-toolbar/components/toolbar-header.jsx',
  ]
  // 服务端显式免检 CSRF 的路由（Server.js / router.js 里的 disableDefaultCsrfProtection）
  const exempt = []
  for (const rel of ['app/src/infrastructure/Server.js', 'app/src/router.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const m of src.matchAll(
      /disableDefaultCsrfProtection\(\s*'([^']+)'/g
    )) {
      exempt.push(m[1])
    }
  }

  const offenders = []
  for (const rel of components) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    // 把文件里的路径常量展开，否则拿到的是 FETCH_AI_BASE 这种标识符
    const constants = {}
    for (const m of src.matchAll(/const ([A-Z][A-Z0-9_]*) = '([^']+)'/g)) {
      constants[m[1]] = m[2]
    }
    const blocks = src.split(/fetch\(/)
    for (let i = 1; i < blocks.length; i++) {
      // 只看带 method 的调用（GET 不需要 CSRF）；往后再看一段，够覆盖 headers 块
      const window = blocks[i].slice(0, 600)
      if (!/method:/.test(window)) continue
      if (/X-CSRF-Token/.test(window)) continue
      const target = window.split(',')[0].trim()
      const resolved = constants[target] || target
      if (exempt.some(prefix => resolved.includes(prefix))) continue
      offenders.push(`${rel}: ${window.replace(/\s+/g, ' ').slice(0, 60)}…`)
    }
  }
  assert(
    offenders.length === 0,
    `这些写请求漏了 X-CSRF-Token（会 403）：\n    ${offenders.join('\n    ')}`
  )
})

check('弹窗发出的 POST/PUT 统一走 send()（一处加头，处处生效）', () => {
  const modal = fs.readFileSync(
    path.join(
      root,
      'frontend/js/features/editor-navigation-toolbar/components/git-info-modal.jsx'
    ),
    'utf8'
  )
  const sendBlock = modal.slice(
    modal.indexOf('const send = useCallback'),
    modal.indexOf('const send = useCallback') + 900
  )
  assert(
    /X-CSRF-Token': getMeta\('ol-csrfToken'\)/.test(sendBlock),
    'send() 里没有 X-CSRF-Token'
  )
  assert(/credentials: 'include'/.test(sendBlock), 'send() 里没有带上 cookie')
  // 业务代码里不应再有裸 fetch 写请求
  const directWrites = modal
    .split(/fetch\(/)
    .slice(1)
    .filter(chunk => /method:/.test(chunk.slice(0, 200)))
  assert(
    directWrites.length === 0,
    `弹窗里还有绕过 send() 的写请求：${directWrites.length} 处`
  )
})

check('403 给出可操作的提示，而不是裸状态码', () => {
  const key = ['git_info_http', '403'].join('_')
  const modal = fs.readFileSync(
    path.join(
      root,
      'frontend/js/features/editor-navigation-toolbar/components/git-info-modal.jsx'
    ),
    'utf8'
  )
  assert(/response.status === 403/.test(modal), '没有专门处理 403')
  assert(modal.includes(key), '403 提示没有走 i18n')

  const whitelist = JSON.parse(
    fs.readFileSync(
      path.join(root, 'frontend/extracted-translations.json'),
      'utf8'
    )
  )
  assert(
    key in whitelist,
    `${key} 没登记进 extracted-translations.json（不会被打包）`
  )

  for (const lang of ['en', 'zh-CN', 'zh-TW', 'ru']) {
    const locale = JSON.parse(
      fs.readFileSync(path.join(root, `locales/${lang}.json`), 'utf8')
    )
    assert(
      typeof locale[key] === 'string' &&
        locale[key].trim() !== '' &&
        locale[key] !== key,
      `${lang}.json 缺少 ${key} 的真实翻译`
    )
  }
})

check('弹窗配色不写死颜色（多主题前提）', () => {
  // 允许 var(--fl-xxx, #fff) 里的兜底色，但裸 hex 一律不允许：
  // 否则亮色/柔和主题下就会出现「深色卡片上写死白底」这类问题。
  const withoutFallbacks = modalSrc.replace(
    /var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,6}\s*\)/g,
    'var(TOKEN)'
  )
  const hexColors = withoutFallbacks.match(/#[0-9a-fA-F]{3,6}/g) || []
  assert(
    hexColors.length === 0,
    `弹窗里出现写死的颜色：${[...new Set(hexColors)].join(', ')}`
  )
})

console.log('')
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}): ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('ALL PASS')
