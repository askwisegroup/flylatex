import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getJSON, postJSON } from '../../../../infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'

/**
 * 设置 → AI 助手 → Agent 耐心程度
 *
 * FIXED: 2026-11
 * 背景：单轮的三个上限（最多 50 步工具调用 / 每轮最多编译 2 次 / 单轮最多 10 分钟）
 * 原来是写死的常量。结果两头都不讨好：
 *   - 只想改个错别字：它还在那转满 50 步；
 *   - 「整章重写 + 反复编译」：撞上限后只能停下汇报（虽是软着陆，但活没干完）。
 *
 * 设计要点：
 * - 存的是**档位名**（strict / standard / patient），不是三个裸数字：
 *   暴露裸数字等于让用户自己调参，还会绕过服务端的 clamp。
 * - 默认 standard = 原来的值，没选过的人行为完全不变。
 * - 每档的实际参数（步数 / 编译次数 / 分钟）由服务端算好下发，前端只负责展示：
 *   以后调规则不用同步改前端文案里的数字。
 * - 保存后**下一轮对话**生效（正在跑的那一轮不会中途变卦）。
 */
type EffortOption = {
  level: string
  label: string
  maxIterations: number
  compileCallLimit: number
  maxRunMs: number
}

type EffortPayload = {
  level: string
  label: string
  options: EffortOption[]
  effective: {
    maxIterations: number
    compileCallLimit: number
    maxRunMs: number
  }
}

const EFFORT_LEVELS = ['strict', 'standard', 'patient']

export default function SettingsAgentEffort() {
  const { t } = useTranslation()

  const [payload, setPayload] = useState<EffortPayload | null>(null)
  const [level, setLevel] = useState('standard')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  )

  useEffect(() => {
    let alive = true
    getJSON<{ code: number; data: EffortPayload }>('/ft-ai/agent-effort')
      .then(result => {
        if (!alive) return
        setPayload(result?.data || null)
        if (result?.data?.level) setLevel(result.data.level)
      })
      .catch(error => {
        // 拿不到就按 standard 显示：这一项不该因为状态接口失败而消失
        debugConsole.error(error)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // 档位 → 三个参数。服务端没给（理论上不会）时用 standard 的旧值兜底。
  const levelParams = useCallback(
    (levelName: string) => {
      const found = (payload?.options || []).find(
        item => item.level === levelName
      )
      return {
        maxIterations: found?.maxIterations ?? 50,
        compileCallLimit: found?.compileCallLimit ?? 2,
        minutes: Math.round((found?.maxRunMs ?? 600000) / 60000),
      }
    },
    [payload]
  )

  // 选项文案只放名字：设置面板最窄处只有 ~160px，带数字的选项会被原生 select 截断
  // （「标准（最多 50 步 · 2 次…」），看起来像坏了。数字放到下面那行说明里。
  const options = useMemo(
    () =>
      EFFORT_LEVELS.map(levelName => ({
        value: levelName,
        label: t(`agent_effort_${levelName}`, { defaultValue: levelName }),
      })),
    [t]
  )

  const current = levelParams(level)

  const handleChange = useCallback(
    (nextLevel: string) => {
      const previous = level
      setLevel(nextLevel)
      setSaving(true)
      setMessage(null)
      postJSON<{ code: number; data: EffortPayload }>('/ft-ai/agent-effort', {
        body: { level: nextLevel },
      })
        .then(result => {
          if (result?.data) setPayload(result.data)
          setMessage({
            ok: true,
            text: t('agent_effort_saved', {
              defaultValue: '已保存，下一轮对话生效',
            }),
          })
        })
        .catch((error: any) => {
          // 存不上就回滚下拉框，别让界面显示一个其实没生效的值
          setLevel(previous)
          setMessage({
            ok: false,
            text:
              error?.data?.msg ||
              t('agent_effort_save_failed', {
                defaultValue: '保存失败，请重试',
              }),
          })
        })
        .finally(() => setSaving(false))
    },
    [level, t]
  )

  return (
    <div className="form-group left-menu-setting">
      <label htmlFor="settings-menu-agent-effort">
        {t('agent_effort', { defaultValue: 'Agent 耐心程度' })}
      </label>

      <div className="settings-agent-effort">
        <select
          id="settings-menu-agent-effort"
          className="form-control"
          value={level}
          onChange={event => handleChange(event.target.value)}
          disabled={loading || saving}
        >
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <p className="settings-agent-effort-current">
          {t('agent_effort_current', {
            maxIterations: current.maxIterations,
            compileCallLimit: current.compileCallLimit,
            minutes: current.minutes,
            defaultValue:
              '当前：最多 __maxIterations__ 步 · __compileCallLimit__ 次编译 · __minutes__ 分钟',
          })}
        </p>

        <p className="settings-agent-effort-hint">
          {t('agent_effort_hint', {
            defaultValue:
              '任务复杂就调高一档，只想快速改个小地方就调低；保存后下一轮对话生效。',
          })}
        </p>

        {(saving || message) && (
          <p
            className={`settings-agent-effort-message ${
              saving ? 'is-pending' : message?.ok ? 'is-ok' : 'is-error'
            }`}
          >
            {saving ? t('saving', { defaultValue: '保存中…' }) : message?.text}
          </p>
        )}
      </div>
    </div>
  )
}
