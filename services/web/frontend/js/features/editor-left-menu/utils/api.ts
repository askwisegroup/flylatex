import type {
  FontFamily,
  LineHeight,
  OverallTheme,
} from '../../source-editor/extensions/theme'
import type {
  AIPanelLayout,
  Keybindings,
  NavbarShowTitle,
  PdfViewer,
  ProjectCompiler,
  SearchPanelPosition,
  SettingsPanelMode,
} from '../../../../../types/project-settings'
import { sendMB } from '../../../infrastructure/event-tracking'
import { postJSON } from '../../../infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'

export type UserSettings = {
  pdfViewer: PdfViewer
  autoComplete: boolean
  autoPairDelimiters: boolean
  syntaxValidation: boolean
  editorTheme: string
  overallTheme: OverallTheme
  mode: Keybindings
  fontSize: string
  fontFamily: FontFamily
  lineHeight: LineHeight
  aiPanelLayout: AIPanelLayout
  settingsPanelMode: SettingsPanelMode
  searchPanelPosition: SearchPanelPosition
  // FIXED: 2026-11-02 自动探测编译器（设置 → 编译与项目）
  autoDetectCompiler: boolean
  // FIXED: 2026-11-06 导航栏是否显示项目/文章标题（设置 → 通用）
  navbarShowTitle: NavbarShowTitle
  // FIXED: 2026-11-08 AI 助手默认 LLM 模型（设置 → AI 助手）。空串 = 跟随系统默认
  aiModel: string
}

export type ProjectSettings = {
  compiler: ProjectCompiler
  imageName: string
  rootDocId: string
  spellCheckLanguage: string
  name: string
}

type SaveUserSettings = Partial<
  UserSettings & {
    spellCheckLanguage: ProjectSettings['spellCheckLanguage']
  }
>

export function saveUserSettings(
  key: keyof SaveUserSettings,
  value: SaveUserSettings[keyof SaveUserSettings]
) {
  sendMB('setting-changed', {
    changedSetting: key,
    changedSettingVal: value,
  })

  postJSON('/user/settings', {
    body: {
      [key]: value,
    },
  }).catch(debugConsole.error)
}

export const saveProjectSettings = async (
  projectId: string,
  data: Partial<ProjectSettings>
) => {
  await postJSON<never>(`/project/${projectId}/settings`, {
    body: {
      ...data,
    },
  })
}
