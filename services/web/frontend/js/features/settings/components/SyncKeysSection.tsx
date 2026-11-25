import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  ControlLabel,
  FormControl,
  FormGroup,
} from 'react-bootstrap'
import { Trans, useTranslation } from 'react-i18next'
import {
  FetchError,
  deleteJSON,
  getJSON,
  getUserFacingMessage,
  postJSON,
} from '../../../infrastructure/fetch-json'

// FIXED: 2026-10-15 DesktopSync —— Web「设置 → 同步密钥」区块。
// 对应服务端 Features/DesktopSync 的 3 个 Key 管理端点（session + CSRF，fetch-json 自动携带）。
// 服务未启用（DESKTOP_SYNC_ENABLED 未开，端点 404）时整块隐藏。

interface SyncKeyEntry {
  id: string
  name: string | null
  key_prefix: string
  created_at: string
  last_used_at: string | null
}

interface CreatedKey extends SyncKeyEntry {
  key: string // 明文，仅创建响应返回一次
}

// FIXED: 2026-11-20 时间格式跟着界面语言走，不再写死 zh-CN
function formatTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return isNaN(date.getTime()) ? '—' : date.toLocaleString(locale)
}

function SyncKeysSection() {
  const { t, i18n } = useTranslation()
  const [enabled, setEnabled] = useState(true)
  const [keys, setKeys] = useState<SyncKeyEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)
  const keyInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadKeys()
  }, [])

  async function loadKeys() {
    setError(null)
    try {
      const data = await getJSON<{ keys: SyncKeyEntry[] }>('/api/sync/keys')
      setKeys(data.keys || [])
      setEnabled(true)
    } catch (err) {
      if (err instanceof FetchError && err.response?.status === 404) {
        // DESKTOP_SYNC_ENABLED 未开启，同步端点不存在
        setEnabled(false)
        return
      }
      setError(getUserFacingMessage(err as Error))
    } finally {
      setLoaded(true)
    }
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isCreating) return
    setIsCreating(true)
    setError(null)
    setCopied(false)
    try {
      const created = await postJSON<CreatedKey>('/api/sync/keys', {
        body: name.trim() ? { name: name.trim() } : {},
      })
      setCreatedKey(created)
      setName('')
      loadKeys()
    } catch (err) {
      setError(getUserFacingMessage(err as Error))
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRevoke(keyId: string) {
    if (isRevoking) return
    setIsRevoking(true)
    setError(null)
    try {
      await deleteJSON(`/api/sync/keys/${keyId}`)
      setConfirmRevokeId(null)
      loadKeys()
    } catch (err) {
      setError(getUserFacingMessage(err as Error))
    } finally {
      setIsRevoking(false)
    }
  }

  async function handleCopy() {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey.key)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 非 https 等场景下退化为手动选中复制
      keyInputRef.current?.select()
    }
  }

  if (!enabled) {
    return null
  }

  return (
    <div className="settings-section">
      <h3>{t('sync_keys_title')}</h3>
      <p className="text-muted">
        {t('sync_keys_intro')}
        <br />
        <Trans
          i18nKey="sync_keys_warning"
          components={[<strong key="all-projects" />]}
        />
      </p>

      {error && <Alert bsStyle="danger">{error}</Alert>}

      {createdKey && (
        <Alert bsStyle="success">
          <strong>{t('sync_keys_created')}</strong>
          <p>{t('sync_keys_created_hint')}</p>
          <div className="input-group" style={{ maxWidth: 560 }}>
            <input
              ref={keyInputRef}
              type="text"
              className="form-control"
              readOnly
              value={createdKey.key}
              onClick={e => e.currentTarget.select()}
            />
            <span className="input-group-btn">
              <Button onClick={handleCopy} bsStyle="primary">
                {copied ? t('sync_keys_copied') : t('sync_keys_copy')}
              </Button>
            </span>
          </div>
        </Alert>
      )}

      <form onSubmit={handleCreate}>
        <FormGroup>
          <ControlLabel>{t('sync_keys_device_label')}</ControlLabel>
          <div className="input-group" style={{ maxWidth: 560 }}>
            <FormControl
              type="text"
              value={name}
              placeholder={t('sync_keys_device_placeholder')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setName(e.target.value)
              }
            />
            <span className="input-group-btn">
              <Button type="submit" bsStyle="primary" disabled={isCreating}>
                {isCreating ? t('sync_keys_creating') : t('sync_keys_create')}
              </Button>
            </span>
          </div>
        </FormGroup>
      </form>

      {loaded && keys.length === 0 ? (
        <p className="text-muted">{t('sync_keys_empty')}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-striped">
            <thead>
              <tr>
                <th>{t('sync_keys_col_name')}</th>
                <th>{t('sync_keys_col_key')}</th>
                <th>{t('sync_keys_col_created')}</th>
                <th>{t('sync_keys_col_last_used')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map(entry => (
                <tr key={entry.id}>
                  <td>{entry.name || t('sync_keys_unnamed')}</td>
                  <td>
                    <code>{entry.key_prefix}</code>
                  </td>
                  <td>{formatTime(entry.created_at, i18n.language)}</td>
                  <td>
                    {entry.last_used_at
                      ? formatTime(entry.last_used_at, i18n.language)
                      : t('sync_keys_never_used')}
                  </td>
                  <td className="text-right">
                    {confirmRevokeId === entry.id ? (
                      <span>
                        <Button
                          bsStyle="danger"
                          bsSize="xsmall"
                          disabled={isRevoking}
                          onClick={() => handleRevoke(entry.id)}
                        >
                          {isRevoking
                            ? t('sync_keys_revoking')
                            : t('sync_keys_confirm_revoke')}
                        </Button>{' '}
                        <Button
                          bsSize="xsmall"
                          disabled={isRevoking}
                          onClick={() => setConfirmRevokeId(null)}
                        >
                          {t('cancel')}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        bsSize="xsmall"
                        onClick={() => setConfirmRevokeId(entry.id)}
                      >
                        {t('sync_keys_revoke')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-muted small">{t('sync_keys_revoke_note')}</p>
    </div>
  )
}

export default SyncKeysSection
