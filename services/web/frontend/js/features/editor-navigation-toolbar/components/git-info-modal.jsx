import { useCallback, useEffect, useState } from 'react'
import { Modal } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import getMeta from '../../../utils/meta'
import AccessibleModal from '../../../shared/components/accessible-modal'
import Icon from '../../../shared/components/icon'
import {
  getPullResultMessage,
  getPushResultMessage,
} from './git-result-message'

/**
 * Git 仓库信息弹窗（编辑器顶栏 Git 菜单里的「信息」）
 *
 * 设计约束：
 *  1. 配色只取 var(--fl-*)，默认 / 亮色 / 柔和三套主题各有一份定义，
 *     所以这里不写死任何颜色，也不新增 less 依赖（改颜色不用重新构建样式）。
 *  2. 文案全部走 i18n，未翻译的语言回落到英文缺省值，不显示裸 key。
 *  4. 服务端已经脱敏过凭据，前端只负责展示，绝不拼接完整 URL。
 *
 * FIXED: 2026-11 这个弹窗从「只读展示」升级成「操作入口」，原因是一个真实的操作悖论：
 *   公开仓库匿名即可 clone / pull → 用户不需要令牌；
 *   改完要 push 时才发现需要令牌，而菜单里只有「拉取 / 推送」两个按钮，
 *   没有任何地方可以填令牌；顺序上又必须先 commit（推送前要有提交信息）。
 * 所以这里补三件事，都只在有写权限时出现：
 *   - 令牌：填写 / 更换 / 清除（只写不读，服务端只回末 4 位）
 *   - 提交信息 + 一键「提交并推送」
 *   - 分叉时「合并远端（rebase）」，以及本地有未提交改动时的明确提示
 */

const PROVIDER_LABEL = {
  github: 'GitHub',
  gitee: 'Gitee',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  codeberg: 'Codeberg',
  other: 'Git',
}

const styles = {
  body: {
    color: 'var(--fl-text, #333)',
    fontSize: 13,
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    margin: '0 0 8px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '.02em',
    textTransform: 'uppercase',
    color: 'var(--fl-text-subtle, #999)',
  },
  pills: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 16,
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 9px',
    borderRadius: 999,
    fontSize: 12,
    lineHeight: 1.6,
    border: '1px solid',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '10px 20px',
    padding: '12px 14px',
    borderRadius: 6,
    background: 'var(--fl-surface-raised, #f5f5f5)',
    border: '1px solid var(--fl-border, #ddd)',
  },
  field: {
    minWidth: 0,
  },
  fieldLabel: {
    fontSize: 11.5,
    color: 'var(--fl-text-subtle, #999)',
    marginBottom: 2,
  },
  fieldValue: {
    fontSize: 13,
    color: 'var(--fl-text, #333)',
    wordBreak: 'break-all',
  },
  mono: {
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: 12,
  },
  code: {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 4,
    background: 'var(--fl-surface-raised, #f5f5f5)',
    border: '1px solid var(--fl-border, #ddd)',
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: 12,
  },
  commits: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    border: '1px solid var(--fl-border, #ddd)',
    borderRadius: 6,
    overflow: 'hidden',
  },
  commit: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '8px 12px',
    borderBottom: '1px solid var(--fl-border, #ddd)',
  },
  commitSubject: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12.5,
  },
  commitMeta: {
    flex: '0 0 auto',
    fontSize: 11.5,
    color: 'var(--fl-text-subtle, #999)',
    whiteSpace: 'nowrap',
  },
  hint: {
    marginTop: 6,
    fontSize: 11.5,
    lineHeight: 1.6,
    color: 'var(--fl-text-subtle, #999)',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    fontSize: 13,
    borderRadius: 4,
    border: '1px solid var(--fl-border, #ccc)',
    background: 'var(--fl-surface, #fff)',
    color: 'var(--fl-text, #333)',
    outline: 'none',
  },
  inputRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  inputGrow: {
    flex: '1 1 220px',
    minWidth: 160,
  },
  actionMessage: {
    marginTop: 10,
    padding: '7px 10px',
    borderRadius: 5,
    fontSize: 12.5,
    lineHeight: 1.6,
    border: '1px solid',
  },
  empty: {
    padding: '10px 12px',
    borderRadius: 6,
    border: '1px dashed var(--fl-border, #ddd)',
    fontSize: 12.5,
    color: 'var(--fl-text-muted, #666)',
  },
}

// 状态徽章配色：只取设计变量，不写死颜色。
// 边框用 currentColor，底色留空——这样在默认 / 亮色 / 柔和三套主题下都不会出现
// 「白底白字」或「一坨高饱和色块」。
const TONES = {
  ok: 'var(--green-60, #246b1e)',
  info: 'var(--blue-60, #0969da)',
  warn: 'var(--yellow-70, #633a0b)',
  muted: 'var(--fl-text-muted, #666)',
}

function Pill({ tone = 'muted', children }) {
  return (
    <span
      style={{
        ...styles.pill,
        color: TONES[tone] || TONES.muted,
        borderColor: 'currentColor',
        background: 'transparent',
      }}
    >
      {children}
    </span>
  )
}

function Field({ label, children, mono }) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      <div
        style={
          mono ? { ...styles.fieldValue, ...styles.mono } : styles.fieldValue
        }
      >
        {children}
      </div>
    </div>
  )
}

function formatDateTime(value) {
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  // 用浏览器语言格式化，不再写死 'zh-CN'
  return date.toLocaleString()
}

function formatDate(value) {
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleDateString()
}

function GitInfoModal({ showModal, handleClose, projectId }) {
  const { t } = useTranslation()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(null)
  // FIXED: 2026-11 令牌 / 提交信息 / 操作结果（见文件头注释）
  const [token, setToken] = useState('')
  const [tokenEditing, setTokenEditing] = useState(false)
  const [savingToken, setSavingToken] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [busyAction, setBusyAction] = useState(null) // 'push' | 'pull' | 'merge'
  const [actionResult, setActionResult] = useState(null) // {text, tone}

  const load = useCallback(
    async ({ fetchRemote = false } = {}) => {
      if (!projectId) {
        return
      }
      if (fetchRemote) {
        setChecking(true)
      } else {
        setLoading(true)
      }
      setError(null)
      try {
        const query = fetchRemote ? '?fetch=1' : ''
        const response = await fetch(`/project/${projectId}/git/info${query}`, {
          credentials: 'include',
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const result = await response.json()
        setData(result)
      } catch (err) {
        setError(err.message || 'request_failed')
      } finally {
        setLoading(false)
        setChecking(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    if (showModal) {
      setToken('')
      setTokenEditing(false)
      setCommitMessage('')
      setActionResult(null)
      load()
    }
  }, [showModal, load])

  // 统一的 POST/PUT 包装：始终带 cookie 与 CSRF token，始终解析 JSON（失败也要给出可读信息）
  //
  // FIXED: 2026-11 线上 POST /project/:id/git/pull 报 403 Forbidden。
  // 不是 nginx，也不是权限：webRouter 全局挂了 CSRF 中间件
  // （app/src/infrastructure/Server.js: webRouter.use(webRouter.csrf.middleware)），
  // 只有 /ft-ai* 这类接口才 disableDefaultCsrfProtection。
  // 之前这里手写 fetch 只带了 cookie，漏了 X-CSRF-Token，于是所有从弹窗发起的
  // POST/PUT（拉取、合并、提交推送、保存/清除令牌）都被 CSRF 拦成 403。
  // 顶栏那两处 pull/push 一直带着这个头，所以只有弹窗里的按钮会 403。
  const send = useCallback(
    async (url, body, method = 'POST') => {
      const response = await fetch(url, {
        method,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getMeta('ol-csrfToken'),
        },
        body: JSON.stringify(body || {}),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch (err) {
        payload = null
      }
      if (!response.ok && !payload) {
        // FIXED: 2026-11 403 在线上有两种来源：CSRF token 失效（会话过期）
        // 和没有项目写权限；错误体不是 JSON，原来只显示 "HTTP 403"，
        // 既看不出原因也不知道下一步做什么。
        if (response.status === 403) {
          throw new Error(
            t(
              'git_info_http_403',
              'Sign-in may have expired, or you lack permission. Refresh the page and try again. (HTTP 403)'
            )
          )
        }
        throw new Error(`HTTP ${response.status}`)
      }
      return payload || { success: false, error: `HTTP ${response.status}` }
    },
    [t]
  )

  // 保存 / 清除令牌：服务端只回「有没有」和末 4 位，明文不出服务端
  const submitToken = useCallback(
    async value => {
      if (!projectId) return
      setSavingToken(true)
      setActionResult(null)
      try {
        const result = await send(
          `/project/${projectId}/git/token`,
          {
            token: value,
          },
          'PUT'
        )
        if (!result.success) {
          setActionResult({
            text:
              t('git_info_token_save_failed', 'Failed to save token') +
              (result.error ? ` — ${result.error}` : ''),
            tone: 'error',
          })
          return
        }
        setToken('')
        setTokenEditing(false)
        setActionResult({
          text: result.hasToken
            ? t(
                'git_info_token_saved_ok',
                'Token saved. It is stored on the server and shown masked.'
              )
            : t('git_info_token_cleared_ok', 'Token removed.'),
          tone: 'success',
        })
        await load()
      } catch (err) {
        setActionResult({
          text:
            t('git_info_token_save_failed', 'Failed to save token') +
            ` — ${err.message}`,
          tone: 'error',
        })
      } finally {
        setSavingToken(false)
      }
    },
    [projectId, send, load, t]
  )

  // 提交并推送 / 拉取 / 合并远端
  const runPush = useCallback(async () => {
    if (!projectId) return
    setBusyAction('push')
    setActionResult(null)
    try {
      const result = await send(`/project/${projectId}/git/push`, {
        commitMessage: commitMessage.trim() || undefined,
      })
      const message = getPushResultMessage(result, t)
      setActionResult({ text: message.text, tone: message.tone })
      if (message.pushed) setCommitMessage('')
      await load()
    } catch (err) {
      setActionResult({
        text: `${t('git_push_failed', 'Push failed')} — ${err.message}`,
        tone: 'error',
      })
    } finally {
      setBusyAction(null)
    }
  }, [projectId, send, commitMessage, load, t])

  const runPull = useCallback(
    async strategy => {
      if (!projectId) return
      const mode = strategy || 'default'
      setBusyAction(mode === 'rebase' ? 'merge' : 'pull')
      setActionResult(null)
      try {
        const result = await send(`/project/${projectId}/git/pull`, {
          strategy,
        })
        const message = getPullResultMessage(result, t)
        setActionResult({ text: message.text, tone: message.tone })
        await load()
      } catch (err) {
        setActionResult({
          text: `${t('git_pull_failed', 'Pull failed')} — ${err.message}`,
          tone: 'error',
        })
      } finally {
        setBusyAction(null)
      }
    },
    [projectId, send, load, t]
  )

  const statusPills = () => {
    if (!data || !data.linked) {
      return [
        <Pill key="unlinked" tone="muted">
          {t('git_info_not_linked', 'Not linked to a Git repository')}
        </Pill>,
      ]
    }

    if (!data.available) {
      return [
        <Pill key="missing" tone="warn">
          {t(
            'git_info_repo_unavailable',
            'Repository directory is unavailable'
          )}
        </Pill>,
      ]
    }

    const pills = []
    const { sync = {}, changes = {}, branch = {} } = data

    if (sync.behind > 0) {
      pills.push(
        <Pill key="behind" tone="info">
          {t('git_info_status_behind', '__count__ commit(s) to pull', {
            count: sync.behind,
          })}
        </Pill>
      )
    }
    if (sync.ahead > 0) {
      pills.push(
        <Pill key="ahead" tone="warn">
          {t('git_info_status_ahead', '__count__ commit(s) to push', {
            count: sync.ahead,
          })}
        </Pill>
      )
    }
    if (sync.upToDate) {
      pills.push(
        <Pill key="uptodate" tone="ok">
          {t('git_info_status_up_to_date', 'Up to date with remote')}
        </Pill>
      )
    }
    if (!branch.trackingExists && data.available) {
      pills.push(
        <Pill key="notracking" tone="muted">
          {t('git_info_status_no_upstream', 'No upstream branch')}
        </Pill>
      )
    }
    if (changes.total > 0) {
      pills.push(
        <Pill key="dirty" tone="warn">
          {t('git_info_status_dirty', '__count__ uncommitted file(s)', {
            count: changes.total,
          })}
        </Pill>
      )
    }
    if (data.canWrite === false) {
      pills.push(
        <Pill key="readonly" tone="muted">
          {t('git_info_read_only', 'Read-only access')}
        </Pill>
      )
    }
    if (data.sync && data.sync.canPush && data.canWrite !== false) {
      pills.push(
        <Pill key="canpush" tone="ok">
          {t('git_info_can_push', 'Push available')}
        </Pill>
      )
    }
    if (pills.length === 0) {
      pills.push(
        <Pill key="unknown" tone="muted">
          {t('git_info_status_unknown', 'Status unavailable')}
        </Pill>
      )
    }
    return pills
  }

  const remote = (data && data.remote) || {}
  const branch = (data && data.branch) || {}
  const sync = (data && data.sync) || {}
  const changes = (data && data.changes) || {}
  const commits = (data && data.commits) || []
  const providerLabel = PROVIDER_LABEL[remote.provider] || PROVIDER_LABEL.other

  return (
    <AccessibleModal
      show={showModal}
      onHide={handleClose}
      id="git-info-modal"
      dialogClassName="git-info-modal"
      backdrop="static"
    >
      <Modal.Header closeButton>
        <Modal.Title>
          <Icon type="code-fork" />{' '}
          {t('git_info_title', 'Repository information')}
        </Modal.Title>
      </Modal.Header>

      <Modal.Body style={styles.body}>
        {loading && (
          <div style={styles.empty}>{t('git_info_loading', 'Loading…')}</div>
        )}

        {!loading && error && (
          <div style={styles.empty}>
            {t('git_info_load_failed', 'Failed to load repository information')}
            {': '}
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <>
            <div style={styles.pills}>{statusPills()}</div>

            {data.linked && (
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>
                  {t('git_info_repository', 'Repository')}
                </h4>
                <div style={styles.grid}>
                  <Field label={t('git_info_remote_url', 'Remote URL')} mono>
                    {remote.maskedUrl || '—'}
                  </Field>
                  <Field label={t('git_info_platform', 'Platform')}>
                    {providerLabel}
                    {remote.host ? (
                      <span style={{ ...styles.commitMeta, marginLeft: 6 }}>
                        {remote.host}
                      </span>
                    ) : null}
                  </Field>
                  <Field label={t('git_info_branch', 'Branch')} mono>
                    {branch.current || '—'}
                    {branch.tracking ? (
                      <span style={{ ...styles.commitMeta, marginLeft: 6 }}>
                        → {branch.tracking}
                      </span>
                    ) : null}
                  </Field>
                  <Field label={t('git_info_total_commits', 'Total commits')}>
                    {data.totalCommits || 0}
                  </Field>
                  <Field label={t('git_info_last_sync', 'Last sync')}>
                    {formatDateTime(data.config && data.config.lastSync) || '—'}
                  </Field>
                  <Field label={t('git_info_last_check', 'Last remote check')}>
                    {formatDateTime(data.lastFetchAt) || '—'}
                  </Field>
                </div>
              </div>
            )}

            {data.linked && (
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>
                  {t('git_info_credentials', 'Authorization')}
                </h4>

                {remote.hasCredentials && !tokenEditing ? (
                  <div>
                    <span style={styles.code}>
                      {remote.username ? `${remote.username}:` : ''}
                      {remote.credentialMask || '••••••'}
                    </span>
                    <div style={styles.hint}>
                      {remote.credentialSource === 'stored'
                        ? t(
                            'git_info_token_stored_hint',
                            'The access token is stored on the server and shown masked. It is used for pull and push.'
                          )
                        : t(
                            'git_info_credentials_masked',
                            'The access token used to clone this repository is stored on the server and is shown masked.'
                          )}
                    </div>
                    {data.canWrite && (
                      <div style={styles.inputRow}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setTokenEditing(true)}
                        >
                          {t('git_info_change_token', 'Change token')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => submitToken('')}
                          disabled={savingToken}
                        >
                          {t('git_info_clear_token', 'Remove')}
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}

                {(!remote.hasCredentials || tokenEditing) && (
                  <div>
                    <div style={styles.hint}>
                      {t(
                        'git_info_no_credentials',
                        'No access token is stored for this repository (public repository or anonymous access).'
                      )}
                      <div style={{ marginTop: 4 }}>
                        {t(
                          'git_info_no_credentials_hint',
                          'Public repositories can be pulled without a token, but pushing needs one. Paste a personal access token here — it is stored on the server and never sent back to the browser.'
                        )}
                      </div>
                    </div>
                    <div style={styles.inputRow}>
                      <div style={styles.inputGrow}>
                        <input
                          type="password"
                          autoComplete="new-password"
                          style={styles.input}
                          placeholder={t(
                            'git_info_token_placeholder',
                            'Personal access token (repo scope)'
                          )}
                          value={token}
                          onChange={event => setToken(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter' && token.trim()) {
                              submitToken(token.trim())
                            }
                          }}
                          disabled={savingToken}
                        />
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => submitToken(token.trim())}
                        disabled={savingToken || !token.trim()}
                      >
                        {savingToken
                          ? t('git_info_saving', 'Saving…')
                          : t('git_info_save_token', 'Save token')}
                      </button>
                      {tokenEditing && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setToken('')
                            setTokenEditing(false)
                          }}
                          disabled={savingToken}
                        >
                          {t('cancel', 'Cancel')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {data.linked && data.available && data.canWrite !== false && (
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>
                  {t('git_info_actions', 'Sync')}
                </h4>

                <div style={styles.inputRow}>
                  <div style={{ ...styles.inputGrow, flex: '1 1 100%' }}>
                    <input
                      type="text"
                      style={styles.input}
                      maxLength={200}
                      placeholder={t(
                        'git_info_commit_message_placeholder',
                        'Commit message (optional, defaults to “Update from FlyLaTeX”)'
                      )}
                      value={commitMessage}
                      onChange={event => setCommitMessage(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && !busyAction) runPush()
                      }}
                      disabled={!!busyAction}
                    />
                  </div>
                </div>

                <div style={styles.inputRow}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={runPush}
                    disabled={!!busyAction}
                  >
                    {busyAction === 'push'
                      ? t('git_info_pushing', 'Pushing…')
                      : t('git_info_push_now', 'Commit and push')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => runPull('default')}
                    disabled={!!busyAction}
                  >
                    {busyAction === 'pull'
                      ? t('git_info_pulling', 'Pulling…')
                      : t('git_info_pull_now', 'Pull latest')}
                  </button>
                  {sync.diverged && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => runPull('rebase')}
                      disabled={!!busyAction}
                    >
                      {busyAction === 'merge'
                        ? t('git_info_merging', 'Merging…')
                        : t('git_info_merge_remote', 'Merge remote (rebase)')}
                    </button>
                  )}
                </div>

                {sync.diverged && (
                  <div style={styles.hint}>
                    {t(
                      'git_info_diverged_hint',
                      'Your local branch and the remote have both moved on. Merge the remote changes first — rebase keeps the history linear.'
                    )}
                  </div>
                )}

                {actionResult && (
                  <div
                    style={{
                      ...styles.actionMessage,
                      color:
                        actionResult.tone === 'success'
                          ? 'var(--green-60, #246b1e)'
                          : actionResult.tone === 'error'
                          ? 'var(--red-60, #b42318)'
                          : 'var(--blue-60, #0969da)',
                      borderColor: 'currentColor',
                    }}
                  >
                    {actionResult.text}
                  </div>
                )}
              </div>
            )}

            {data.linked && data.available && (
              <div style={styles.section}>
                <h4 style={styles.sectionTitle}>
                  {t('git_info_recent_commits', 'Latest 10 commits')}
                </h4>
                {commits.length === 0 ? (
                  <div style={styles.empty}>
                    {t('git_info_no_commits', 'No commits yet')}
                  </div>
                ) : (
                  <ul style={styles.commits}>
                    {commits.map((commit, index) => (
                      <li
                        key={commit.hash || index}
                        style={{
                          ...styles.commit,
                          borderBottom:
                            index === commits.length - 1
                              ? 'none'
                              : styles.commit.borderBottom,
                        }}
                      >
                        <span style={{ ...styles.code, flex: '0 0 auto' }}>
                          {commit.shortHash}
                        </span>
                        <span
                          style={styles.commitSubject}
                          title={commit.subject}
                        >
                          {commit.subject}
                        </span>
                        <span style={styles.commitMeta}>
                          {commit.author}
                          {' · '}
                          {formatDate(commit.date) || '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {changes.total > 0 && (
                  <div style={styles.hint}>
                    {t(
                      'git_info_local_changes',
                      '__count__ uncommitted file(s) in the working copy',
                      { count: changes.total }
                    )}
                  </div>
                )}
              </div>
            )}

            {!data.linked && (
              <div style={styles.empty}>
                {t(
                  'git_info_not_linked_hint',
                  'This project is not linked to a Git repository yet.'
                )}
              </div>
            )}
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        {data && data.linked && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => load({ fetchRemote: true })}
            disabled={loading || checking}
          >
            {checking
              ? t('git_info_checking', 'Checking…')
              : t('git_info_check_updates', 'Check for updates')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => load()}
          disabled={loading || checking}
        >
          {t('git_info_refresh', 'Refresh')}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleClose}>
          {t('git_info_close', 'Close')}
        </button>
      </Modal.Footer>
    </AccessibleModal>
  )
}

export default GitInfoModal
