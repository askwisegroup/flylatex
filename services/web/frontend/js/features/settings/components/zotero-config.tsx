import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getJSON, postJSON } from '../../../infrastructure/fetch-json'

/**
 * FIXED: 2026-11-16 Zotero 绑定配置（共享组件）。
 *
 * 两个地方用同一份：账号设置页的「Zotero 文献库」区块，以及
 * 编辑器「设置 → 系统集成」那一档（设置弹窗/左侧面板都读同一份 settingsGroups）。
 * 逻辑放这里，两处只包不同的外框，避免各写一套状态机。
 *
 * 为什么还要填 User ID：
 *   Zotero 的接口路径是 /users/{userID}/items。正常情况下我们从 /keys/current 自动推导，
 *   但（a）团队共用一把 key、（b）某些 key 读不到 /keys/current 时，需要用户自己填。
 *   填了就先校验这个库能不能列条目，校验通过才算绑定成功。
 */

/**
 * FIXED: 2026-11-16 把「接口 404」翻译成人话。
 * 线上表现：页面上只有一句 Not Found，看着像客户端校验失败，
 * 实际是服务器的外层 nginx 没有转发 /api/zotero（它按前缀逐条配 location）。
 */
function describeZoteroError(error: any, t: (key: string) => string): string {
  const status = error?.response?.status ?? error?.statusCode
  const message = String(error?.message || '')
  if (status === 404 || /not found/i.test(message)) {
    return t('settings_zotero_error_404')
  }
  return message || t('settings_zotero_error_generic')
}

type ZoteroStatus = {
  linked: boolean
  oauthAvailable?: boolean
  username?: string
  libraryId?: string
  itemCount?: number | null
  collections?: Array<{ key: string; name: string; itemCount?: number }>
  warning?: string | null
  apiKeyMasked?: string
  linkedAt?: string | null
}

export default function ZoteroConfig({
  showHint = true,
}: {
  showHint?: boolean
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ZoteroStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [userId, setUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{
    kind: 'ok' | 'err'
    text: string
  } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await getJSON<{ code: number; data: ZoteroStatus }>(
        '/api/zotero/status'
      )
      setStatus(result.data || { linked: false })
    } catch (error: any) {
      setStatus({ linked: false })
      setMessage({ kind: 'err', text: describeZoteroError(error, t) })
    } finally {
      setLoading(false)
    }
  }, [t])

  // FIXED: 2026-11-16 新窗口授权回来后，靠 postMessage 通知原页面刷新状态
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return
      }
      const data = event.data
      if (!data || data.type !== 'zotero-oauth') {
        return
      }
      setMessage({
        kind: data.ok ? 'ok' : 'err',
        text: data.ok
          ? t('settings_zotero_oauth_ok')
          : t('settings_zotero_oauth_failed'),
      })
      refresh()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [refresh, t])

  useEffect(() => {
    refresh()
    // OAuth 回调后带 ?zotero=oauth_ok|oauth_failed
    const params = new URLSearchParams(window.location.search)
    const result = params.get('zotero')
    if (result === 'oauth_ok') {
      setMessage({ kind: 'ok', text: t('settings_zotero_oauth_ok') })
    } else if (result === 'oauth_failed') {
      setMessage({ kind: 'err', text: t('settings_zotero_oauth_failed') })
    }
    if (result) {
      params.delete('zotero')
      const query = params.toString()
      window.history.replaceState(
        {},
        '',
        window.location.pathname + (query ? `?${query}` : '')
      )
    }
  }, [refresh, t])

  const pollTimerRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // FIXED: 2026-11-16 授权窗口的结果**不再依赖 window.opener**：
  // zotero.org 会下发 COOP 头，跨站之后 opener 基本被切断，postMessage 收不到，
  // 这也是之前「授权完设置页毫无反应」的原因。现在打开窗口后轮询 /api/zotero/status，
  // 一旦变成已绑定就更新 UI 并停止轮询（最多 2 分钟）。
  const startOAuth = useCallback(() => {
    const url = '/api/zotero/oauth'
    const popup = window.open(
      url,
      'zotero-oauth',
      'width=560,height=760,menubar=no,toolbar=no'
    )
    if (!popup) {
      window.location.href = url
      return
    }

    stopPolling()
    let tries = 0
    setMessage({ kind: 'ok', text: t('settings_zotero_oauth_waiting') })

    pollTimerRef.current = window.setInterval(async () => {
      tries += 1
      try {
        const result = await getJSON<{ code: number; data: ZoteroStatus }>(
          '/api/zotero/status'
        )
        if (result.data?.linked) {
          setStatus(result.data)
          setMessage({ kind: 'ok', text: t('settings_zotero_oauth_ok') })
          stopPolling()
          return
        }
      } catch {
        // 忽略：继续等
      }
      if (popup.closed || tries >= 60) {
        stopPolling()
        setMessage(current =>
          current && current.text === t('settings_zotero_oauth_waiting')
            ? { kind: 'err', text: t('settings_zotero_oauth_failed') }
            : current
        )
      }
    }, 2000)
  }, [stopPolling, t])

  // 组件卸载/切走时别留定时器
  useEffect(() => stopPolling, [stopPolling])

  // 回到这个标签页时也刷一次（弹窗被关、轮询被浏览器节流的兜底）
  useEffect(() => {
    const onFocus = () => {
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const link = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) {
      setMessage({ kind: 'err', text: t('settings_zotero_api_key_required') })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await postJSON<{ code: number; msg: string; data: any }>(
        '/api/zotero/link',
        { body: { apiKey: key, userId: userId.trim() } }
      )
      if (result.code !== 0) {
        setMessage({ kind: 'err', text: result.msg })
      } else {
        setMessage({
          kind: 'ok',
          text: `${t('settings_zotero_linked')}：${
            result.data?.username || result.data?.libraryId || 'Zotero'
          }${
            result.data?.itemCount != null ? `（${result.data.itemCount}）` : ''
          }`,
        })
        setApiKey('')
        setUserId('')
        await refresh()
      }
    } catch (error: any) {
      setMessage({ kind: 'err', text: describeZoteroError(error, t) })
    } finally {
      setBusy(false)
    }
  }, [apiKey, userId, refresh, t])

  const unlink = useCallback(async () => {
    setBusy(true)
    try {
      await postJSON('/api/zotero/unlink', { body: {} })
      setMessage({ kind: 'ok', text: t('settings_zotero_unlinked') })
      await refresh()
    } catch (error: any) {
      setMessage({ kind: 'err', text: describeZoteroError(error, t) })
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  if (loading) {
    return <p className="text-muted small">{t('loading')}…</p>
  }

  if (status?.linked) {
    return (
      <div className="zotero-config">
        <p className="zotero-section-status">
          {t('settings_zotero_linked')}：
          <strong>{status.username || status.libraryId || 'Zotero'}</strong>
          {status.itemCount != null ? ` · ${status.itemCount}` : ''}
          {status.apiKeyMasked ? (
            <span className="text-muted small">
              {' '}
              · Key {status.apiKeyMasked}
            </span>
          ) : null}
        </p>
        {status.collections?.length ? (
          <p className="text-muted small">
            {status.collections.map(c => c.name).join('、')}
          </p>
        ) : null}
        {status.warning && (
          <p className="text-danger small">{status.warning}</p>
        )}
        <button
          type="button"
          className="btn btn-default btn-sm"
          onClick={unlink}
          disabled={busy}
        >
          {busy ? '…' : t('settings_zotero_unbind')}
        </button>
      </div>
    )
  }

  return (
    <div className="zotero-config">
      {showHint && (
        <p className="text-muted small">{t('settings_zotero_hint')}</p>
      )}
      {status?.oauthAvailable && (
        <div style={{ margin: '4px 0 10px' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={startOAuth}
          >
            {t('settings_zotero_oauth_button')}
          </button>
          <span className="text-muted small" style={{ marginLeft: 8 }}>
            {t('settings_zotero_oauth_hint')}
          </span>
        </div>
      )}

      {/* FIXED: 2026-11-16 没配置 OAuth 时明确说一句，别让人找按钮找半天 */}
      {!status?.oauthAvailable && (
        <p className="text-muted small" style={{ margin: '4px 0 8px' }}>
          {t('settings_zotero_oauth_unavailable')}
        </p>
      )}

      {/* FIXED: 2026-11-16 「生成 Key + 填 User ID」属于高阶操作，收进折叠区；
          主路径是上面那个「用 Zotero 账号登录并授权」 */}
      <details
        className="zotero-advanced"
        open={!status?.oauthAvailable || undefined}
      >
        <summary>{t('settings_zotero_advanced')}</summary>
        <div className="zotero-section-form">
          <input
            type="password"
            className="form-control"
            placeholder={t('settings_zotero_api_key')}
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            disabled={busy}
            autoComplete="off"
          />
          <input
            type="text"
            className="form-control zotero-user-id"
            placeholder={t('settings_zotero_user_id')}
            value={userId}
            onChange={event => setUserId(event.target.value)}
            disabled={busy}
            inputMode="numeric"
          />
          <button
            type="button"
            className="btn btn-default btn-sm"
            onClick={link}
            disabled={busy || !apiKey.trim()}
          >
            {busy ? '…' : t('settings_zotero_bind')}
          </button>
        </div>
        <p className="text-muted small">{t('settings_zotero_user_id_hint')}</p>
      </details>
      {message && (
        <p
          className={
            message.kind === 'ok' ? 'text-success small' : 'text-danger small'
          }
          role="status"
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
