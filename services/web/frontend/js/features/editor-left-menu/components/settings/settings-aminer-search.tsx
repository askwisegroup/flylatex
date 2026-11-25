import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getJSON, postJSON } from '../../../../infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'

/**
 * 设置 → AI 助手 → AMiner 搜索（互联网论文检索）
 *
 * FIXED: 2026-11-01
 * 背景：AI 之前只能查 CrossRef + 个人知识库（search_references）。想让它
 * “去互联网上找论文 / 核对某篇文献是否真实存在”，需要接入 AMiner 开放平台。
 *
 * 设计要点（默认关闭）：
 * - 每个用户填自己的 token，存 user.ace.aminerApiKey（**只在服务端**读写）
 * - 留空 = 只用 CrossRef：FIXED 2026-11 检索工具合并成 search_literature 之后，
 *   工具本身始终下发给模型（没有 Key 时它内部只用 CrossRef 源，不会报错）
 * - 非空时服务端先拿它做一次真实检索验证，通过才落库（避免“填了但一直失败”）
 * - 浏览器永远拿不到明文 token：状态接口只回 configured + 掩码
 */
type AminerStatus = {
  configured: boolean
  masked: string
}

const AMINER_OPEN_URL = 'https://open.aminer.cn/open'

export default function SettingsAminerSearch() {
  const { t } = useTranslation()

  const [status, setStatus] = useState<AminerStatus>({
    configured: false,
    masked: '',
  })
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  )

  const loadStatus = useCallback(async () => {
    try {
      const payload = await getJSON<{ code: number; data: AminerStatus }>(
        '/ft-ai/aminer-status'
      )
      setStatus({
        configured: Boolean(payload?.data?.configured),
        masked: payload?.data?.masked || '',
      })
    } catch (error) {
      // 拿不到状态不影响填写：只是显示成「未启用」
      debugConsole.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const save = useCallback(async () => {
    const key = draft.trim()
    if (!key) return
    setSaving(true)
    setMessage(null)
    try {
      const payload = await postJSON<{ code: number; data: AminerStatus }>(
        '/ft-ai/aminer-key',
        { body: { key } }
      )
      setStatus({
        configured: Boolean(payload?.data?.configured),
        masked: payload?.data?.masked || '',
      })
      setDraft('')
      setMessage({
        ok: true,
        text: t('aminer_key_saved', {
          defaultValue: '已保存，互联网论文检索已启用',
        }),
      })
    } catch (error: any) {
      // 服务端把验证失败的原因放在 body.msg（如「Token 已过期（code=40302）」）
      const reason = error?.data?.msg || error?.message || '保存失败'
      setMessage({ ok: false, text: reason })
    } finally {
      setSaving(false)
    }
  }, [draft, t])

  const clear = useCallback(async () => {
    setSaving(true)
    setMessage(null)
    try {
      await postJSON('/ft-ai/aminer-key', { body: { key: '' } })
      setStatus({ configured: false, masked: '' })
      setDraft('')
      setMessage({
        ok: true,
        text: t('aminer_key_cleared', {
          defaultValue: '已关闭互联网论文检索',
        }),
      })
    } catch (error: any) {
      setMessage({
        ok: false,
        text: error?.data?.msg || error?.message || '操作失败',
      })
    } finally {
      setSaving(false)
    }
  }, [t])

  return (
    <div className="form-group left-menu-setting">
      <label htmlFor="settings-menu-aminer-key">
        {t('aminer_search', { defaultValue: 'AMiner 搜索' })}
      </label>

      <div className="settings-aminer-search">
        <p className="settings-aminer-hint">
          {t('aminer_search_hint', {
            defaultValue:
              '让 AI 在互联网上检索论文、核对某篇文献是否真实存在（与 CrossRef 检索互补）。需要你自己的 AMiner 开放平台 API Key：',
          })}{' '}
          <a href={AMINER_OPEN_URL} target="_blank" rel="noreferrer noopener">
            open.aminer.cn/open
          </a>{' '}
          {t('aminer_search_hint_tail', {
            defaultValue: '（注册 / 充值后生成 token）。留空表示不启用。',
          })}
        </p>

        <input
          id="settings-menu-aminer-key"
          className="form-control"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          disabled={saving}
          placeholder={
            status.configured
              ? t('aminer_key_placeholder_configured', {
                  defaultValue: `已配置（${status.masked}），想更换请粘贴新的 Key`,
                  masked: status.masked,
                })
              : t('aminer_key_placeholder', {
                  defaultValue: '粘贴 AMiner API Key',
                })
          }
        />

        <div className="settings-aminer-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={save}
            disabled={saving || loading || draft.trim() === ''}
          >
            {saving
              ? t('saving', { defaultValue: '保存中…' })
              : t('aminer_key_verify_save', {
                  defaultValue: '验证并保存',
                })}
          </button>

          {/* FIXED: 2026-11-01 「清除（关闭）」原来用 .btn-default：
              柔和主题里它的底色与面板底色几乎同色，看起来就是一行文字
              （默认/亮色主题是深灰蓝底，所以只有柔和主题异常）。
              改用与主题色无关的红色描边按钮（样式见 left-menu.less 的 .settings-aminer-clear），
              三种主题下都看得清，hover 才填充。 */}
          {status.configured && (
            <button
              type="button"
              className="btn btn-sm settings-aminer-clear"
              onClick={clear}
              disabled={saving}
            >
              {t('aminer_key_clear', { defaultValue: '清除（关闭）' })}
            </button>
          )}

          <span
            className={`settings-aminer-status ${
              status.configured ? 'is-on' : 'is-off'
            }`}
          >
            {status.configured
              ? t('aminer_status_on', {
                  defaultValue: `已启用（${status.masked}）`,
                  masked: status.masked,
                })
              : t('aminer_status_off', { defaultValue: '未启用' })}
          </span>
        </div>

        {message && (
          <p
            className={`settings-aminer-message ${
              message.ok ? 'is-ok' : 'is-error'
            }`}
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  )
}
