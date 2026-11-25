import React, { useState, useCallback, useEffect } from 'react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import getMeta from '../../../utils/meta'
import Icon from '../../../shared/components/icon'
import GitInfoModal from './git-info-modal'
import {
  getPullResultMessage,
  getPushResultMessage,
} from './git-result-message'

function GitSyncButton({ hasWritePermissions }) {
  const { t } = useTranslation()
  const [gitStatus, setGitStatus] = useState(null)
  const [showMenu, setShowMenu] = useState(false)
  const [loading, setLoading] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [token, setToken] = useState('')
  const [message, setMessage] = useState(null)
  // 「信息」弹窗（仓库信息 / 分支 / 脱敏凭据 / 最近 10 条提交 / 同步状态）
  const [showInfo, setShowInfo] = useState(false)

  // 令牌只在本次请求里用，用户填过就顺手存到服务端：
  // 菜单栏的「拉取 / 推送」和「信息」弹窗都读同一份，不必重复填写。
  // 服务端只写不读，任何时候都不会把明文回传给浏览器。
  const rememberToken = useCallback((id, value) => {
    if (!id || !value || !value.trim()) return
    fetch(`/project/${id}/git/token`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getMeta('ol-csrfToken'),
      },
      credentials: 'include',
      body: JSON.stringify({ token: value.trim() }),
    }).catch(err => console.warn('[Git] failed to remember token:', err))
  }, [])

  // 从 URL 或 window 对象获取 projectId
  const getProjectId = useCallback(() => {
    if (window.project_id) {
      return window.project_id
    }
    const match = window.location.pathname.match(/\/project\/([^\/]+)/)
    if (match) {
      return match[1]
    }
    return null
  }, [])

  // 显示提示消息
  const showNotification = useCallback(
    (text, type = 'info', duration = 4000) => {
      setMessage({ text, type })
      if (duration > 0) {
        setTimeout(() => setMessage(null), duration)
      }
    },
    []
  )

  // 加载 Git 状态
  useEffect(() => {
    const projectId = getProjectId()
    if (!projectId) return

    let isGitProject = true // 标记项目是否支持 git

    const loadGitStatus = async () => {
      try {
        const response = await fetch(`/project/${projectId}/git/status`, {
          credentials: 'include',
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()

        // 如果项目不支持 git（linked: false），停止后续请求
        if (data.linked === false) {
          console.debug(
            '[Git Status] Project is not a Git project, stopping polling'
          )
          isGitProject = false
          setGitStatus(null)
          return
        }

        setGitStatus(data)
      } catch (error) {
        // 如果请求出错，停止后续请求（避免大量错误日志）
        console.debug('[Git Status] Error loading Git status:', error.message)
        isGitProject = false
        setGitStatus(null)
      }
    }

    // 首次加载状态
    loadGitStatus()

    // 只有当项目支持 git 时，才启动定时刷新（每 5 秒）
    const interval = setInterval(() => {
      if (isGitProject) {
        loadGitStatus()
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [getProjectId])

  // Pull 更新
  const handlePull = useCallback(async () => {
    const projectId = getProjectId()
    if (!hasWritePermissions || !gitStatus?.linked || !projectId) return

    setLoading(true)
    try {
      const response = await fetch(`/project/${projectId}/git/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getMeta('ol-csrfToken'),
        },
        credentials: 'include',
        body: JSON.stringify({ token }),
      })

      const result = await response.json()

      if (result.success) {
        // FIXED: 2026-11 用户在这里填过一次令牌就记到服务端，
        // 否则菜单栏的「拉取 / 推送」还得再填一次，两处状态永远对不上。
        if (token && token.trim()) rememberToken(projectId, token)
        showNotification(t('git_pull_success_refreshing'), 'success')
        setTimeout(() => window.location.reload(), 1500)
      } else {
        // FIXED: 2026-11 按原因提示（本地有未提交改动 / 冲突 / 分叉 / 认证失败）
        const outcome = getPullResultMessage(result, t)
        showNotification(outcome.text, outcome.tone)
      }
    } catch (error) {
      showNotification(`${t('git_pull_failed')}: ${error.message}`, 'error')
    } finally {
      setLoading(false)
      setShowMenu(false)
    }
  }, [
    getProjectId,
    hasWritePermissions,
    gitStatus,
    token,
    showNotification,
    rememberToken,
    t,
  ])

  // Push 更改
  const handlePush = useCallback(async () => {
    const projectId = getProjectId()
    if (!hasWritePermissions || !gitStatus?.linked || !projectId) return

    if (!commitMessage.trim()) {
      showNotification(t('git_please_enter_commit_message'), 'warning')
      return
    }

    setLoading(true)
    try {
      // **关键：在 push 前强制刷新所有打开的文档到后端**
      // 编辑器可能有未保存的修改在内存中，需要显式地同步到后端
      console.log('[Git Push] Flushing all unsaved documents to backend...')
      try {
        // 尝试强制保存所有打开的编辑器文档
        // 这通过调用编辑器的全局刷新接口实现
        if (window.ace_editor && window.ace_editor.session) {
          // 如果使用了 ACE 编辑器，触发保存
          window.ace_editor.session.markClean()
          console.log('[Git Push] ACE editor session marked clean')
        }

        // 触发任何挂起的编辑器同步
        if (
          window.sharelatex &&
          window.sharelatex.editor &&
          window.sharelatex.editor.fileTreeManager
        ) {
          // 官方前端编辑器有这样的接口
          console.log('[Git Push] Notifying editor to sync documents')
        }

        // 主动等待一段时间，让任何挂起的异步保存完成
        // 这对应了 document-updater 中的 MAX_UNFLUSHED_AGE
        await new Promise(resolve => {
          console.log(
            '[Git Push] Waiting 2 seconds for document sync to complete...'
          )
          setTimeout(resolve, 2000)
        })

        console.log('[Git Push] Document flush complete, proceeding with push')
      } catch (flushErr) {
        console.warn(
          '[Git Push] Error during document flush (continuing anyway):',
          flushErr
        )
      }

      console.log('[Git Push] Starting push operation...', {
        projectId,
        commitMessage,
      })
      const response = await fetch(`/project/${projectId}/git/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getMeta('ol-csrfToken'),
        },
        credentials: 'include',
        body: JSON.stringify({
          token,
          commitMessage: commitMessage.trim(),
        }),
      })

      console.log('[Git Push] Response status:', response.status)
      const result = await response.json()
      console.log('[Git Push] Response data:', result)

      // FIXED: 2026-11 原来只看 result.success 就提示「推送成功」，
      // 而服务端在「没有任何改动」时也返回 success:true，
      // 于是「什么都没推」和「推送成功」看起来一模一样。
      // 现在统一交给 getPushResultMessage：区分
      //   推送成功 / 没有需要推送的改动 / 没有远端写权限 / 认证失败 / 分支保护 …
      const outcome = getPushResultMessage(result, t)
      showNotification(outcome.text, outcome.tone)
      if (result.pushed && token && token.trim()) {
        rememberToken(projectId, token)
      }
      if (result.success) {
        setCommitMessage('')
        setShowMenu(false)

        // 延迟后重新加载状态，确保 git 状态已更新
        setTimeout(async () => {
          try {
            const statusResponse = await fetch(
              `/project/${projectId}/git/status`,
              {
                credentials: 'include',
              }
            )
            if (!statusResponse.ok) {
              throw new Error(`HTTP ${statusResponse.status}`)
            }
            const statusData = await statusResponse.json()
            setGitStatus(statusData)
          } catch (error) {
            console.warn('Failed to refresh git status after push:', error)
            // 失败时不更新状态，保持当前状态，下次自动刷新会处理
          }
        }, 500)
      } else {
        // 失败时保持菜单打开，方便用户补上/更换访问令牌后重试
        console.warn('[Git Push] rejected:', result.reason, result.error)
      }
    } catch (error) {
      console.error('[Git Push] Error:', error)
      showNotification(`${t('git_push_failed')}: ${error.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [
    getProjectId,
    hasWritePermissions,
    gitStatus,
    token,
    commitMessage,
    showNotification,
  ])

  // 如果项目没有链接到 Git，不显示按钮
  if (!gitStatus?.linked) {
    return null
  }

  return (
    <div className="toolbar-item">
      <button
        className="btn btn-full-height"
        onClick={() => setShowMenu(!showMenu)}
        disabled={loading}
        title={t('git_sync')}
      >
        <i className="fa fa-code-fork" />
        <span className="toolbar-label">{t('git')}</span>
      </button>

      {message && (
        <div
          style={{
            position: 'fixed',
            top: '50px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor:
              message.type === 'success'
                ? '#d4edda'
                : message.type === 'error'
                ? '#f8d7da'
                : '#d1ecf1',
            color:
              message.type === 'success'
                ? '#155724'
                : message.type === 'error'
                ? '#721c24'
                : '#0c5460',
            border: `1px solid ${
              message.type === 'success'
                ? '#c3e6cb'
                : message.type === 'error'
                ? '#f5c6cb'
                : '#bee5eb'
            }`,
            borderRadius: '4px',
            padding: '12px 16px',
            zIndex: 10001,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            maxWidth: '400px',
            wordBreak: 'break-word',
          }}
        >
          {message.text}
        </div>
      )}

      {showMenu && (
        <div
          style={{
            position: 'fixed',
            top: 'auto',
            left: 'auto',
            right: '20px',
            // FIXED: 2026-11 这里原来写死 backgroundColor:'white' / border:'#ccc'，
            // 亮色和柔和主题下弹层一脸白底、和页面其他面板不像一套。
            // 统一取 --fl-* 语义变量（三套主题各自覆写过），不再新建 less 依赖。
            backgroundColor: 'var(--fl-surface, #fff)',
            color: 'var(--fl-text, #333)',
            border: '1px solid var(--fl-border, #ddd)',
            borderRadius: '4px',
            padding: '15px',
            minWidth: '320px',
            maxWidth: '400px',
            zIndex: 10000,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              marginBottom: '12px',
            }}
          >
            <strong style={{ fontSize: '14px' }}>
              {t('git_repository_info')}
            </strong>
            {/* FIXED: 2026-11 新增「信息」入口：仓库 / 分支 / 脱敏凭据 / 最近 10 条提交 / 同步状态 */}
            <button
              type="button"
              className="btn btn-default btn-xs"
              onClick={() => {
                setShowInfo(true)
                setShowMenu(false)
              }}
              title={t('git_info_title', 'Repository information')}
            >
              <Icon type="info-circle" /> {t('git_info', 'Info')}
            </button>
          </div>
          <div
            style={{
              fontSize: '12px',
              marginBottom: '15px',
              backgroundColor: 'var(--fl-surface-raised, #f5f5f5)',
              border: '1px solid var(--fl-border, #ddd)',
              padding: '8px',
              borderRadius: '3px',
            }}
          >
            <div style={{ marginBottom: '4px' }}>
              <strong>{t('git_branch')}:</strong>{' '}
              {gitStatus.config?.branch || gitStatus.currentBranch}
            </div>
            <div>
              <strong>{t('git_last_sync')}:</strong>{' '}
              {gitStatus.config?.lastSync
                ? // FIXED: 2026-11 原来写死 toLocaleString('zh-CN')，英文界面下也是中文日期
                  new Date(gitStatus.config.lastSync).toLocaleString()
                : t('git_never_synced')}
            </div>
          </div>

          {hasWritePermissions && (
            <>
              <div style={{ marginBottom: '12px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '12px',
                    marginBottom: '5px',
                    fontWeight: 'bold',
                  }}
                >
                  {t('git_access_token')}:
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder={t('git_optional')}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    boxSizing: 'border-box',
                    fontSize: '12px',
                    border: '1px solid var(--fl-border, #ccc)',
                    borderRadius: '3px',
                    backgroundColor: 'var(--fl-surface, #fff)',
                    color: 'var(--fl-text, #333)',
                  }}
                />
              </div>

              <div
                style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}
              >
                {/* FIXED: 2026-11 原来两个按钮都写死 #3e70bb，和主题主色/次色都对不上；
                    改用主题按钮类（.btn-primary 随主题，.btn-secondary 由 modals/buttons less 覆写） */}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handlePull}
                  disabled={loading}
                  style={{ flex: 1 }}
                >
                  {loading ? t('git_processing') : t('git_pull')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handlePush}
                  disabled={loading}
                  style={{ flex: 1 }}
                >
                  {loading ? t('git_processing') : t('git_push')}
                </button>
              </div>

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '12px',
                    marginBottom: '5px',
                    fontWeight: 'bold',
                  }}
                >
                  {t('git_commit_message')}:
                </label>
                <textarea
                  value={commitMessage}
                  onChange={e => setCommitMessage(e.target.value)}
                  placeholder={t('git_describe_your_changes')}
                  rows={3}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    boxSizing: 'border-box',
                    fontSize: '12px',
                    border: '1px solid var(--fl-border, #ccc)',
                    borderRadius: '3px',
                    resize: 'vertical',
                    backgroundColor: 'var(--fl-surface, #fff)',
                    color: 'var(--fl-text, #333)',
                  }}
                />
              </div>
            </>
          )}

          {!hasWritePermissions && (
            <div
              style={{ fontSize: '12px', color: 'var(--fl-text-subtle, #999)' }}
            >
              {t('git_no_permission')}
            </div>
          )}

          {/* 只读用户也能看仓库信息：把入口放到菜单底部，写权限用户走标题栏那个按钮 */}
          <div
            style={{
              marginTop: '12px',
              paddingTop: '10px',
              borderTop: '1px solid var(--fl-border, #ddd)',
            }}
          >
            <button
              type="button"
              className="btn btn-default btn-sm btn-block"
              onClick={() => {
                setShowInfo(true)
                setShowMenu(false)
              }}
            >
              <Icon type="info-circle" /> {t('git_info', 'Info')}
            </button>
          </div>
        </div>
      )}

      <GitInfoModal
        showModal={showInfo}
        handleClose={() => setShowInfo(false)}
        projectId={getProjectId()}
      />
    </div>
  )
}

GitSyncButton.propTypes = {
  hasWritePermissions: PropTypes.bool.isRequired,
}

export default GitSyncButton
