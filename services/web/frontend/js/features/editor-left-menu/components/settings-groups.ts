import type { ComponentType } from 'react'
import SettingsCompiler from './settings/settings-compiler'
import SettingsAutoDetectCompiler from './settings/settings-auto-detect-compiler'
import SettingsImageName from './settings/settings-image-name'
import SettingsDocument from './settings/settings-document'
import SettingsSpellCheckLanguage from './settings/settings-spell-check-language'
import SettingsDictionary from './settings/settings-dictionary'
import SettingsAutoComplete from './settings/settings-auto-complete'
import SettingsAutoCloseBrackets from './settings/settings-auto-close-brackets'
import SettingsSyntaxValidation from './settings/settings-syntax-validation'
import SettingsEditorTheme from './settings/settings-editor-theme'
import SettingsOverallTheme from './settings/settings-overall-theme'
import SettingsKeybindings from './settings/settings-keybindings'
import SettingsFontSize from './settings/settings-font-size'
import SettingsFontFamily from './settings/settings-font-family'
import SettingsLineHeight from './settings/settings-line-height'
// FIXED: 2026-11-16 编辑器多文件页签的显示开关（浏览器本地偏好）
import SettingsEditorTabs from './settings/settings-editor-tabs'
import SettingsPdfViewer from './settings/settings-pdf-viewer'
import SettingsAIPanelLayout from './settings/settings-ai-panel-layout'
import SettingsAIModel from './settings/settings-ai-model'
// FIXED: 2026-11-01 设置 → AI 助手 → AMiner 搜索（互联网论文检索，默认关闭）
import SettingsAminerSearch from './settings/settings-aminer-search'
// FIXED: 2026-11-16 「系统集成」新分组：AMiner / Zotero，后续集成都往这里加
import SettingsZotero from './settings/settings-zotero'
// FIXED: 2026-11-01 AI 用量摘要（与账号设置页同一个网关账本）
import SettingsAIUsage from './settings/settings-ai-usage'
import SettingsPanelModeSelect from './settings/settings-panel-mode'
import SettingsSearchPanelPositionSelect from './settings/settings-search-panel-position'
import SettingsNavbarTitle from './settings/settings-navbar-title'
// FIXED: 2026-11 设置 → AI 助手 → Agent 耐心程度（步数 / 编译次数 / 单轮时长档位）
import SettingsAgentEffort from './settings/settings-agent-effort'
// FIXED: 2026-11-13 设置 → AI 助手 → MCP 服务（用户自己接入的远程 MCP 服务）
import SettingsMcpServers from './settings/settings-mcp-servers'

/**
 * 设置项的分类表 —— 弹窗模式（分类展示）和左侧面板模式共用这一份。
 *
 * FIXED: 2026-11-01
 * 左侧面板按这个数组「拍平」后渲染，顺序必须保持和原来完全一致，
 * 否则默认（左侧面板）模式的行序会变。所以新增的「设置的显示方式」
 * 放在最后一组，保持它排在所有旧设置项之后。
 *
 * 新增设置项时：加到对应分组的 items 里，并在 locales + 白名单里补 key。
 */
export type SettingsGroup = {
  id: string
  labelKey: string
  items: Array<ComponentType>
}

export const settingsGroups: SettingsGroup[] = [
  {
    id: 'compile',
    labelKey: 'settings_group_compile',
    // 「自动探测编译器」紧跟编译器：它决定的就是编译器选择，不放到组尾
    items: [
      SettingsCompiler,
      SettingsAutoDetectCompiler,
      SettingsImageName,
      SettingsDocument,
    ],
  },
  {
    id: 'language',
    labelKey: 'settings_group_language',
    items: [SettingsSpellCheckLanguage, SettingsDictionary],
  },
  {
    id: 'editor',
    labelKey: 'settings_group_editor',
    items: [
      SettingsAutoComplete,
      SettingsAutoCloseBrackets,
      SettingsSyntaxValidation,
      SettingsEditorTheme,
      SettingsOverallTheme,
      SettingsKeybindings,
      SettingsFontSize,
      SettingsFontFamily,
      SettingsLineHeight,
      // FIXED: 2026-11-16 追加在末尾，保持旧设置项行序不变
      SettingsEditorTabs,
    ],
  },
  {
    id: 'pdf',
    labelKey: 'settings_group_pdf',
    items: [SettingsPdfViewer],
  },
  {
    id: 'ai',
    labelKey: 'settings_group_ai',
    // FIXED: 2026-11-08 默认 LLM 模型紧跟在 AI 面板位置下面（同一个「AI 助手」分组）
    // FIXED: 2026-11-01 AMiner 搜索（互联网论文检索）追加在末尾，不动旧行序
    items: [
      SettingsAIPanelLayout,
      SettingsAIModel,
      SettingsAIUsage,
      // FIXED: 2026-11 Agent 耐心程度追加在末尾，不动旧行序
      SettingsAgentEffort,
      // FIXED: 2026-11-13 MCP 服务（进阶功能，追加在 AI 分组最后）
      SettingsMcpServers,
    ],
  },
  {
    id: 'integrations',
    labelKey: 'settings_group_integrations',
    // FIXED: 2026-11-16 外部系统集成集中在这里（先有 AMiner 与 Zotero），
    // 后续再有集成（如其他文献库/云盘/同步服务）都追加到这个分组末尾。
    items: [SettingsAminerSearch, SettingsZotero],
  },
  {
    id: 'general',
    labelKey: 'settings_group_general',
    // 两个都是「显示方式」类的设置，放一起；新增项一律追加在末尾，
    // 保证左侧面板里旧设置项的行序不变
    items: [
      SettingsPanelModeSelect,
      SettingsSearchPanelPositionSelect,
      // FIXED: 2026-11-06 导航栏是否显示标题（追加在末尾，不动旧行序）
      SettingsNavbarTitle,
    ],
  },
]
