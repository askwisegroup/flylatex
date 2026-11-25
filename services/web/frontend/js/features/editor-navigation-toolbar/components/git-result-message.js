/**
 * 把 /git/push 的返回结果翻译成「一句人话 + 语气」
 *
 * 服务端的返回约定（见 GitController.pushToGit）：
 *   { success, pushed, hasChanges, ahead, reason, httpStatus, error, lastCommit }
 *
 * 关键点：success=true 不等于「推上去了」。
 *   - success=true  + pushed=true               → 推送成功
 *   - success=true  + pushed=false(no_changes)  → 没有需要推送的改动
 *   - success=false + reason=permission_denied  → 远端没有写权限（最常见的开源仓库场景）
 *
 * reason 取值必须与 app/src/Features/Git/GitErrorUtil.js 的 REASONS 保持一致，
 * scripts/checks/git-info.check.js 会做静态比对。
 */

export const PUSH_REASON_KEYS = {
  // 正常结束
  no_changes: { key: 'git_nothing_to_push', tone: 'info' },
  up_to_date: { key: 'git_nothing_to_push', tone: 'info' },
  // 远端拒绝
  permission_denied: { key: 'git_push_no_push_permission', tone: 'error' },
  auth_failed: { key: 'git_push_auth_failed', tone: 'error' },
  branch_protected: { key: 'git_push_branch_protected', tone: 'error' },
  non_fast_forward: { key: 'git_push_needs_pull', tone: 'error' },
  repo_not_found: { key: 'git_push_repo_not_found', tone: 'error' },
  network: { key: 'git_push_network_error', tone: 'error' },
  hook_rejected: { key: 'git_push_hook_rejected', tone: 'error' },
  // 本地问题
  no_local_repository: { key: 'git_push_no_local_repo', tone: 'error' },
  internal_error: { key: 'git_push_failed', tone: 'error' },
  unknown: { key: 'git_push_failed', tone: 'error' },
}

const fallback = { key: 'git_push_failed', tone: 'error' }

/**
 * @param {Object} result - 接口返回
 * @param {Function} t - i18next 的 t
 * @returns {{text: string, tone: 'success'|'info'|'error', reason: string|null, pushed: boolean}}
 */
export function getPushResultMessage(result, t) {
  const reason = (result && result.reason) || null

  if (result && result.success) {
    if (result.pushed) {
      return {
        text: t('git_push_success'),
        tone: 'success',
        reason,
        pushed: true,
      }
    }
    return {
      text: t('git_nothing_to_push', 'Nothing to push — no local changes'),
      tone: 'info',
      reason: reason || 'no_changes',
      pushed: false,
    }
  }

  const conf = PUSH_REASON_KEYS[reason] || fallback
  const detail = result && result.error ? ` — ${result.error}` : ''
  return {
    text: `${t(conf.key, 'Push failed')}${detail}`,
    tone: conf.tone,
    reason,
    pushed: false,
  }
}

/**
 * Pull 结果 → 人话
 *
 * 拉取失败的原因和推送不同（见 GitErrorUtil.classifyPullError）：
 *   本地未提交改动 / 合并冲突 / 已分叉 / 认证失败 / 网络 / 仓库不存在
 * 其中前三种是「用户能自己解决」的，提示要给下一步动作。
 */
export const PULL_REASON_KEYS = {
  local_changes: { key: 'git_pull_local_changes', tone: 'error' },
  merge_conflict: { key: 'git_pull_merge_conflict', tone: 'error' },
  diverged: { key: 'git_pull_diverged', tone: 'error' },
  auth_failed: { key: 'git_pull_auth_failed', tone: 'error' },
  repo_not_found: { key: 'git_pull_repo_not_found', tone: 'error' },
  network: { key: 'git_pull_network_error', tone: 'error' },
}

/**
 * @param {Object} result - /git/pull 的返回
 * @param {Function} t - i18next 的 t
 * @returns {{text: string, tone: 'success'|'info'|'error', reason: string|null}}
 */
export function getPullResultMessage(result, t) {
  const reason = (result && result.reason) || null

  if (result && result.success) {
    return {
      text: t('git_pull_success', 'Pulled the latest changes'),
      tone: 'success',
      reason,
    }
  }

  const conf = PULL_REASON_KEYS[reason] || {
    key: 'git_pull_failed',
    tone: 'error',
  }
  const detail = result && result.error ? ` — ${result.error}` : ''
  return {
    text: `${t(conf.key, 'Pull failed')}${detail}`,
    tone: conf.tone,
    reason,
  }
}
