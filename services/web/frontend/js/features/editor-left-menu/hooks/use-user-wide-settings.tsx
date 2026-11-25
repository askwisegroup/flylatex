import { useCallback } from 'react'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import useSetOverallTheme from './use-set-overall-theme'
import useSaveUserSettings from './use-save-user-settings'
import { getPairedEditorTheme } from '../utils/theme-pairing'
import type { UserSettings } from '../utils/api'

export default function useUserWideSettings() {
  const saveUserSettings = useSaveUserSettings()

  // this may be undefined on test environments
  const [userSettings] = useScopeValue<UserSettings | undefined>(
    'settings',
    true
  )

  const setOverallTheme = useSetOverallTheme()
  const setAutoComplete = useCallback(
    (autoComplete: UserSettings['autoComplete']) => {
      saveUserSettings('autoComplete', autoComplete)
    },
    [saveUserSettings]
  )

  const setAutoPairDelimiters = useCallback(
    (autoPairDelimiters: UserSettings['autoPairDelimiters']) => {
      saveUserSettings('autoPairDelimiters', autoPairDelimiters)
    },
    [saveUserSettings]
  )

  const setSyntaxValidation = useCallback(
    (syntaxValidation: UserSettings['syntaxValidation']) => {
      saveUserSettings('syntaxValidation', syntaxValidation)
    },
    [saveUserSettings]
  )

  const setEditorTheme = useCallback(
    (editorTheme: UserSettings['editorTheme']) => {
      saveUserSettings('editorTheme', editorTheme)
    },
    [saveUserSettings]
  )

  // FIXED: 2026-10-29 切换全局主题时，把编辑器（语法）主题一并切到推荐的那一个。
  // 用户如果已经自己选过其他编辑器主题，就不再插手（只在"当前用的就是推荐值"时才改）。
  // FIXED: 2026-11-05 判断逻辑抽到 theme-pairing.ts 的 getPairedEditorTheme，
  // 项目列表页的快捷切换复用同一份，行为保持一致。
  const setOverallThemeWithEditorTheme = useCallback(
    (overallTheme: UserSettings['overallTheme']) => {
      const nextEditorTheme = getPairedEditorTheme(
        userSettings?.editorTheme,
        userSettings?.overallTheme,
        overallTheme
      )

      setOverallTheme(overallTheme)

      if (nextEditorTheme) {
        setEditorTheme(nextEditorTheme)
      }
    },
    [
      userSettings?.editorTheme,
      userSettings?.overallTheme,
      setOverallTheme,
      setEditorTheme,
    ]
  )

  const setMode = useCallback(
    (mode: UserSettings['mode']) => {
      saveUserSettings('mode', mode)
    },
    [saveUserSettings]
  )

  const setFontSize = useCallback(
    (fontSize: UserSettings['fontSize']) => {
      saveUserSettings('fontSize', fontSize)
    },
    [saveUserSettings]
  )

  const setFontFamily = useCallback(
    (fontFamily: UserSettings['fontFamily']) => {
      saveUserSettings('fontFamily', fontFamily)
    },
    [saveUserSettings]
  )

  const setLineHeight = useCallback(
    (lineHeight: UserSettings['lineHeight']) => {
      saveUserSettings('lineHeight', lineHeight)
    },
    [saveUserSettings]
  )

  // FIXED: 2026-10-30 AI 面板展示位置（侧边 / 底部停靠）
  const setAIPanelLayout = useCallback(
    (aiPanelLayout: UserSettings['aiPanelLayout']) => {
      saveUserSettings('aiPanelLayout', aiPanelLayout)
    },
    [saveUserSettings]
  )

  // FIXED: 2026-11-01 设置的显示方式（左侧面板 / 居中弹窗）
  const setSettingsPanelMode = useCallback(
    (settingsPanelMode: UserSettings['settingsPanelMode']) => {
      saveUserSettings('settingsPanelMode', settingsPanelMode)
    },
    [saveUserSettings]
  )

  // FIXED: 2026-11-01 搜索/替换面板位置（底部 / 顶部）
  const setSearchPanelPosition = useCallback(
    (searchPanelPosition: UserSettings['searchPanelPosition']) => {
      saveUserSettings('searchPanelPosition', searchPanelPosition)
    },
    [saveUserSettings]
  )

  // FIXED: 2026-11-02 自动探测编译器（编译失败时读日志决定是否切到 XeLaTeX/LuaLaTeX）
  const setAutoDetectCompiler = useCallback(
    (autoDetectCompiler: UserSettings['autoDetectCompiler']) => {
      saveUserSettings('autoDetectCompiler', autoDetectCompiler)
    },
    [saveUserSettings]
  )

  // FIXED: 2026-11-06 导航栏是否显示项目/文章标题（默认不显示）
  const setNavbarShowTitle = useCallback(
    (navbarShowTitle: UserSettings['navbarShowTitle']) => {
      saveUserSettings('navbarShowTitle', navbarShowTitle)
    },
    [saveUserSettings]
  )

  // FIXED: 2026-11-08 AI 助手默认 LLM 模型（空串 = 跟随系统默认）
  const setAIModel = useCallback(
    (aiModel: UserSettings['aiModel']) => {
      saveUserSettings('aiModel', aiModel)
    },
    [saveUserSettings]
  )

  const setPdfViewer = useCallback(
    (pdfViewer: UserSettings['pdfViewer']) => {
      saveUserSettings('pdfViewer', pdfViewer)
    },
    [saveUserSettings]
  )

  return {
    autoComplete: userSettings?.autoComplete,
    setAutoComplete,
    autoPairDelimiters: userSettings?.autoPairDelimiters,
    setAutoPairDelimiters,
    syntaxValidation: userSettings?.syntaxValidation,
    setSyntaxValidation,
    editorTheme: userSettings?.editorTheme,
    setEditorTheme,
    overallTheme: userSettings?.overallTheme,
    setOverallTheme: setOverallThemeWithEditorTheme,
    mode: userSettings?.mode,
    setMode,
    fontSize: userSettings?.fontSize,
    setFontSize,
    fontFamily: userSettings?.fontFamily,
    setFontFamily,
    lineHeight: userSettings?.lineHeight,
    setLineHeight,
    pdfViewer: userSettings?.pdfViewer,
    setPdfViewer,
    aiPanelLayout: userSettings?.aiPanelLayout ?? 'side',
    setAIPanelLayout,
    settingsPanelMode: userSettings?.settingsPanelMode ?? 'modal',
    setSettingsPanelMode,
    searchPanelPosition: userSettings?.searchPanelPosition ?? 'bottom',
    setSearchPanelPosition,
    autoDetectCompiler: userSettings?.autoDetectCompiler ?? false,
    setAutoDetectCompiler,
    // FIXED: 2026-11-06 导航栏标题开关
    navbarShowTitle: userSettings?.navbarShowTitle ?? false,
    setNavbarShowTitle,
    // FIXED: 2026-11-08 AI 助手默认 LLM 模型
    aiModel: userSettings?.aiModel ?? '',
    setAIModel,
  }
}
