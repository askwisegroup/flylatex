import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { getJSON, postJSON } from '../../../../infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import getMeta from '@/utils/meta'
import { isVipUser } from '@/shared/utils/max-upload-size'

/**
 * 设置 → AI 助手 → MCP 服务（远程 MCP 客户端）
 *
 * FIXED: 2026-11-13 新增。
 *
 * 背景：Agent 的能力由本地工具固定（读文件、改文件、编译、检索…）。
 * 用户自己有一些 MCP 服务（公司知识库、文档站、代码检索…），
 * 希望 Agent 也能用上。这里让他们把服务地址贴进来，Agent 每轮会去
 * 拉一次工具清单（5 分钟缓存），以 mcp__ 开头的工具名注入给模型。
 *
 * 设计约束（都不是随便定的）：
 * - **列表不限数量，同时启用最多 10 个**：VIP 专属。
 *   FIXED: 2026-11-18 需求变更：可导入任意多，但同时生效的最多 10 个（含 10）。
 *   OLD: 最多 3 个（后来短暂改成 5 个），导入时也会被截断。
 *   FIXED: 2026-11-17 合计最多 15 个工具的限制按需求**暂时去掉**（后端
 *   maxTools 回 null）：15 个的总闸是「整份服务要么全进要么不进」，
 *   接两个各 10 工具的服务时第二个直接不生效，看起来像导入成功但没工具。
 *   代价是上下文：每个工具定义都占 token（本地已有 29 个工具），
 *   工具多的服务建议按需接入。
 * - **只支持远程 HTTP(S)**：本地 stdio 类型的 MCP（要起子进程）不支持，
 *   贴了 `command` 的直接给明确提示，而不是静默忽略。
 * - **认证头只显示掩码**：headers 里通常是用户自己的 key，浏览器端
 *   永远拿不到明文；要改就删掉重加（v1 有意不做「编辑已存 headers」，
 *   避免掩码被当成新值存回去）。
 * - 服务连不上不影响 Agent：那只是「这轮没有这些工具」。
 */

type RemoteServer = {
  id: string
  name: string
  url: string
  enabled: boolean
  headerKeys: string[]
  headers: Record<string, string>
  lastStatus: string
  lastCheckedAt: string | null
}

type ListPayload = {
  enabled: boolean
  vipOnly?: boolean
  servers: RemoteServer[]
  // FIXED: 2026-11-18 后端：列表不限（maxServers = null），只限「同时启用」个数
  limits: {
    maxServers: number | null
    maxEnabledServers: number
    maxStoredServers?: number
    maxTools: number | null
  }
}

type Draft = {
  key: string
  id?: string
  name: string
  url: string
  enabled: boolean
  headerKeys: string[]
  /** 新增/粘贴进来的才带明文；已保存的为 null（表示「保持服务端原样」） */
  headers: Record<string, string> | null
  test?: {
    state: 'idle' | 'testing' | 'ok' | 'error'
    text?: string
    tools?: string[]
    toolCount?: number
    overLimit?: boolean
  }
}

let draftSeq = 0
function nextKey() {
  draftSeq += 1
  return `draft_${draftSeq}`
}

/**
 * 解析用户粘贴的内容。支持三种常见写法：
 *   1. Claude Desktop 风格：{ "mcpServers": { "名字": { "url": "...", "headers": {...} } } }
 *   2. 数组：[{ "name": "...", "url": "..." }]
 *   3. 单个：{ "url": "..." }
 * 带 command 的（本地 stdio）单独挑出来报「不支持」。
 */
export function parseMcpConfig(
  text: string
):
  | { ok: true; drafts: Draft[]; skipped: string[] }
  | { ok: false; error: string } {
  const raw = (text || '').trim()
  if (!raw) return { ok: false, error: '请先粘贴配置' }

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (error: any) {
    return { ok: false, error: `不是合法的 JSON：${error?.message || ''}` }
  }

  const drafts: Draft[] = []
  const skipped: string[] = []

  const push = (name: string, item: any) => {
    if (!item || typeof item !== 'object') return
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (!url) {
      // 本地 stdio 服务（要起子进程）不支持，明确说出来
      if (item.command) skipped.push(name || String(item.command))
      return
    }
    const headers: Record<string, string> = {}
    if (item.headers && typeof item.headers === 'object') {
      for (const [key, value] of Object.entries(item.headers)) {
        headers[key] = String(value == null ? '' : value)
      }
    }
    drafts.push({
      key: nextKey(),
      name: (name || item.name || '').toString().trim() || '未命名服务',
      url,
      enabled: item.enabled !== false && item.disabled !== true,
      headerKeys: Object.keys(headers),
      headers,
      test: { state: 'idle' },
    })
  }

  if (Array.isArray(parsed)) {
    parsed.forEach((item, index) =>
      push(item && item.name ? String(item.name) : `服务${index + 1}`, item)
    )
  } else if (parsed && typeof parsed === 'object') {
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      for (const [name, item] of Object.entries(parsed.mcpServers)) {
        push(name, item)
      }
    } else {
      push(parsed.name || '服务', parsed)
    }
  }

  if (!drafts.length) {
    return {
      ok: false,
      error: skipped.length
        ? `不支持本地命令（stdio）类型的 MCP：${skipped.join('、')}。请部署成远程服务后填 URL。`
        : '没解析出任何服务，需要有 url 字段',
    }
  }
  return { ok: true, drafts, skipped }
}

/**
 * FIXED: 2026-11-15 导出结构。
 *
 * 用 Claude Desktop 的 mcpServers 写法，正好能被上面的 parseMcpConfig 原样读回，
 * 所以「导出 → 改 → 导入」是闭环的，不需要另写一套解析。
 *
 * 为什么 headers 可能缺席：服务端的 headers 只回掩码（见 mcp-routes.js maskHeaders），
 * 浏览器里没有明文。把 `****` 写进文件再导回来会覆盖真实 key，
 * 所以已保存服务的认证头一律不导出，只记下键名，并在导出提示里说清楚。
 */
export type McpExport = {
  version: number
  exportedAt: string
  mcpServers: Record<
    string,
    {
      url: string
      enabled: boolean
      headers?: Record<string, string>
      headersOmitted?: string[]
    }
  >
  headersOmittedNote?: string
}

export function buildMcpExport(drafts: Draft[]): McpExport {
  const mcpServers: McpExport['mcpServers'] = {}
  let omitted = 0

  for (const draft of drafts) {
    const item: McpExport['mcpServers'][string] = {
      url: draft.url,
      enabled: draft.enabled,
    }
    if (draft.headers && Object.keys(draft.headers).length > 0) {
      item.headers = draft.headers
    } else if (draft.headerKeys.length > 0) {
      item.headersOmitted = draft.headerKeys
      omitted += 1
    }
    mcpServers[draft.name || draft.url] = item
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    mcpServers,
    ...(omitted > 0
      ? {
          headersOmittedNote: `有 ${omitted} 个服务的认证头没有导出（服务端只保存掩码），导入后需要重新填写。`,
        }
      : {}),
  }
}

export default function SettingsMcpServers() {
  const { t } = useTranslation()

  const [enabled, setEnabled] = useState(true)
  // FIXED: 2026-11-15 普通用户不展示配置入口，后端也会拒绝保存/测试。
  // 先用页面 meta 里的 VIP 状态初始化，避免非 VIP 打开设置时先闪一下配置表单。
  const [vipOnly, setVipOnly] = useState(() => !isVipUser(getMeta('ol-user')))
  // FIXED: 2026-11-18 列表不限（maxServers = null），只限「同时启用」个数（默认 10）
  // FIXED: 2026-11-17 maxTools 默认 null = 不限（后端已去掉 15 个的硬上限）
  const [limits, setLimits] = useState<{
    maxServers: number | null
    maxEnabledServers: number
    maxStoredServers?: number
    maxTools: number | null
  }>({ maxServers: null, maxEnabledServers: 10, maxTools: null })
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [paste, setPaste] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  )

  const applyPayload = useCallback((payload: ListPayload) => {
    setEnabled(payload.enabled !== false)
    setVipOnly(payload.vipOnly === true)
    setLimits(
      payload.limits || {
        maxServers: null,
        maxEnabledServers: 10,
        maxTools: null,
      }
    )
    setDrafts(
      (payload.servers || []).map(server => ({
        key: server.id,
        id: server.id,
        name: server.name,
        url: server.url,
        enabled: server.enabled !== false,
        headerKeys: server.headerKeys || [],
        headers: null,
        test:
          server.lastStatus === 'ok'
            ? { state: 'ok', text: '上次检测：连接正常' }
            : server.lastStatus === 'error'
              ? { state: 'error', text: '上次检测：连接失败' }
              : { state: 'idle' },
      }))
    )
    setDirty(false)
  }, [])

  const load = useCallback(async () => {
    try {
      const payload = await getJSON<{ code: number; data: ListPayload }>(
        '/ft-ai/mcp-servers'
      )
      if (payload?.data) applyPayload(payload.data)
    } catch (error) {
      // 拿不到不影响手填，只是看不到已有配置
      debugConsole.error(error)
    } finally {
      setLoading(false)
    }
  }, [applyPayload])

  useEffect(() => {
    load()
  }, [load])

  // FIXED: 2026-11-15 粘贴与「导入 JSON 文件」共用一条解析路径，
  // 顺手按 URL 去重：同一份文件点两次不会变出两份配置。
  const addFromText = useCallback(
    (text: string) => {
      const result = parseMcpConfig(text)
      if (!result.ok) {
        setMessage({ ok: false, text: result.error })
        return
      }
      const seen = new Set(drafts.map(draft => draft.url))
      const fresh = result.drafts.filter(draft => !seen.has(draft.url))
      const duplicated = result.drafts.length - fresh.length

      // FIXED: 2026-11-18 导入不再按列表长度截断（可以导入任意多）。
      // 只把超出「同时启用」上限的部分自动取消启用 —— 服务照样进列表，
      // 用户随时可以自己勾回（或者先停用一个）。
      // OLD: const room = limits.maxServers - drafts.length
      //      const incoming = fresh.slice(0, room)
      let enabledSoFar = drafts.filter(draft => draft.enabled).length
      let autoDisabled = 0
      let incoming = fresh.map(draft => {
        if (!draft.enabled) return draft
        if (enabledSoFar < limits.maxEnabledServers) {
          enabledSoFar += 1
          return draft
        }
        autoDisabled += 1
        return { ...draft, enabled: false }
      })

      // 后端还有一道软保护（防止单文档无限膨胀），超了就只收前一部分
      const storedLimit = limits.maxStoredServers
      let trimmed = 0
      if (
        storedLimit != null &&
        drafts.length + incoming.length > storedLimit
      ) {
        const keep = Math.max(0, storedLimit - drafts.length)
        trimmed = incoming.length - keep
        incoming = incoming.slice(0, keep)
      }

      if (incoming.length > 0) {
        setDrafts(prev => [...prev, ...incoming])
        setDirty(true)
      }
      setMessage({
        ok: true,
        text:
          `已添加 ${incoming.length} 个服务` +
          (duplicated > 0 ? `（${duplicated} 个已在列表里，跳过）` : '') +
          (autoDisabled > 0
            ? `（同时最多启用 ${limits.maxEnabledServers} 个，多出的 ${autoDisabled} 个已停用，需要时手动启用）`
            : '') +
          (trimmed > 0 ? `（超出保存数量上限的 ${trimmed} 个已忽略）` : '') +
          (result.skipped.length
            ? `；跳过本地命令类型：${result.skipped.join('、')}`
            : ''),
      })
    },
    [drafts, limits.maxEnabledServers, limits.maxStoredServers]
  )

  const addFromPaste = useCallback(() => {
    addFromText(paste)
    setPaste('')
  }, [addFromText, paste])

  const fileRef = useRef<HTMLInputElement | null>(null)

  const importFromFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // 清空 value，否则同一个文件第二次选不会触发 onChange
      event.target.value = ''
      if (!file) return
      try {
        addFromText(await file.text())
      } catch (error: any) {
        setMessage({ ok: false, text: `读取文件失败：${error?.message || ''}` })
      }
    },
    [addFromText]
  )

  const exportConfig = useCallback(() => {
    const data = buildMcpExport(drafts)
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `flylatex-mcp-servers-${new Date()
        .toISOString()
        .slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      debugConsole.error(error)
    }
    setMessage({
      ok: true,
      text:
        `已导出 ${drafts.length} 个服务` +
        (data.headersOmittedNote ? `；${data.headersOmittedNote}` : ''),
    })
  }, [drafts])

  const updateDraft = useCallback((key: string, patch: Partial<Draft>) => {
    setDrafts(prev =>
      prev.map(item => (item.key === key ? { ...item, ...patch } : item))
    )
    setDirty(true)
  }, [])

  const removeDraft = useCallback((key: string) => {
    setDrafts(prev => prev.filter(item => item.key !== key))
    setDirty(true)
  }, [])

  // 测试只改 test 字段，不算「改动配置」，不能触发 dirty
  const setTest = useCallback((key: string, test: Draft['test']) => {
    setDrafts(prev =>
      prev.map(item => (item.key === key ? { ...item, test } : item))
    )
  }, [])

  const testOne = useCallback(
    async (draft: Draft) => {
      setTest(draft.key, { state: 'testing' })
      try {
        const body =
          draft.headers === null && draft.id
            ? { id: draft.id }
            : { url: draft.url, headers: draft.headers || {} }
        const payload = await postJSON<{ code: number; data: any }>(
          '/ft-ai/mcp-servers/test',
          { body }
        )
        const data = payload?.data || {}
        if (data.ok) {
          setTest(draft.key, {
            state: 'ok',
            text: `${data.serverInfo?.name || '连接正常'} · ${data.toolCount} 个工具`,
            tools: data.tools || [],
            toolCount: data.toolCount,
            overLimit: Boolean(data.overLimit),
          })
        } else {
          setTest(draft.key, {
            state: 'error',
            text: data.error || '连接失败',
          })
        }
      } catch (error: any) {
        setTest(draft.key, {
          state: 'error',
          text: error?.data?.msg || error?.message || '测试失败',
        })
      }
    },
    [setTest]
  )

  const save = useCallback(async () => {
    setSaving(true)
    setMessage(null)
    try {
      const payload = await postJSON<{ code: number; data: ListPayload }>(
        '/ft-ai/mcp-servers',
        {
          body: {
            servers: drafts.map(draft => ({
              // 没有 id 的是新增（服务端会分配）
              id: draft.id,
              name: draft.name,
              url: draft.url,
              enabled: draft.enabled,
              // null = 沿用服务端已存的认证头（浏览器只有掩码，没法回传明文）
              headers: draft.headers,
            })),
          },
        }
      )
      if (payload?.data) applyPayload(payload.data)
      setMessage({
        ok: true,
        text: t('mcp_servers_saved', {
          defaultValue: '已保存，下一轮对话生效',
        }),
      })
    } catch (error: any) {
      setMessage({
        ok: false,
        text: error?.data?.msg || error?.message || '保存失败',
      })
    } finally {
      setSaving(false)
    }
  }, [drafts, applyPayload, t])

  const draftCount = drafts.length
  // FIXED: 2026-11-18 列表不限，只限「同时启用」的个数
  // OLD: const overServerLimit = draftCount > limits.maxServers
  const enabledCount = drafts.filter(draft => draft.enabled).length
  const overServerLimit = enabledCount > limits.maxEnabledServers
  // 粗估工具数：只说「可能超」，真实判定在服务端（拿不到清单时无法判断）
  const knownToolTotal = useMemo(
    () =>
      drafts.reduce(
        (sum, draft) =>
          sum + (draft.test?.state === 'ok' ? draft.test.toolCount || 0 : 0),
        0
      ),
    [drafts]
  )

  // FIXED: 2026-11-15 非 VIP 直接不渲染 MCP 设置；服务端配置保留不动。
  if (vipOnly) {
    return null
  }

  if (!enabled) {
    return (
      <div className="form-group left-menu-setting">
        <label>{t('mcp_servers', { defaultValue: 'MCP 服务' })}</label>
        <p className="settings-mcp-hint">
          {t('mcp_servers_disabled', {
            defaultValue:
              '本实例已关闭 MCP 客户端（AI_MCP_CLIENT_ENABLED=0），暂时无法配置。',
          })}
        </p>
      </div>
    )
  }

  return (
    <div className="form-group left-menu-setting">
      <label htmlFor="settings-menu-mcp-paste">
        {t('mcp_servers', { defaultValue: 'MCP 服务' })}
      </label>

      <div className="settings-mcp">
        <p className="settings-mcp-hint">
          {t('mcp_servers_hint', {
            defaultValue:
              '让 AI 助手调用你自己配置的远程 MCP 服务（公司知识库、文档站、代码检索等）。只支持 https 远程地址，服务数量不限（工具数量不限制），但同时生效的最多 10 个。粘贴 Claude Desktop 风格的 mcpServers 配置即可：',
          })}
        </p>

        <textarea
          id="settings-menu-mcp-paste"
          className="form-control settings-mcp-paste"
          rows={4}
          spellCheck={false}
          value={paste}
          onChange={event => setPaste(event.target.value)}
          placeholder={
            '{\n  "mcpServers": {\n    "docs": { "url": "https://example.com/mcp" }\n  }\n}'
          }
        />

        <div className="settings-mcp-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={addFromPaste}
            disabled={saving || loading || !paste.trim()}
          >
            {t('mcp_servers_add', { defaultValue: '解析并添加' })}
          </button>
          {/* FIXED: 2026-11-15 导入 / 导出（数量不限，导出为 JSON 备份） */}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => fileRef.current?.click()}
            disabled={saving || loading}
          >
            {t('mcp_servers_import', { defaultValue: '导入 JSON 文件' })}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={exportConfig}
            disabled={saving || loading || drafts.length === 0}
          >
            {t('mcp_servers_export', { defaultValue: '导出 JSON' })}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={importFromFile}
          />
          <span className="settings-mcp-counter">
            {/* FIXED: 2026-11-18 服务总数不限，只显示「启用 X / 上限」 */}
            {draftCount} 个服务 · {enabledCount} / {limits.maxEnabledServers} 个启用
            {/* FIXED: 2026-11-17 不限工具数时只显示「已知 N 个工具」，
                否则会把 null 拼进文案里 */}
            {knownToolTotal > 0
              ? limits.maxTools != null
                ? ` · 已知 ${knownToolTotal} / ${limits.maxTools} 个工具`
                : ` · 已知 ${knownToolTotal} 个工具`
              : ''}
          </span>
        </div>

        {overServerLimit && (
          <p className="settings-mcp-message is-error">
            同时最多启用 {limits.maxEnabledServers} 个服务（当前启用{' '}
            {enabledCount} 个），请先停用几个再保存。
          </p>
        )}

        {drafts.length > 0 && (
          <ul className="settings-mcp-list">
            {drafts.map(draft => (
              <li key={draft.key} className="settings-mcp-item">
                <div className="settings-mcp-item-head">
                  <input
                    className="form-control settings-mcp-name"
                    value={draft.name}
                    disabled={saving}
                    onChange={event =>
                      updateDraft(draft.key, { name: event.target.value })
                    }
                    aria-label={t('mcp_servers_name', {
                      defaultValue: '服务名称',
                    })}
                  />
                  <label className="settings-mcp-toggle">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      disabled={saving}
                      onChange={event =>
                        updateDraft(draft.key, {
                          enabled: event.target.checked,
                        })
                      }
                    />
                    {t('mcp_servers_enabled', { defaultValue: '启用' })}
                  </label>
                </div>

                <input
                  className="form-control settings-mcp-url"
                  value={draft.url}
                  spellCheck={false}
                  disabled={saving}
                  onChange={event =>
                    updateDraft(draft.key, { url: event.target.value })
                  }
                  aria-label={t('mcp_servers_url', {
                    defaultValue: '服务地址',
                  })}
                />

                {draft.headerKeys.length > 0 && (
                  <p className="settings-mcp-headers">
                    {t('mcp_servers_headers', {
                      defaultValue: '认证头（只显示掩码，要改请删掉重加）：',
                    })}
                    {draft.headerKeys.join('、')}
                  </p>
                )}

                <div className="settings-mcp-item-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => testOne(draft)}
                    disabled={saving || draft.test?.state === 'testing'}
                  >
                    {draft.test?.state === 'testing'
                      ? '测试中…'
                      : t('mcp_servers_test', { defaultValue: '测试连接' })}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm settings-mcp-remove"
                    onClick={() => removeDraft(draft.key)}
                    disabled={saving}
                  >
                    {t('mcp_servers_remove', { defaultValue: '删除' })}
                  </button>
                  {draft.test && draft.test.state !== 'idle' && (
                    <span
                      className={`settings-mcp-item-status ${
                        draft.test.state === 'ok' ? 'is-ok' : 'is-error'
                      }`}
                    >
                      {draft.test.text}
                    </span>
                  )}
                </div>

                {/* FIXED: 2026-11-17 工具数不再设上限，overTotal 恒为 false，
                    这里再加一层 maxTools != null，避免恢复期间出现「null 个总上限」 */}
                {draft.test?.overLimit && limits.maxTools != null && (
                  <p className="settings-mcp-warn">
                    这个服务的工具数已超过 {limits.maxTools} 个总上限，接进去
                    Agent 会整份跳过。建议只接入工具少的服务。
                  </p>
                )}
                {draft.test?.state === 'ok' &&
                  draft.test.tools &&
                  draft.test.tools.length > 0 && (
                    <p className="settings-mcp-tools">
                      {draft.test.tools.slice(0, 8).join('、')}
                      {draft.test.tools.length > 8 ? ' …' : ''}
                    </p>
                  )}
              </li>
            ))}
          </ul>
        )}

        <div className="settings-mcp-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={save}
            disabled={saving || loading || overServerLimit}
          >
            {saving
              ? t('saving', { defaultValue: '保存中…' })
              : t('mcp_servers_save', { defaultValue: '保存' })}
          </button>
          {dirty && (
            <span className="settings-mcp-counter">
              {t('mcp_servers_unsaved', { defaultValue: '有未保存的改动' })}
            </span>
          )}
        </div>

        {message && (
          <p
            className={`settings-mcp-message ${
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
