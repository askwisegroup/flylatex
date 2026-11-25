import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SettingsMenuSelect, { Optgroup, Option } from './settings-menu-select'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import { getJSON } from '../../../../infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import getMeta from '../../../../utils/meta'

/**
 * AI 助手默认 LLM 模型（设置 → AI 助手）。
 *
 * FIXED: 2026-11-08
 * 背景：以前用哪个模型是后端运行时"猜"出来的 —— 环境变量没配就去网关模型清单里
 * 按偏好表挑一个，同一个部署换了配置/网关换了清单，用户看到的就是"模型总是乱换"。
 * 现在可以钉一个模型：保存到用户设置（ace.aiModel），/ft-ai 每次请求都读它。
 *
 * FIXED: 2026-11-20 可选「免费大模型」
 * NE LLM Service 质量好但慢，所以下拉里多了第二组：免费大模型
 * （配置放在 MongoDB 的 llm_catalog 集合，由运营后台 carsi-mgr——独立仓库——的「免费模型」页维护；
 * 后端读取见 commercial/free-models.js，按模型组织，以后接别家的
 * 免费模型只需加一条配置）。两者存的都是模型 id，后端按 id 决定走哪个上游：
 *   - 免费模型 → 该模型自己的地址与密钥，不占用 NE 额度（billing=free）
 *   - 其余      → NE 网关，行为与以前完全一致
 * 免费模型不可用时后端会自动回落到 NE 模型，所以选它不会把功能选挂。
 *
 * 选项来自 GET /ft-ai/models：
 *   models     = 当前 NE 账号凭据能用的对话模型（不含 embedding/语音/图像）
 *   freeModels = 免费大模型目录（后端已按下发字段清洗，不含密钥）
 * 第一项「跟随系统默认」= 空串，行为与以前完全一致 —— 所以这个设置默认就是它。
 */
type FreeModel = {
  id: string
  label: string
  vendor?: string
  tier?: string
  note?: string
  supportsTools?: boolean
  supportsVision?: boolean
}

type ModelsPayload = {
  models: string[]
  freeModels?: FreeModel[]
  selected: string
  systemDefault: string | null
  envModel: string | null
  gatewayReachable: boolean
}

export default function SettingsAIModel() {
  const { t } = useTranslation()
  const { aiModel, setAIModel } = useProjectSettingsContext()
  // 部署档位（cn = NE 网关 / sg = OpenAI 兼容接口），只影响文案，不影响逻辑
  const exposed = getMeta('ol-ExposedSettings') as
    | { deployment?: { isGlobal?: boolean } }
    | undefined
  const isGlobalDeployment = exposed?.deployment?.isGlobal === true

  const [models, setModels] = useState<string[]>([])
  const [freeModels, setFreeModels] = useState<FreeModel[]>([])
  const [systemDefault, setSystemDefault] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    getJSON<ModelsPayload>('/ft-ai/models')
      .then(payload => {
        if (!alive) return
        setModels(Array.isArray(payload?.models) ? payload.models : [])
        setFreeModels(
          Array.isArray(payload?.freeModels) ? payload.freeModels : []
        )
        setSystemDefault(payload?.systemDefault || '')
      })
      .catch(error => {
        // 拿不到清单不算错误：只显示「跟随系统默认」，设置项本身仍然可用
        debugConsole.error(error)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const options = useMemo<Array<Option<string>>>(() => {
    // defaultValue 只是兜底：语言包里一定会有这几个 key，但如果浏览器缓存了旧的
    // 语言包 chunk（它的文件名是内容哈希，理论上不会），至少不会把 i18n key
    // 原样显示出来（"ai_model_follow_default_named"）。
    const autoLabel = systemDefault
      ? t('ai_model_follow_default_named', {
          model: systemDefault,
          defaultValue: `跟随系统默认（${systemDefault}）`,
        })
      : t('ai_model_follow_default', { defaultValue: '跟随系统默认' })
    return [{ value: '', label: autoLabel }]
  }, [systemDefault, t])

  // FIXED: 2026-11-18 下拉里不再拼「（免费 · 快）」这种引导式后缀：
  // 显示名一律等于目录里运营配置的 label（DB 的 models[].label），
  // 前端不得自己再加工/美化模型名（之前是 `${label}（${tag}）`）。
  // OLD: const tag = t('ai_model_free_tag', ...); label: `${label}（${tag}）`
  const freeOptions = useMemo<Array<Option<string>>>(() => {
    return freeModels.map(entry => ({
      value: entry.id,
      label: entry.label || entry.id,
    }))
  }, [freeModels])

  const neOptions = useMemo<Array<Option<string>>>(() => {
    // 已经钉住、但清单里没有的模型也要显示出来，
    // 否则 select 的 value 找不到对应 option，控件会显示成空白。
    const known = new Set([...models, ...freeModels.map(entry => entry.id)])
    const pinned = aiModel && !known.has(aiModel) ? [aiModel] : []
    const sorted = [...new Set(models)].sort((a, b) => a.localeCompare(b))

    return [...pinned, ...sorted].map(id => ({ value: id, label: id }))
  }, [aiModel, models, freeModels])

  const optgroups = useMemo<Array<Optgroup<string>>>(() => {
    const groups: Array<Optgroup<string>> = []
    if (freeOptions.length > 0) {
      groups.push({
        label: t('ai_model_free_group', {
          // FIXED: 2026-11-18 分组名只说明「这是另一组」，不再写「响应快，不占用额度」这类引导语
          defaultValue: '免费大模型',
        }),
        options: freeOptions,
      })
    }
    groups.push({
      // FIXED: 2026-11-25 分组名跟着部署档位走。
      // 海外站（DEPLOYMENT_PROFILE=sg）上游是 OpenAI 兼容接口，不是 NE 网关，
      // 下拉里再写「NE LLM Service」就是在客户面前给错信息。
      label: isGlobalDeployment
        ? t('ai_model_upstream_group', { defaultValue: 'LLM Service' })
        : t('ai_model_ne_group', { defaultValue: 'NE LLM Service' }),
      options: neOptions,
    })
    return groups
  }, [freeOptions, neOptions, t, isGlobalDeployment])

  const handleChange = useCallback(
    (value: string) => {
      setAIModel(value)
    },
    [setAIModel]
  )

  return (
    <SettingsMenuSelect<string>
      onChange={handleChange}
      value={aiModel ?? ''}
      options={options}
      optgroups={optgroups}
      label={t('ai_model', { defaultValue: '默认 LLM 模型' })}
      name="aiModel"
      loading={loading}
    />
  )
}
