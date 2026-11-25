/**
 * GitErrorUtil - 把 git 的 stderr 归成前端能说人话的原因
 *
 * 背景：开源仓库很常见的一种情况是「能读不能写」——HTTPS 拉取没问题，
 * push 时远端直接拒绝（403 / protected branch / 没有写权限）。
 * 这些都发生在 git 子进程的 stderr 里，直接抛给用户只会看到
 * `Git command failed with exit code 128: remote: Permission to ...`。
 *
 * 所以这里做两件事：
 *   1. 归一化原因（reason），前端据此给出具体提示
 *   2. 保留原始 stderr 的「关键一行」作为 detail，方便排查
 *
 * 纯函数、无依赖，便于单测。
 */

// reason 取值（前端 git-result-message 里一一对应，改动请同步）
const REASONS = [
  'permission_denied', // 没有远端写权限（最常见的「开源仓库但不是协作者」）
  'auth_failed', // 认证失败 / 令牌无效或过期
  'branch_protected', // 分支保护，需要走 PR
  'non_fast_forward', // 远端有新提交，需要先拉取
  'local_changes', // 本地有未提交改动，拉取/切换会被覆盖
  'merge_conflict', // 合并出现冲突，需要人工解决
  'diverged', // 本地与远端分叉，需要 merge / rebase
  'repo_not_found', // 仓库不存在 / 地址错 / 无读取权限
  'network', // 网络、DNS、超时
  'hook_rejected', // 远端 hook 拒绝（体积超限、提交信息不合规等）
  'unknown',
]

const RULES = [
  {
    reason: 'branch_protected',
    patterns: [
      /protected branch/i,
      /GH006/i, // GitHub: Protected branch update failed
      /pre-receive hook declined/i,
      /push to (?:the )?protected/i,
      /not allowed to push to (?:a )?protected/i,
    ],
  },
  {
    reason: 'permission_denied',
    patterns: [
      /permission to .+ denied/i, // remote: Permission to user/repo.git denied to xxx
      /\b403\b/, // The requested URL returned error: 403
      /access denied/i,
      /read-only/i,
      /write access (?:to|is not)/i,
      /not authorized to push/i,
      /(?:are|is) not allowed to push/i,
      /you (?:can|cannot|can’t|can't) push/i,
      /push (?:access|rights) (?:denied|required)/i,
      /must have (?:push|write) (?:access|permission)/i,
      /you (?:are|do) not have (?:push )?permission/i,
      /insufficient permission/i,
      /cannot push/i,
      /denied to .+/i,
      /GH013/i, // Repository rule violations / cannot push
      /without push permission/i,
    ],
  },
  {
    // pull 专属：本地改动会被覆盖（"Your local changes to the following files
    // would be overwritten by merge"）——这是「先提交/撤销再拉」的情形，
    // 不要归到 non_fast_forward，否则用户会以为要先 pull。
    reason: 'local_changes',
    patterns: [
      /your local changes to the following files/i,
      /commit your changes or stash them/i,
      /would be overwritten by (?:merge|checkout|pull)/i,
    ],
  },
  {
    reason: 'merge_conflict',
    patterns: [
      /CONFLICT \(content\)/,
      /automatic merge failed/i,
      /could not apply .*\.\.\./i,
      /fix conflicts and then commit/i,
      /needs merge/i,
    ],
  },
  {
    reason: 'non_fast_forward',
    patterns: [
      /non-fast-forward/i,
      /fetch first/i,
      /updates were rejected/i,
      /\[rejected\].*\(fetch first\)/i,
      /not possible to fast-forward/i,
      // Git 2.33+ 默认不再自动选择合并方式：
      // hint: You have divergent branches and need to specify how to reconcile them.
      /divergent branches and need to specify/i,
      /need to specify how to reconcile divergent branches/i,
    ],
  },
  {
    reason: 'auth_failed',
    patterns: [
      /authentication failed/i,
      /permission denied \(publickey/i, // SSH 密钥不对，是认证问题而非权限问题
      /invalid (?:username|credentials|token)/i,
      /could not read (?:username|password)/i,
      /terminal prompts disabled/i,
      /\b401\b/,
      /support for password authentication was removed/i,
      /bad credentials/i,
      /access token.*(?:expired|invalid)/i,
    ],
  },
  {
    reason: 'repo_not_found',
    patterns: [
      /repository .*not found/i,
      /\b404\b/,
      /does not appear to be a git repository/i,
      /could not read from remote repository/i,
      /not a git repository/i,
    ],
  },
  {
    reason: 'network',
    patterns: [
      /could not resolve host/i,
      /connection (?:timed out|refused|reset)/i,
      /network is unreachable/i,
      /operation timed out/i,
      /ssl certificate problem/i,
      /temporary failure in name resolution/i,
    ],
  },
  {
    reason: 'hook_rejected',
    patterns: [
      /remote rejected/i,
      /hook declined/i,
      /push declined due to repository rule/i,
    ],
  },
]

/**
 * 从 stderr / 错误信息里挑出最有信息量的一行
 * （git 的输出常常是好几行，真正的原因通常带 remote: 或 error: 前缀）
 */
function extractDetail(rawMessage) {
  if (!rawMessage) {
    return ''
  }
  const lines = String(rawMessage)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^hint:/i.test(line))
  const preferred =
    lines.find(line => /^remote:/i.test(line)) ||
    lines.find(line => /^(?:error|fatal):/i.test(line)) ||
    lines.find(line => /denied|forbidden|403|401|protected/i.test(line)) ||
    lines[0] ||
    ''
  // 去掉 remote: / error: / fatal: 前缀，保留正文
  return preferred
    .replace(/^(?:remote|error|fatal|warning):\s*/i, '')
    .slice(0, 300)
}

/**
 * 归类 push 失败原因
 * @param {string} rawMessage - stderr 或错误 message
 * @returns {{reason:string, detail:string, httpStatus:number|null}}
 */
function classifyPushError(rawMessage) {
  const message = String(rawMessage || '')
  let reason = 'unknown'

  for (const rule of RULES) {
    if (rule.patterns.some(pattern => pattern.test(message))) {
      reason = rule.reason
      break
    }
  }

  const statusMatch = message.match(/\b(401|403|404)\b/)
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null

  // 403 但没命中任何更具体的规则时，仍然是「没写权限」
  if (reason === 'unknown' && httpStatus === 403) {
    reason = 'permission_denied'
  }
  if (reason === 'unknown' && httpStatus === 401) {
    reason = 'auth_failed'
  }
  if (reason === 'unknown' && httpStatus === 404) {
    reason = 'repo_not_found'
  }

  return { reason, detail: extractDetail(message), httpStatus }
}

/**
 * 归类 pull 失败原因（目前只区分认证 / 网络 / 不存在，够用即可）
 */
function classifyPullError(rawMessage) {
  const { reason, detail, httpStatus } = classifyPushError(rawMessage)
  if (reason === 'permission_denied') {
    // 拉取失败时 403 一般是「没有读权限」或令牌权限不足
    return { reason: 'auth_failed', detail, httpStatus }
  }
  if (reason === 'branch_protected') {
    // 拉取不存在「分支保护」这种拒绝
    return { reason: 'unknown', detail, httpStatus }
  }
  if (reason === 'non_fast_forward') {
    // 拉取时的 non-fast-forward = 已经分叉，需要 merge / rebase
    return { reason: 'diverged', detail, httpStatus }
  }
  return { reason, detail, httpStatus }
}

/**
 * push 的输出里判断是否真的推了东西
 */
function parsePushOutput(stdout) {
  const output = String(stdout || '')
  if (/everything up-to-date/i.test(output)) {
    return { pushed: false, reason: 'up_to_date' }
  }
  return { pushed: true, reason: 'pushed' }
}

module.exports = {
  REASONS,
  classifyPushError,
  classifyPullError,
  parsePushOutput,
  extractDetail,
}
