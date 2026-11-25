import { createContext, FC, useContext, useMemo } from 'react'
import useProjectWideSettings from '../hooks/use-project-wide-settings'
import useUserWideSettings from '../hooks/use-user-wide-settings'
import useProjectWideSettingsSocketListener from '../hooks/use-project-wide-settings-socket-listener'
import type { ProjectSettings, UserSettings } from '../utils/api'

type ProjectSettingsSetterContextValue = {
  setCompiler: (compiler: ProjectSettings['compiler']) => void
  setImageName: (imageName: ProjectSettings['imageName']) => void
  setRootDocId: (rootDocId: ProjectSettings['rootDocId']) => void
  setSpellCheckLanguage: (
    spellCheckLanguage: ProjectSettings['spellCheckLanguage']
  ) => void
  setAutoComplete: (autoComplete: UserSettings['autoComplete']) => void
  setAutoPairDelimiters: (
    autoPairDelimiters: UserSettings['autoPairDelimiters']
  ) => void
  setSyntaxValidation: (
    syntaxValidation: UserSettings['syntaxValidation']
  ) => void
  setMode: (mode: UserSettings['mode']) => void
  setEditorTheme: (editorTheme: UserSettings['editorTheme']) => void
  setOverallTheme: (overallTheme: UserSettings['overallTheme']) => void
  setFontSize: (fontSize: UserSettings['fontSize']) => void
  setFontFamily: (fontFamily: UserSettings['fontFamily']) => void
  setLineHeight: (lineHeight: UserSettings['lineHeight']) => void
  setPdfViewer: (pdfViewer: UserSettings['pdfViewer']) => void
  setAIPanelLayout: (aiPanelLayout: UserSettings['aiPanelLayout']) => void
  setSettingsPanelMode: (
    settingsPanelMode: UserSettings['settingsPanelMode']
  ) => void
  setSearchPanelPosition: (
    searchPanelPosition: UserSettings['searchPanelPosition']
  ) => void
  setAutoDetectCompiler: (
    autoDetectCompiler: UserSettings['autoDetectCompiler']
  ) => void
  // FIXED: 2026-11-06 导航栏标题开关
  setNavbarShowTitle: (navbarShowTitle: UserSettings['navbarShowTitle']) => void
  // FIXED: 2026-11-08 AI 助手默认 LLM 模型（空串 = 跟随系统默认）
  setAIModel: (aiModel: UserSettings['aiModel']) => void
}

type ProjectSettingsContextValue = Partial<ProjectSettings> &
  Partial<UserSettings> &
  ProjectSettingsSetterContextValue

export const ProjectSettingsContext = createContext<
  ProjectSettingsContextValue | undefined
>(undefined)

export const ProjectSettingsProvider: FC = ({ children }) => {
  const {
    compiler,
    setCompiler,
    imageName,
    setImageName,
    rootDocId,
    setRootDocId,
    spellCheckLanguage,
    setSpellCheckLanguage,
  } = useProjectWideSettings()

  const {
    autoComplete,
    setAutoComplete,
    autoPairDelimiters,
    setAutoPairDelimiters,
    syntaxValidation,
    setSyntaxValidation,
    editorTheme,
    setEditorTheme,
    overallTheme,
    setOverallTheme,
    mode,
    setMode,
    fontSize,
    setFontSize,
    fontFamily,
    setFontFamily,
    lineHeight,
    setLineHeight,
    pdfViewer,
    setPdfViewer,
    aiPanelLayout,
    setAIPanelLayout,
    settingsPanelMode,
    setSettingsPanelMode,
    searchPanelPosition,
    setSearchPanelPosition,
    autoDetectCompiler,
    setAutoDetectCompiler,
    navbarShowTitle,
    setNavbarShowTitle,
    aiModel,
    setAIModel,
  } = useUserWideSettings()

  useProjectWideSettingsSocketListener()

  const value: ProjectSettingsContextValue = useMemo(
    () => ({
      compiler,
      setCompiler,
      imageName,
      setImageName,
      rootDocId,
      setRootDocId,
      spellCheckLanguage,
      setSpellCheckLanguage,
      autoComplete,
      setAutoComplete,
      autoPairDelimiters,
      setAutoPairDelimiters,
      syntaxValidation,
      setSyntaxValidation,
      editorTheme,
      setEditorTheme,
      overallTheme,
      setOverallTheme,
      mode,
      setMode,
      fontSize,
      setFontSize,
      fontFamily,
      setFontFamily,
      lineHeight,
      setLineHeight,
      pdfViewer,
      setPdfViewer,
      aiPanelLayout,
      setAIPanelLayout,
      settingsPanelMode,
      setSettingsPanelMode,
      searchPanelPosition,
      setSearchPanelPosition,
      autoDetectCompiler,
      setAutoDetectCompiler,
      navbarShowTitle,
      setNavbarShowTitle,
      aiModel,
      setAIModel,
    }),
    [
      compiler,
      setCompiler,
      imageName,
      setImageName,
      rootDocId,
      setRootDocId,
      spellCheckLanguage,
      setSpellCheckLanguage,
      autoComplete,
      setAutoComplete,
      autoPairDelimiters,
      setAutoPairDelimiters,
      syntaxValidation,
      setSyntaxValidation,
      editorTheme,
      setEditorTheme,
      overallTheme,
      setOverallTheme,
      mode,
      setMode,
      fontSize,
      setFontSize,
      fontFamily,
      setFontFamily,
      lineHeight,
      setLineHeight,
      pdfViewer,
      setPdfViewer,
      aiPanelLayout,
      setAIPanelLayout,
      settingsPanelMode,
      setSettingsPanelMode,
      searchPanelPosition,
      setSearchPanelPosition,
      autoDetectCompiler,
      setAutoDetectCompiler,
      navbarShowTitle,
      setNavbarShowTitle,
      aiModel,
      setAIModel,
    ]
  )

  return (
    <ProjectSettingsContext.Provider value={value}>
      {children}
    </ProjectSettingsContext.Provider>
  )
}

export function useProjectSettingsContext() {
  const context = useContext(ProjectSettingsContext)

  if (!context) {
    throw new Error(
      'useProjectSettingsContext is only available inside ProjectSettingsProvider'
    )
  }

  return context
}
