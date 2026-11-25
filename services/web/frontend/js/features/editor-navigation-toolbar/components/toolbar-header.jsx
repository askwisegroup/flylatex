import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import { Dropdown, MenuItem, Modal, Button, Alert } from 'react-bootstrap'
import MenuButton from './menu-button'
import CobrandingLogo from './cobranding-logo'
import BackToProjectsButton from './back-to-projects-button'
import UpgradePrompt from './upgrade-prompt'
import LayoutDropdownButton from './layout-dropdown-button'
import OnlineUsersWidget from './online-users-widget'
import ProjectNameEditableLabel from './project-name-editable-label'
// FIXED: 2026-11 编辑器顶部显示项目标签，改名/改标签统一走「项目信息」弹窗
import ProjectTagsPills from './project-tags-pills'
import ProjectInfoModal from './project-info-modal'
import { useProjectTags } from '../hooks/use-project-tags'
import TrackChangesToggleButton from './track-changes-toggle-button'
import HistoryToggleButton from './history-toggle-button'
import ShareProjectButton from './share-project-button'
import GitSyncButton from './git-sync-button'
import {
  getPullResultMessage,
  getPushResultMessage,
} from './git-result-message'
import GitInfoModal from './git-info-modal'
import Icon from '../../../shared/components/icon'
// FIXED: 2026-11-07 导航栏左侧第一个位置加产品 LOGO（点击回 /project）
import MenuBarLogo from '../../ide-menu-bar/components/menu-bar-logo'
// FIXED: 2026-11-10 关于弹窗正文顶部加渐变 FlyLaTeX 标记（替代原标题里的 favicon）
import AboutBrandMark from '../../ide-menu-bar/components/about-brand-mark'
import MaterialIcon from '@/shared/components/material-icon'
import AccessibleModal from '../../../shared/components/accessible-modal'
// FIXED: 2026-10-29 翻译目标语言（与 ai-menu.tsx 共用同一份常量与记忆）
import {
  TARGET_LANGS,
  TARGET_LANG_LABEL_KEY,
  storeTargetLang,
} from '../../../shared/utils/translate-lang'
import WordCountModal from '../../word-count-modal/components/word-count-modal'
// FIXED: 2026-11-13 三个面板（工具菜单的快捷命令 / 符号表、编辑菜单的全项目搜索）
// 共用 palette-manager 的互斥 toggle：已开则关、开一个自动关另一个。
// 注意：不要加到 ide-menu-bar/components/tools-menu.tsx —— 那个目录是死代码，
// 只有 menu-bar-logo / about-brand-mark 被本文件单独 import 使用。
import { togglePalette, usePaletteOpen } from '../../palette-manager'
// FIXED: 2026-11-16 工具菜单里的「显示/隐藏文件页签」用它的开关
import {
  isTabsEnabled,
  setTabsEnabled,
  subscribeTabs,
} from '@/features/editor-tabs/editor-tabs-store'
import HotkeysModal from '../../hotkeys-modal/components/hotkeys-modal'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import getMeta from '../../../utils/meta'
import * as eventTracking from '../../../infrastructure/event-tracking'
import importOverleafModules from '../../../../macros/import-overleaf-module.macro'
import { openContactUs } from '../../../shared/utils/contact-us'
// FIXED: 2026-11-24 版权行收口到配置（Settings.copyrightHolder），不再写死公司名
import { copyrightLine } from '../../../shared/utils/copyright'
// FIXED: 2026-11-05 关于弹窗里的 TeX Live 版本改为探测真实值，不再写死
import {
  fetchTeXLiveVersion,
  texLiveVersionLabel,
  texLiveVersionTitle,
} from '../../../shared/utils/texlive-version'

const [publishModalModules] = importOverleafModules('publishModal')
// FIXED: 2026-11-13 菜单右侧的键位提示。
// 只写**真实存在**的快捷键（都核实过实现的来源），不凭空标注：
//   编译           Ctrl/Cmd+Enter、Ctrl/Cmd+S  → pdf-preview/hooks/use-compile-triggers.js
//   编辑器内搜索    Ctrl/Cmd+F                  → ide-menu-edit 的 搜索 项
//   快捷命令        Ctrl/Cmd+K                  → command-palette.tsx
//   符号表          Ctrl/Cmd+Shift+K            → symbol-palette.tsx
//   全项目搜索      Ctrl/Cmd+Shift+F            → project-search.tsx
//   设置           Ctrl/Cmd+,                  → 本文件下方的全局 keydown（与「文件 → 设置」同一入口）
//   审阅面板        Ctrl/Cmd+J                  → 本文件下方全局 keydown（编辑器内是 CM 的 Mod-j）
//   聊天            Ctrl/Cmd+Shift+X            → 本文件下方全局 keydown
//   共享            Ctrl/Cmd+Shift+S            → 本文件下方全局 keydown
//   AI 对话         Ctrl/Cmd+Alt+A              → 本文件下方全局 keydown
//   搜索参考文献    Ctrl/Cmd+Alt+R              → 本文件下方全局 keydown
// Mac 用 ⌘/⇧/⌥（不带加号），其他平台用 Ctrl/Shift/Alt（带加号），和系统惯例一致。
// FIXED: 2026-11-15 补 Ctrl/Cmd+, 打开设置。上游 Overleaf 没有这个键位
//   （hotkeys-modal.jsx 的清单里没有 settings），是我们新增的，因此三处同步：
//   全局监听、文件菜单提示、快捷键弹窗清单。
const IS_MAC_PLATFORM =
  typeof navigator !== 'undefined' &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

const SHORTCUTS = {
  save: IS_MAC_PLATFORM ? '\u2318S' : 'Ctrl+S',
  find: IS_MAC_PLATFORM ? '\u2318F' : 'Ctrl+F',
  copy: IS_MAC_PLATFORM ? '\u2318C' : 'Ctrl+C',
  paste: IS_MAC_PLATFORM ? '\u2318V' : 'Ctrl+V',
  commandPalette: IS_MAC_PLATFORM ? '\u2318K' : 'Ctrl+K',
  symbolPalette: IS_MAC_PLATFORM ? '\u2318\u21e7K' : 'Ctrl+Shift+K',
  projectSearch: IS_MAC_PLATFORM ? '\u2318\u21e7F' : 'Ctrl+Shift+F',
  trackChanges: IS_MAC_PLATFORM ? '\u2318\u21e7A' : 'Ctrl+Shift+A',
  settings: IS_MAC_PLATFORM ? '\u2318,' : 'Ctrl+,',
  // FIXED: 2026-11-19 三组面板键位重新梳理（菜单提示、全局 keydown、快捷键弹窗三处同步）：
  //   审阅面板   Ctrl/Cmd+J        —— Overleaf 原生默认，编辑器内 Mod-j 也是它
  //   聊天面板   Ctrl/Cmd+Shift+X  —— 新增；2026-02 移除工具栏聊天按钮后一直没有稳定入口
  //   共享       Ctrl/Cmd+Shift+S  —— 新增；Overleaf 原生只有按钮，没有键位
  //   AI 对话    Ctrl/Cmd+Alt+A    —— 原来的 Ctrl/Cmd+J 与审阅面板冲突，这里移开
  //
  // 为什么不用 J 系：Ctrl/Cmd+Shift+J（DevTools Console）和 Cmd+Option+J
  // 都是浏览器保留键，页面收不到事件；Shift+X / Alt+A 在 Chrome/Edge/Firefox
  // 上都没有占用，可以真正按出来。
  // 另外，所有字母键位都按 event.code 判断（macOS 上 Option+字母的 event.key
  // 是特殊字符，按 key 判断会匹配不上）。
  aiChat: IS_MAC_PLATFORM ? '\u2325\u2318A' : 'Ctrl+Alt+A',
  chatPanel: IS_MAC_PLATFORM ? '\u2318\u21e7X' : 'Ctrl+Shift+X',
  reviewPanel: IS_MAC_PLATFORM ? '\u2318J' : 'Ctrl+J',
  share: IS_MAC_PLATFORM ? '\u2318\u21e7S' : 'Ctrl+Shift+S',
  // FIXED: 2026-11-19 搜索参考文献（CrosRefSearch 弹窗）。
  // 原来是 Ctrl/Cmd+Shift+L，但编辑器里 Mod-Shift-l 已经绑定「跳到行」
  // （source-editor/extensions/go-to-line.ts），两者会同时触发：按一次既跳出
  // 跳行面板、又弹参考文献。这里改到 Alt+R（R = references），避开冲突。
  referencesSearch: IS_MAC_PLATFORM ? '\u2325\u2318R' : 'Ctrl+Alt+R',
}

const PublishButton = publishModalModules?.import.default

const FETCH_AI_BASE = '/ft-ai'

const SHOW_IDE_MENU_BAR = getMeta('ol-showIdeMenuBar') !== false

// FIXED: 2026-11-06 导航栏标题（设置 → 通用 → 导航栏显示标题）的两个尺寸阈值：
// TITLE_GAP：标题与菜单 / 右侧按钮之间至少留的空隙（单边），
//            免得省略号贴着菜单边缘；
// TITLE_MIN_WIDTH：标题最小可用宽度（含左右各 16px 内边距）。窄到这个程度时
//            只剩一两个字 + 省略号，反而像块污渍，干脆不显示，
//            也给菜单腾地方（窗口很窄 / 侧边栏拉得很宽 / 菜单变多时都会碰到）。
const NAVBAR_TITLE_GAP = 8
const NAVBAR_TITLE_MIN_WIDTH = 140

function IdeMenuBar({
  onShowLeftMenuClick,
  openShareModal,
  historyIsOpen,
  toggleHistoryOpen,
  isRestrictedTokenMember,
  chatIsOpen,
  toggleChatOpen,
  unreadMessageCount,
  hasPublishPermissions,
  cobranding,
  shouldDisplayPublishButton,
  projectName,
  renameProject,
  hasRenamePermissions,
  onOpenProjectInfo,
  // FIXED: 2026-11-13 审阅面板（批注）入口
  shouldDisplayReviewButton,
  reviewPanelOpen,
  toggleReviewPanelOpen,
}) {
  const { t } = useTranslation()
  // FIXED: 2026-11-13 三个面板的开关状态（菜单项高亮用）。
  // ⚠️ 必须放在 IdeMenuBar 里，不能放 ToolbarHeader —— 渲染「工具」下拉的是
  // IdeMenuBar，放错作用域就是运行时 ReferenceError: commandPaletteOpen is not defined。
  // FIXED: 2026-11-16 多文件页签的开关放进「工具」菜单：
  // 页签栏右端的「收起」之后，用户不知道该去哪打开，这里是固定入口。
  const [tabsEnabled, setTabsEnabledState] = useState(true)
  useEffect(() => {
    setTabsEnabledState(isTabsEnabled())
    return subscribeTabs(() => setTabsEnabledState(isTabsEnabled()))
  }, [])
  const commandPaletteOpen = usePaletteOpen('command')
  const symbolPaletteOpen = usePaletteOpen('symbol')
  const projectSearchOpen = usePaletteOpen('search')
  // FIXED: 2026-11-13 修订模式：状态由 Angular 审阅面板维护（editor.wantTrackChanges），
  // 这里只读，不做第二份本地 state，避免两边不一致。
  const [trackChangesForMe] = useScopeValue('editor.wantTrackChanges')
  const { pdfUrl, pdfDownloadUrl, startCompile } = useCompileContext()
  // FIXED: 2026-11-01 设置的显示方式（scope 上的 settings 对象，保存后即时同步）
  const [userSettings] = useScopeValue('settings', true)
  const settingsPanelMode = userSettings?.settingsPanelMode ?? 'modal'
  // FIXED: 2026-11-06 导航栏是否显示项目/文章标题（设置 → 通用，默认不显示）。
  // 同 settingsPanelMode：读 scope 上的 settings，改完即时生效，不用刷新
  const showNavbarTitle = userSettings?.navbarShowTitle === true
  const navTitle = showNavbarTitle && projectName ? projectName : ''
  // FIXED: 2026-11-06 标题的光学居中（详见下方 useLayoutEffect）。
  // 菜单区比右侧按钮区宽，单纯在「剩余空白」里居中会整体偏右，
  // 所以用绝对定位钉在导航栏真正的中线上，宽度由两侧实际空位算出来。
  const barRef = useRef(null)
  const menuGroupRef = useRef(null)
  const rightGroupRef = useRef(null)
  const [titleMaxWidth, setTitleMaxWidth] = useState(null)
  // FIXED: 2026-11-18 导航栏标题支持点击直接改名（原来只能走「文件 → 重命名项目」
  // 或「项目信息」弹窗，标题就在眼前却不能改）。交互：点一下变输入框，
  // Enter / 失焦保存，Esc 取消；名字没变或为空不发请求（空名字服务端会 400）。
  // 复用现有的 renameProject（EditorContext 里已含乐观更新 + 失败回滚），
  // 不另写一份改接口。
  const titleRef = useRef(null)
  const titleInputRef = useRef(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleEditWidth, setTitleEditWidth] = useState(null)
  // 一轮改名只提交一次：Enter 提交后输入框卸载，浏览器仍可能再补一个 blur，
  // 那时 projectName 还没回来，不拦就会发两次改名请求。
  const titleRenameDoneRef = useRef(false)
  // 和「文件 → 重命名项目」同一道权限门
  const canRenameFromTitle = Boolean(hasRenamePermissions && navTitle)
  const projectId = getMeta('ol-project_id')
  // FIXED: 2026-11-10 关于弹窗标题不再渲染 favicon 图片，baseAssetPath 只服务于那处 <img>，
  // 去掉后是未使用变量（no-unused-vars 会拦）。如需恢复旧标题，把这行加回来即可。
  // OLD: const baseAssetPath = getMeta('ol-baseAssetPath', '/')
  const [showAIModal, setShowAIModal] = useState(false)
  const [showWordCountModal, setShowWordCountModal] = useState(false)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [showAboutModal, setShowAboutModal] = useState(false)
  // FIXED: 2026-11-05 `tlmgr --version` 的结果（null = 还没取到/探测失败）
  const [texLiveVersion, setTeXLiveVersion] = useState(null)
  const [showHotkeysModal, setShowHotkeysModal] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [content, setContent] = useState('')
  const [copyableContent, setCopyableContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [showAlert, setShowAlert] = useState(false)
  // FIXED: 2026-10-29 记录本次请求的模式/原文/目标语言，供弹窗内切换语言重新翻译
  const [lastMode, setLastMode] = useState('')
  const [sourceText, setSourceText] = useState('')
  // FIXED: 2026-11-09 默认不预选目标语言：打开翻译先停住，等用户选了再发请求。
  // OLD: const [targetLang, setTargetLang] = useState(readStoredTargetLang)
  const [targetLang, setTargetLang] = useState('')
  // FIXED: 2026-10-29 AI 面板开合状态，由面板自己广播 editor:ai-chat-state。
  // 注意：上面的 chatIsOpen 是从 Angular 传进来的旧聊天面板状态，别混用。
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)
  const [gitStatus, setGitStatus] = useState(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [gitToken, setGitToken] = useState('')
  // FIXED: 2026-11 菜单栏 Git 下拉里的「信息」弹窗（仓库 / 分支 / 脱敏凭据 / 最近提交 / 同步状态）
  const [showGitInfo, setShowGitInfo] = useState(false)

  const isMac = /Mac/.test(window.navigator?.platform)

  // FIXED: 2026-11-06 标题居中修正：
  // 导航栏左右两侧宽度不等（菜单区 > 分享/布局），在 flow 布局里居中只会
  // 落在「空白区」的中心 → 视觉上靠右。这里把标题绝对定位到导航栏中线，
  // 再量出中线到两侧最近边界的距离，取较小的一边 ×2 作为最大宽度，
  // 这样标题在正中线上且一定不会压到菜单或右侧按钮。
  // 量不到足够宽度（窄屏 / 菜单变多）时 titleMaxWidth = 0，下面 JSX 直接
  // 不渲染标题，顶栏退回「只有菜单」的样子。
  // 代价很小：只读 3 个 getBoundingClientRect，且仅在这几个元素尺寸变化
  // （窗口缩放 / Git 菜单出现 / 文案变化）时由 ResizeObserver 触发重算。
  useLayoutEffect(() => {
    const bar = barRef.current
    const menuGroup = menuGroupRef.current
    const rightGroup = rightGroupRef.current
    if (!bar || !menuGroup || !rightGroup || !navTitle) {
      return
    }

    const measure = () => {
      const barRect = bar.getBoundingClientRect()
      const center = barRect.left + barRect.width / 2
      const freeLeft = center - menuGroup.getBoundingClientRect().right
      const freeRight = rightGroup.getBoundingClientRect().left - center
      // 以较窄的一侧为准，才能既在正中线上、又两边都不越界
      // 每边再让出 NAVBAR_TITLE_GAP，避免省略号贴着菜单边缘
      const available = Math.min(freeLeft, freeRight) * 2 - NAVBAR_TITLE_GAP * 2
      // 显示不下（< NAVBAR_TITLE_MIN_WIDTH）就不显示，腾出位置给菜单
      setTitleMaxWidth(
        available >= NAVBAR_TITLE_MIN_WIDTH ? Math.floor(available) : 0
      )
    }

    measure()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    observer.observe(menuGroup)
    observer.observe(rightGroup)
    return () => observer.disconnect()
  }, [navTitle])

  // FIXED: 2026-11-18 点击导航栏标题直接改名（见上方 titleRef 处的说明）
  const startTitleRename = useCallback(() => {
    if (!canRenameFromTitle || renamingTitle) {
      return
    }
    // 输入框宽度跟着原标题量出来，太窄给个下限，再宽也不超出量好的 maxWidth，
    // 所以改名时不会突然压到菜单或右侧按钮。
    const titleBox = titleRef.current?.getBoundingClientRect()
    const measured = Math.round(titleBox?.width ?? 0)
    const ceiling = titleMaxWidth || 320
    setTitleEditWidth(Math.min(Math.max(measured + 48, 180), ceiling))
    setTitleDraft(projectName || '')
    titleRenameDoneRef.current = false
    setRenamingTitle(true)
  }, [canRenameFromTitle, renamingTitle, projectName, titleMaxWidth])

  // 保存：只有名字真的变了且非空才发请求
  const finishTitleRename = useCallback(() => {
    if (titleRenameDoneRef.current) {
      return
    }
    titleRenameDoneRef.current = true
    const next = titleDraft.trim()
    setRenamingTitle(false)
    if (next && next !== projectName) {
      renameProject(next)
    }
  }, [titleDraft, projectName, renameProject])

  const cancelTitleRename = useCallback(() => {
    // Esc 取消：标记已结束，免得随后的 blur 又把草稿存上去
    titleRenameDoneRef.current = true
    setRenamingTitle(false)
  }, [])

  // 进入编辑就把原名全选，直接打字即可覆盖
  useEffect(() => {
    if (renamingTitle) {
      titleInputRef.current?.select()
    }
  }, [renamingTitle])

  useEffect(() => {
    const handleShowHotkeys = () => {
      eventTracking.sendMB('left-menu-hotkeys')
      setShowHotkeysModal(true)
    }
    window.addEventListener('hotkeys:show', handleShowHotkeys)
    return () => {
      window.removeEventListener('hotkeys:show', handleShowHotkeys)
    }
  }, [])

  // Load Git status
  useEffect(() => {
    if (!projectId) return

    let isGitProject = true // 标记项目是否支持 git

    const loadGitStatus = async () => {
      try {
        const response = await fetch(`/project/${projectId}/git/status`, {
          credentials: 'include',
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()

        // 如果项目不支持 git（linked: false），停止后续请求
        if (data.linked === false) {
          console.debug(
            '[Git Status] Project is not a Git project, stopping polling'
          )
          isGitProject = false
          setGitStatus(null)
          return
        }

        setGitStatus(data)
      } catch (error) {
        // 如果请求出错，停止后续请求（避免大量错误日志）
        console.debug('[Git Status] Error loading Git status:', error.message)
        isGitProject = false
        setGitStatus(null)
      }
    }

    loadGitStatus()

    // 只有当项目支持 git 时，才启动定时刷新（每 5 秒）
    const interval = setInterval(() => {
      if (isGitProject) {
        loadGitStatus()
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [projectId])

  const handleBackToProjects = useCallback(() => {
    eventTracking.sendMB('navigation-clicked-home')
    window.location.href = '/project'
  }, [])

  const handleOpenSettings = useCallback(() => {
    eventTracking.sendMB('navigation-clicked-menu')
    // FIXED: 2026-11-01 设置的显示方式可切换：'left' 左侧面板（默认）| 'modal' 居中弹窗。
    // 值从 scope 上的 settings 读，改完立刻生效，不需要刷新。
    if (settingsPanelMode === 'modal') {
      document.dispatchEvent(
        new CustomEvent('fl:settings-modal', { detail: { open: true } })
      )
      return
    }
    if (onShowLeftMenuClick) {
      onShowLeftMenuClick()
    }
  }, [onShowLeftMenuClick, settingsPanelMode])

  // FIXED: 2026-11-15 Ctrl/Cmd+, 打开设置（项目页全局，不必先点菜单）。
  // 复用 handleOpenSettings，所以 settingsPanelMode = 'left' / 'modal' 两种显示方式
  // 都自动跟随，不另存状态。keydown 挂在 window 上，编辑器获得焦点时同样生效。
  useEffect(() => {
    function handleKeyDown(event) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return
      }
      if (event.key !== ',') {
        return
      }
      // 长按会重复触发，设置面板反复开关 + 重复打点，直接忽略
      if (event.repeat) {
        return
      }
      event.preventDefault()
      handleOpenSettings()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleOpenSettings])

  const handleDownloadSource = useCallback(() => {
    if (projectId) {
      eventTracking.sendMB('download-zip-button-click', {
        projectId,
        location: 'file-menu',
      })
      window.open(`/project/${projectId}/download/zip`, '_blank')
    }
  }, [projectId])

  const handleDownloadPDF = useCallback(() => {
    if (pdfUrl) {
      eventTracking.sendMB('download-pdf-button-click', {
        projectId,
        location: 'file-menu',
      })
      window.open(pdfDownloadUrl || pdfUrl, '_blank')
    }
  }, [pdfDownloadUrl, pdfUrl, projectId])

  const handleShowAbout = useCallback(() => {
    setShowAboutModal(true)
    fetchTeXLiveVersion().then(setTeXLiveVersion)
  }, [])

  const showGitNotification = useCallback((text, type = 'info') => {
    const notification = document.createElement('div')
    notification.style.position = 'fixed'
    notification.style.top = '50px'
    notification.style.left = '50%'
    notification.style.transform = 'translateX(-50%)'
    notification.style.backgroundColor =
      type === 'success' ? '#d4edda' : type === 'error' ? '#f8d7da' : '#d1ecf1'
    notification.style.color =
      type === 'success' ? '#155724' : type === 'error' ? '#721c24' : '#0c5460'
    notification.style.border =
      type === 'success'
        ? '1px solid #c3e6cb'
        : type === 'error'
        ? '1px solid #f5c6cb'
        : '1px solid #bee5eb'
    notification.style.borderRadius = '4px'
    notification.style.padding = '12px 16px'
    notification.style.zIndex = '10001'
    notification.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)'
    notification.style.maxWidth = '400px'
    notification.style.wordBreak = 'break-word'
    notification.textContent = text
    document.body.appendChild(notification)
    setTimeout(() => notification.remove(), 3000)
  }, [])

  const handleGitPull = useCallback(async () => {
    if (!gitStatus?.linked || !projectId) return
    setGitLoading(true)
    try {
      const response = await fetch(`/project/${projectId}/git/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getMeta('ol-csrfToken'),
        },
        credentials: 'include',
        body: JSON.stringify({ token: gitToken }),
      })
      const result = await response.json()
      if (result.success) {
        showGitNotification(t('git_pull_success_refreshing'), 'success')
        setTimeout(() => window.location.reload(), 1500)
      } else {
        // FIXED: 2026-11 拉取失败也按原因提示（本地有未提交改动 / 冲突 / 分叉 / 认证）
        const outcome = getPullResultMessage(result, t)
        showGitNotification(outcome.text, outcome.tone)
      }
    } catch (error) {
      showGitNotification(`${t('git_pull_failed')}: ${error.message}`, 'error')
    } finally {
      setGitLoading(false)
    }
  }, [gitStatus, projectId, gitToken, showGitNotification, t])

  const handleGitPush = useCallback(async () => {
    if (!gitStatus?.linked || !projectId) return
    setGitLoading(true)
    try {
      const response = await fetch(`/project/${projectId}/git/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getMeta('ol-csrfToken'),
        },
        credentials: 'include',
        body: JSON.stringify({ token: gitToken }),
      })
      const result = await response.json()

      // FIXED: 2026-11 这个菜单里的推送原来完全没有看 result.hasChanges，
      // 服务端返回 "No changes to commit" (success:true) 时照样弹「推送成功」，
      // 用户会以为自己推上去了，实际远端啥都没变。
      // 现在和顶栏 Git 菜单共用同一套判定：
      //   推送成功 / 没有需要推送的改动 / 没有远端写权限 / 认证失败 / 分支保护 …
      const outcome = getPushResultMessage(result, t)
      showGitNotification(outcome.text, outcome.tone)

      // FIXED: 2026-11 补上「令牌」这最后一环：
      // 公开仓库匿名就能拉取，用户通常是在要推送时才发现缺令牌，
      // 而这个下拉菜单里没有输入框。认证/权限类失败直接打开「信息」弹窗，
      // 里面可以填令牌、写提交信息、一键提交并推送。
      if (
        !result.success &&
        ['auth_failed', 'permission_denied', 'repo_not_found'].includes(
          result.reason
        )
      ) {
        setShowGitInfo(true)
      }

      // 推送后刷新状态（原来这里不刷新，界面上「可推送」的标记还留着）
      if (result.success) {
        try {
          const statusResponse = await fetch(
            `/project/${projectId}/git/status`,
            { credentials: 'include' }
          )
          if (statusResponse.ok) {
            setGitStatus(await statusResponse.json())
          }
        } catch (refreshError) {
          console.warn('Failed to refresh git status after push:', refreshError)
        }
      }
    } catch (error) {
      showGitNotification(`${t('git_push_failed')}: ${error.message}`, 'error')
    } finally {
      setGitLoading(false)
    }
  }, [gitStatus, projectId, gitToken, showGitNotification, t])

  const handleCopy = useCallback(async () => {
    try {
      const selection = window.getSelection()
      if (selection && selection.toString()) {
        await navigator.clipboard.writeText(selection.toString())
        setCopySuccess(true)
        setTimeout(() => setCopySuccess(false), 2000)
      }
    } catch (err) {
      console.error('Copy failed:', err)
    }
  }, [])

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      document.execCommand('insertText', false, text)
    } catch (err) {
      console.error('Paste failed:', err)
    }
  }, [])

  // FIXED: 2026-11-13 修订模式开关：把事件交给 Angular 审阅面板处理
  // （ReviewPanelController 里的 editor:event / toggle-track-changes 分支），
  // 它负责置位 editor.wantTrackChanges 并 POST /project/:id/track_changes。
  // React 侧只派发事件，不复制状态机。
  const handleToggleTrackChanges = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('editor:event', {
        detail: { type: 'toggle-track-changes' },
      })
    )
  }, [])

  // FIXED: 2026-10-29 拆成"发请求"与"取选中内容"两步，
  // 这样弹窗里换目标语言时可以用同一段原文重发，不必重新取选区。
  const runAIRequest = useCallback(
    async (mode, text, lang) => {
      setIsLoading(true)
      setShowAIModal(true)
      setLastMode(mode)
      setSourceText(text)

      const initialMessage =
        mode === 'translate'
          ? t('translating_please_wait')
          : t('processing_please_wait')
      setContent(initialMessage)

      try {
        const res = await fetch(FETCH_AI_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            mode === 'translate'
              ? { text, mode, targetLang: lang }
              : { text, mode }
          ),
        })

        if (!res.ok) {
          // FIXED: 2026-10-30 把服务端/网关的真实原因带出来，别一律"服务错误"
          let detail = `HTTP ${res.status}`
          try {
            const errorBody = await res.json()
            detail = errorBody?.msg || errorBody?.error || detail
          } catch (e) {
            // 响应不是 JSON（网关错误页之类），保留状态码
          }
          throw new Error(detail)
        }

        const data = await res.json()
        const _data = data.data

        // 如果需要重新编译，直接点击重新编译按钮
        if (data.needsRecompile === true) {
          console.log(
            '[Toolbar AI] AI modified LaTeX files, reloading document and triggering recompile toolbar'
          )

          // 1️⃣ 先重新加载编辑器中的文档内容
          try {
            const editorManager = window._ide?.editorManager
            if (
              editorManager &&
              typeof editorManager.reloadCurrentDocument === 'function'
            ) {
              editorManager.reloadCurrentDocument()
              console.log('[Toolbar AI] Document reloaded in editor')
            }
          } catch (e) {
            console.warn('[Toolbar AI] Error reloading document:', e)
          }

          // 2️⃣ 再点击重新编译按钮
          const compileButton = document.querySelector(
            'button[type="button"].split-menu-button.btn.btn-primary'
          )
          if (compileButton) {
            console.log('[Toolbar AI] Found compile button, clicking it')
            compileButton.click()
          } else {
            console.warn('[Toolbar AI] Compile button not found in DOM')
          }
        }

        if (_data) {
          if (mode === 'translate') {
            const copyText = `${t('original_content')}:\n${text.substring(
              0,
              500
            )}${text.length > 500 ? '...' : ''}\n\n${t(
              'translated_content'
            )}:\n${_data}`
            setCopyableContent(copyText)
            setContent(
              <>
                {t('original_content')}:<br /> {text.substring(0, 500)}
                {text.length > 500 ? '...' : ''}
                <hr />
                {t('translated_content')}:<br />
                {_data}
              </>
            )
          } else if (mode === 'summary') {
            setCopyableContent(_data)
            setContent(
              <>
                {t('summary')}:<br />
                <br />
                {_data}
              </>
            )
          } else if (mode === 'abstract') {
            setCopyableContent(_data)
            setContent(
              <>
                {t('abstract')}:<br />
                <br />
                {_data}
              </>
            )
          }
        } else {
          // FIXED: 2026-10-30 服务端会带 msg（如"AI 服务无响应，请重试"），显示出来
          setContent(
            data && data.msg
              ? `${t('service_error')}：${data.msg}`
              : t('service_error')
          )
          setCopyableContent('')
        }
      } catch (err) {
        console.error('[Toolbar AI] request failed:', err)
        setContent(
          err && err.message
            ? `${t('service_error')}：${err.message}`
            : t('service_error')
        )
        setCopyableContent('')
      } finally {
        setIsLoading(false)
      }
    },
    [t]
  )

  const handleAIRequest = useCallback(
    mode => {
      // 优先获取用户选择的内容
      const selection = window.getSelection()
      const selectedText =
        selection && selection.toString() ? selection.toString().trim() : ''

      // 翻译只针对选中的内容；没有选中就不要退化成"翻整篇"
      if (mode === 'translate' && !selectedText) {
        setLastMode('translate')
        setContent(t('please_select_text_to_translate'))
        setShowAIModal(true)
        return
      }

      // 没有选中内容时，summary/abstract 取全文
      let text = selectedText
      if (!text) {
        const editorContent = document.querySelector('.cm-content')
        if (editorContent) {
          text = editorContent.textContent || ''
        }
      }

      if (!text) {
        setLastMode(mode)
        setContent(t('document_is_empty'))
        setShowAIModal(true)
        return
      }

      // FIXED: 2026-11-09 翻译：每次都先停在弹窗里等用户选目标语言，不发请求。
      // （原来会拿默认/上次记忆的语言先翻一遍，用户想换语言还得等它跑完。）
      if (mode === 'translate') {
        setTargetLang('')
        setLastMode('translate')
        setSourceText(text)
        setCopyableContent('')
        setContent(t('please_select_target_language_to_start'))
        setShowAIModal(true)
        return
      }

      runAIRequest(mode, text, targetLang)
    },
    [runAIRequest, targetLang, t]
  )

  // 弹窗里切换目标语言：记住选择并立即用同一段原文重译
  const handleTargetLangChange = useCallback(
    lang => {
      setTargetLang(lang)
      if (!lang) {
        // 选了占位的「请选择目标语言」：不发请求
        return
      }
      storeTargetLang(lang)
      if (!isLoading && sourceText) {
        runAIRequest('translate', sourceText, lang)
      }
    },
    [isLoading, runAIRequest, sourceText]
  )

  // AI 面板开合状态由面板自己广播，菜单据此显示"打开对话/关闭对话"
  useEffect(() => {
    const handleState = e => {
      const detail = e && e.detail
      setAiChatOpen(Boolean(detail && detail.open))
    }
    window.addEventListener('editor:ai-chat-state', handleState)
    return () => window.removeEventListener('editor:ai-chat-state', handleState)
  }, [])

  const handleCopyContent = useCallback(async () => {
    if (copyableContent) {
      try {
        await navigator.clipboard.writeText(copyableContent)
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 2000)
      } catch (err) {
        console.error('Copy failed:', err)
      }
    }
  }, [copyableContent])

  const closeAIModal = useCallback(() => {
    if (!isLoading) {
      setShowAIModal(false)
      setCopyableContent('')
    }
  }, [isLoading])

  const handleOpenDocs = useCallback(() => {
    window.open('/learn', '_blank')
  }, [])

  const handleOpenTemplates = useCallback(() => {
    window.open('https://www.example.com/templates', '_blank')
  }, [])

  const handleShowHotkeys = useCallback(() => {
    window.dispatchEvent(new CustomEvent('hotkeys:show'))
  }, [])

  // FIXED: 2026-11-01 地址不再写死，改由服务端配置 CONTACT_US_URL
  // （可以是 http(s)，也可以是 mailto:），没配就回落到论坛地址
  const handleContactUs = useCallback(() => {
    openContactUs()
  }, [])

  const handleWordCount = useCallback(() => {
    eventTracking.sendMB('left-menu-count')
    setShowWordCountModal(true)
  }, [])

  const handleSearchReferences = useCallback(() => {
    window.dispatchEvent(new CustomEvent('references:search'))
  }, [])

  // FIXED: 2026-11-19 Ctrl/Cmd+Alt+R 打开「搜索参考文献」。
  // 与工具菜单那一项、以及「插入引用」浮条里的「插入引用」走同一个事件。
  // 原键位 Ctrl/Cmd+Shift+L 与编辑器的「跳到行」(Mod-Shift-l) 冲突，已挪开。
  useEffect(() => {
    function handleKeyDown(event) {
      if (!(event.metaKey || event.ctrlKey) || event.repeat) {
        return
      }
      if (event.defaultPrevented) {
        return
      }
      // 用 event.code：macOS 上 Option+R 的 event.key 是 '®'
      if (event.altKey && !event.shiftKey && event.code === 'KeyR') {
        event.preventDefault()
        handleSearchReferences()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSearchReferences])

  const handleSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent('editor:toggle-search'))
  }, [])

  const handleInsertMath = useCallback(() => {
    window.dispatchEvent(new CustomEvent('editor:insert-math'))
  }, [])

  const handleOpenWhiteboard = useCallback(() => {
    window.open('https://www.example.com/whiteboard/', '_blank')
  }, [])

  const handleOpenAIChat = useCallback(() => {
    window.dispatchEvent(new CustomEvent('editor:toggle-ai-chat'))
  }, [])

  // FIXED: 2026-11-19 全局键位：审阅 / 聊天面板 / 共享 / AI 对话。
  // 挂在 window 上，焦点不在编辑器里（PDF 预览、文件树）时也能用。
  // 菜单提示（SHORTCUTS）、这里、以及「显示快捷键」弹窗三处必须同步。
  //
  // 为什么要看 event.defaultPrevented：
  //   编辑器内 Ctrl/Cmd+J 已经由 CodeMirror 绑定到「审阅面板」
  //   （source-editor/extensions/shortcuts.ts 的 Mod-j），它处理完会 preventDefault；
  //   这里再 toggle 一次就会变成「开了又关」。
  // 为什么用 event.code 而不是 event.key：
  //   macOS 上 Option+字母的 event.key 是特殊字符（Option+J 是 '∆'），
  //   按 key 判断永远匹配不上。
  useEffect(() => {
    function handleKeyDown(event) {
      if (!(event.metaKey || event.ctrlKey) || event.repeat) {
        return
      }
      if (event.defaultPrevented) {
        return
      }

      // Ctrl/Cmd+Alt+A：AI 对话（A = AI；原 Ctrl/Cmd+J 让给审阅面板）
      if (event.altKey && !event.shiftKey && event.code === 'KeyA') {
        event.preventDefault()
        handleOpenAIChat()
        return
      }

      // Ctrl/Cmd+Shift+X：聊天面板（协作聊天）
      if (event.shiftKey && !event.altKey && event.code === 'KeyX') {
        event.preventDefault()
        toggleChatOpen()
        return
      }

      // Ctrl/Cmd+Shift+S：共享（打开共享弹窗）
      if (event.shiftKey && !event.altKey && event.code === 'KeyS') {
        event.preventDefault()
        openShareModal()
        return
      }

      // Ctrl/Cmd+J：审阅面板（Overleaf 原生默认键位）
      if (!event.shiftKey && !event.altKey && event.code === 'KeyJ') {
        if (!shouldDisplayReviewButton) {
          return
        }
        event.preventDefault()
        toggleReviewPanelOpen(event)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    handleOpenAIChat,
    toggleChatOpen,
    toggleReviewPanelOpen,
    openShareModal,
    shouldDisplayReviewButton,
  ])

  const handleRenameProject = useCallback(() => {
    setNewProjectName(projectName)
    setShowRenameModal(true)
  }, [projectName])

  const handleRenameSubmit = useCallback(
    e => {
      e.preventDefault()
      if (newProjectName.trim() && newProjectName !== projectName) {
        renameProject(newProjectName.trim())
        setShowRenameModal(false)
      }
    },
    [newProjectName, projectName, renameProject]
  )

  return (
    <>
      <div className="ide-menu-bar" ref={barRef}>
        <div className="ide-menu-bar-left" ref={menuGroupRef}>
          {/* FIXED: 2026-11-07 第一个位置放产品 LOGO，点击返回 /project */}
          <MenuBarLogo />

          <Dropdown id="ide-menu-file" className="ide-menu-dropdown">
            <Dropdown.Toggle noCaret className="ide-menu-toggle">
              <Icon type="file" fw />
              {t('file')}
            </Dropdown.Toggle>
            <Dropdown.Menu className="ide-menu-dropdown-menu">
              <MenuItem onClick={handleBackToProjects}>
                <Icon type="home" fw /> {t('back_to_your_projects')}
              </MenuItem>
              {hasRenamePermissions && (
                <MenuItem onClick={handleRenameProject}>
                  <Icon type="pencil" fw /> {t('rename_project')}
                </MenuItem>
              )}
              {/* FIXED: 2026-11 项目名称 + 标签的就近编辑入口（改名/改标签不用退回项目列表） */}
              <MenuItem onClick={onOpenProjectInfo}>
                <Icon type="tags" fw /> {t('project_info')}
              </MenuItem>
              <MenuItem onClick={handleOpenSettings}>
                <Icon type="cog" fw /> {t('settings')}
                <span className="ide-menu-shortcut">{SHORTCUTS.settings}</span>
              </MenuItem>
              {!isRestrictedTokenMember && (
                <MenuItem onClick={toggleHistoryOpen}>
                  <Icon type="history" fw /> {t('history')}
                </MenuItem>
              )}
              <MenuItem divider />
              <MenuItem onClick={handleDownloadSource}>
                <Icon type="file-archive-o" fw /> {t('download_source')}
              </MenuItem>
              <MenuItem onClick={handleDownloadPDF}>
                <Icon type="file-pdf-o" fw /> {t('download_pdf')}
              </MenuItem>
            </Dropdown.Menu>
          </Dropdown>

          <Dropdown id="ide-menu-edit" className="ide-menu-dropdown">
            <Dropdown.Toggle noCaret className="ide-menu-toggle">
              <Icon type="pencil" fw />
              {t('edit')}
            </Dropdown.Toggle>
            <Dropdown.Menu className="ide-menu-dropdown-menu">
              <MenuItem onClick={handleSearch}>
                <Icon type="search" fw /> {t('toolbar_search')}
                <span className="ide-menu-shortcut">{SHORTCUTS.find}</span>
              </MenuItem>
              <MenuItem onClick={handleCopy}>
                <Icon type="copy" fw /> {copySuccess ? t('copied') : t('copy')}
                <span className="ide-menu-shortcut">{SHORTCUTS.copy}</span>
              </MenuItem>
              <MenuItem onClick={handlePaste}>
                <Icon type="paste" fw /> {t('paste')}
                <span className="ide-menu-shortcut">{SHORTCUTS.paste}</span>
              </MenuItem>
              <MenuItem divider />
              {/* FIXED: 2026-11-20 全项目搜索从「工具」菜单挪到「编辑」，放在修订模式上方。 */}
              <MenuItem
                onClick={() => togglePalette('search')}
                className={projectSearchOpen ? 'active' : undefined}
              >
                {/* 用 search-plus 与上方「搜索」（编辑器内 Ctrl+F）区分开 */}
                <Icon type="search-plus" fw /> {t('menu_project_search')}
                <span className="ide-menu-shortcut">
                  {SHORTCUTS.projectSearch}
                </span>
              </MenuItem>
              {/* FIXED: 2026-11-13 修订模式入口。
                  派发 editor:event/toggle-track-changes，由 Angular 的
                  ReviewPanelController 统一处理（置位 + POST /track_changes），
                  不在 React 里另存一份状态。
                  键位 Ctrl/Cmd+Shift+A 来自 source-editor/extensions/shortcuts.ts。 */}
              <MenuItem
                onClick={handleToggleTrackChanges}
                className={trackChangesForMe ? 'active' : undefined}
              >
                <Icon
                  type={trackChangesForMe ? 'check-square-o' : 'square-o'}
                  fw
                />{' '}
                {t('menu_track_changes')}
                <span className="ide-menu-shortcut">
                  {SHORTCUTS.trackChanges}
                </span>
              </MenuItem>
            </Dropdown.Menu>
          </Dropdown>

          <Dropdown id="ide-menu-ai" className="ide-menu-dropdown">
            <Dropdown.Toggle noCaret className="ide-menu-toggle">
              <Icon type="lightbulb-o" fw />
              AI
            </Dropdown.Toggle>
            <Dropdown.Menu className="ide-menu-dropdown-menu">
              <MenuItem onClick={handleOpenAIChat}>
                <Icon type="comments" fw />{' '}
                {aiChatOpen ? t('close_chat') : t('ai_open_chat')}
                <span className="ide-menu-shortcut">{SHORTCUTS.aiChat}</span>
              </MenuItem>
              <MenuItem divider />
              <MenuItem onClick={() => handleAIRequest('translate')}>
                <MaterialIcon type="123" /> {t('toolbar_translate_content')}
              </MenuItem>
              <MenuItem onClick={() => handleAIRequest('summary')}>
                <MaterialIcon type="cycle" /> {t('toolbar_document_summary')}
              </MenuItem>
              <MenuItem onClick={() => handleAIRequest('abstract')}>
                <MaterialIcon type="rebase" /> {t('toolbar_generate_abstract')}
              </MenuItem>
            </Dropdown.Menu>
          </Dropdown>

          <Dropdown id="ide-menu-tools" className="ide-menu-dropdown">
            <Dropdown.Toggle noCaret className="ide-menu-toggle">
              <Icon type="wrench" fw />
              {t('tools')}
            </Dropdown.Toggle>
            <Dropdown.Menu className="ide-menu-dropdown-menu">
              <MenuItem onClick={handleInsertMath}>
                <Icon type="subscript" fw /> {t('toolbar_insert_math')}
              </MenuItem>
              <MenuItem onClick={handleWordCount}>
                <Icon type="calculator" fw /> {t('word_count')}
              </MenuItem>
              <MenuItem divider />
              {/* FIXED: 2026-11-13 编辑期辅助面板，互斥打开；已打开的项高亮
                  （全项目搜索 2026-11-20 挤到「编辑」菜单） */}
              <MenuItem
                onClick={() => togglePalette('command')}
                className={commandPaletteOpen ? 'active' : undefined}
              >
                <Icon type="terminal" fw /> {t('menu_command_palette')}
                <span className="ide-menu-shortcut">
                  {SHORTCUTS.commandPalette}
                </span>
              </MenuItem>
              <MenuItem
                onClick={() => togglePalette('symbol')}
                className={symbolPaletteOpen ? 'active' : undefined}
              >
                <Icon type="superscript" fw /> {t('menu_symbol_palette')}
                <span className="ide-menu-shortcut">
                  {SHORTCUTS.symbolPalette}
                </span>
              </MenuItem>
              {/* FIXED: 2026-11-16 显示/隐藏文件页签（与页签栏右端「收起」同一个开关） */}
              <MenuItem
                onClick={() => {
                  const next = !isTabsEnabled()
                  setTabsEnabled(next)
                  setTabsEnabledState(next)
                }}
                className={tabsEnabled ? 'active' : undefined}
              >
                {/* 图标用 files-o（文件堆叠），语义对应「页签」；
                    window-maximize 会被读成「最大化窗口」，不合适 */}
                <Icon type="files-o" fw />{' '}
                {tabsEnabled ? '隐藏文件页签' : '显示文件页签'}
              </MenuItem>
              <MenuItem onClick={handleSearchReferences}>
                <Icon type="bookmark" fw /> {t('crossref_toolbar_button')}
                <span className="ide-menu-shortcut">
                  {SHORTCUTS.referencesSearch}
                </span>
              </MenuItem>
              <MenuItem divider />
              {/* FIXED: 2026-11-19 「协作」三件套补齐菜单入口。
                  之前聊天按钮已在 2026-02 移除（只剩语义不明的「合作」），
                  审阅 / 共享也只在顶栏有图标按钮 —— 只有 toolbar、没有 menu，
                  不符合桌面软件的一般规范。这里三项与顶栏按钮共用同一份状态：
                  聊天 ui.chatOpen、审阅 ui.reviewPanelOpen、共享打开同一个弹窗。 */}
              {!isRestrictedTokenMember && (
                <MenuItem
                  onClick={toggleChatOpen}
                  className={chatIsOpen ? 'active' : undefined}
                >
                  <Icon type="comment" fw /> {t('chat')}
                  <span className="ide-menu-shortcut">
                    {SHORTCUTS.chatPanel}
                  </span>
                </MenuItem>
              )}
              {shouldDisplayReviewButton && (
                <MenuItem
                  onClick={toggleReviewPanelOpen}
                  className={reviewPanelOpen ? 'active' : undefined}
                >
                  <Icon type="comments" fw /> {t('review')}
                  <span className="ide-menu-shortcut">
                    {SHORTCUTS.reviewPanel}
                  </span>
                </MenuItem>
              )}
              <MenuItem onClick={openShareModal}>
                <Icon type="group" fw /> {t('share')}
                <span className="ide-menu-shortcut">{SHORTCUTS.share}</span>
              </MenuItem>
              <MenuItem divider />
              <MenuItem onClick={handleOpenWhiteboard}>
                <Icon type="edit" fw /> {t('open_whiteboard')}
              </MenuItem>
            </Dropdown.Menu>
          </Dropdown>

          {gitStatus?.linked && (
            <Dropdown id="ide-menu-git" className="ide-menu-dropdown">
              <Dropdown.Toggle noCaret className="ide-menu-toggle">
                <Icon type="code-fork" fw />
                {t('git')}
              </Dropdown.Toggle>
              <Dropdown.Menu className="ide-menu-dropdown-menu">
                <MenuItem onClick={handleGitPull} disabled={gitLoading}>
                  <Icon type="arrow-down" fw />{' '}
                  {gitLoading ? t('git_processing') : t('git_pull')}
                </MenuItem>
                <MenuItem onClick={handleGitPush} disabled={gitLoading}>
                  <Icon type="arrow-up" fw />{' '}
                  {gitLoading ? t('git_processing') : t('git_push')}
                </MenuItem>
                <MenuItem divider />
                {/* FIXED: 2026-11 新增「信息」：只读用户也能看（不受写权限限制），
                    内容是仓库地址（脱敏）/分支/凭据/最近 10 条提交/是否可推送 */}
                <MenuItem onClick={() => setShowGitInfo(true)}>
                  <Icon type="info-circle" fw /> {t('git_info', 'Info')}
                </MenuItem>
              </Dropdown.Menu>
            </Dropdown>
          )}

          <Dropdown id="ide-menu-help" className="ide-menu-dropdown">
            <Dropdown.Toggle noCaret className="ide-menu-toggle">
              <Icon type="question-circle" fw />
              {t('help')}
            </Dropdown.Toggle>
            <Dropdown.Menu className="ide-menu-dropdown-menu">
              <MenuItem onClick={handleShowHotkeys}>
                <Icon type="keyboard-o" fw /> {t('show_hotkeys')}
              </MenuItem>
              <MenuItem onClick={handleOpenDocs}>
                <Icon type="book" fw /> {t('documentation')}
              </MenuItem>
              <MenuItem onClick={handleOpenTemplates}>
                <Icon type="file-text" fw /> {t('paper_templates')}
              </MenuItem>
              <MenuItem onClick={handleContactUs}>
                <Icon type="envelope" fw /> {t('contact_us')}
              </MenuItem>
              <MenuItem divider />
              <MenuItem onClick={handleShowAbout}>
                <Icon type="info-circle" fw /> {t('about_system')}
              </MenuItem>
            </Dropdown.Menu>
          </Dropdown>
        </div>

        {/* FIXED: 2026-11-06 导航栏标题：绝对定位在导航栏中线上，
            max-width 由上面的 useLayoutEffect 按两侧空位算好
            （样式见 ide-menu-bar.less 的 .ide-menu-bar-title） */}
        {navTitle && titleMaxWidth !== 0 ? (
          <div
            ref={titleRef}
            className={`ide-menu-bar-title${
              canRenameFromTitle && !renamingTitle
                ? ' ide-menu-bar-title-editable'
                : ''
            }${renamingTitle ? ' ide-menu-bar-title-editing' : ''}`}
            style={titleMaxWidth ? { maxWidth: titleMaxWidth } : undefined}
            // 可改名时这个名字块才接收事件（默认 pointer-events:none，
            // 极窄屏下也挡不住菜单；这里的 maxWidth 已排除两侧空间，所以安全）
            onClick={
              canRenameFromTitle && !renamingTitle
                ? startTitleRename
                : undefined
            }
            onKeyDown={
              canRenameFromTitle && !renamingTitle
                ? event => {
                    if (event.key === 'Enter' || event.key === 'F2') {
                      event.preventDefault()
                      startTitleRename()
                    }
                  }
                : undefined
            }
            role={canRenameFromTitle ? 'button' : undefined}
            tabIndex={canRenameFromTitle ? 0 : undefined}
            title={canRenameFromTitle ? t('rename_project') : undefined}
          >
            {renamingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                className="ide-menu-bar-title-input"
                style={titleEditWidth ? { width: titleEditWidth } : undefined}
                value={titleDraft}
                onChange={event => setTitleDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    finishTitleRename()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    cancelTitleRename()
                  }
                }}
                onBlur={finishTitleRename}
                // 点空白按钮等不应打断输入
                onMouseDown={event => event.stopPropagation()}
              />
            ) : (
              navTitle
            )}
          </div>
        ) : null}

        <div className="ide-menu-bar-right" ref={rightGroupRef}>
          {/* FIXED: 2026-11-13 审阅面板（行内批注）入口。
              ⚠️ 不能只靠老工具栏里的那个按钮：本项目用 IDE 菜单栏替换了原来的
              `.toolbar-content`，而 `.toolbar-with-menu-bar .toolbar-content`
              是 `display:none !important` —— 按钮在 DOM 里但尺寸为 0，
              用户根本看不到（这正是排查时 `可点击: false, 尺寸: [0,0]` 的原因）。
              所以在菜单栏右侧再放一个同语义的入口。
              FIXED: 2026-11-18 加 ide-review-entry 类：手机上只在「源码」档显示（见
              mobile-pdf-only.less）。其他档位编辑器那栏根本不显示，点了没有任何反应。 */}
          {shouldDisplayReviewButton && (
            <div className="toolbar-item ide-review-entry">
              <button
                className={`btn btn-full-height${
                  reviewPanelOpen ? ' active' : ''
                }`}
                onMouseDown={toggleReviewPanelOpen}
                title={t('review')}
              >
                <i className="review-icon" />
                <p className="toolbar-label">{t('review')}</p>
              </button>
            </div>
          )}
          <ShareProjectButton onClick={openShareModal} />
          <LayoutDropdownButton />
        </div>
      </div>

      <AccessibleModal
        onHide={closeAIModal}
        className="ide-ai-modal"
        show={showAIModal}
        backdrop="static"
        keyboard={false}
      >
        <Modal.Header closeButton={!isLoading}>
          <Modal.Title>{t('ai_assistant')}</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          {showAlert && (
            <Alert bsStyle="info">{t('content_copied_to_clipboard')}</Alert>
          )}
          {/* FIXED: 2026-10-29 翻译结果弹窗支持切换目标语言（源语言由模型自动判断） */}
          {lastMode === 'translate' && (
            <div className="ide-ai-modal-language">
              <label htmlFor="toolbar-ai-target-lang">
                {t('translate_target_language')}
              </label>
              <select
                id="toolbar-ai-target-lang"
                value={targetLang}
                disabled={isLoading}
                onChange={e => handleTargetLangChange(e.target.value)}
              >
                {!targetLang && (
                  <option value="">{t('please_select_target_language')}</option>
                )}
                {TARGET_LANGS.map(lang => (
                  <option key={lang} value={lang}>
                    {t(TARGET_LANG_LABEL_KEY[lang])}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div
            className="ide-ai-modal-content"
            onClick={handleCopyContent}
            style={{
              cursor: copyableContent ? 'pointer' : 'default',
            }}
          >
            {content}
          </div>
        </Modal.Body>

        <Modal.Footer>
          {/* FIXED: 2026-10-29 这是弹窗的主操作，用主按钮（原来是默认灰，主题化后和底栏同色） */}
          <Button bsStyle="primary" onClick={closeAIModal} disabled={isLoading}>
            {isLoading ? t('processing') : t('ok')}
          </Button>
        </Modal.Footer>
      </AccessibleModal>

      <WordCountModal
        show={showWordCountModal}
        handleHide={() => setShowWordCountModal(false)}
      />

      <AccessibleModal
        show={showRenameModal}
        onHide={() => setShowRenameModal(false)}
        className="rename-project-modal"
      >
        <form onSubmit={handleRenameSubmit}>
          <Modal.Header closeButton>
            <Modal.Title>{t('rename_project')}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <div className="form-group">
              <label>{t('project_name')}</label>
              <input
                type="text"
                className="form-control"
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                autoFocus
              />
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" onClick={() => setShowRenameModal(false)}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              bsStyle="primary"
              disabled={
                !newProjectName.trim() || newProjectName === projectName
              }
            >
              {t('rename')}
            </Button>
          </Modal.Footer>
        </form>
      </AccessibleModal>

      <Modal
        show={showAboutModal}
        onHide={() => setShowAboutModal(false)}
        centered
      >
        <Modal.Header closeButton>
          {/* FIXED: 2026-11-10 标题不再用「favicon + FlyLaTeX」，改成多语言的「关于系统」。
                  旧写法：
                    <img src={`${baseAssetPath}favicon.ico`} alt="FlyLaTeX" width="32"
                         height="32" style={{ marginRight: '10px', verticalAlign: 'middle' }} />
                    FlyLaTeX
                  产品标识挪到正文（见下方 AboutBrandMark），这里只留标题文字。 */}
          <Modal.Title>{t('about_system')}</Modal.Title>
        </Modal.Header>
        {/* FIXED: 2026-11-10 正文上方的空白收一点，避免标题与字标之间空隙过大 */}
        <Modal.Body style={{ textAlign: 'center', paddingTop: '18px' }}>
          {/* FIXED: 2026-11-10 正文顶部放 FlyLaTeX 字标（复用系统加载页的填充动画），
                  压在 TeXLive 版本号上方。宽度收窄到 150px，避免弹窗过高。 */}
          <AboutBrandMark width={150} />
          {/* FIXED: 2026-11-05 原来写死 `TeXLive 2026`，服务器上装的是 2023/2025，
                三者互不相同。现在用 tlmgr 自己报的版本，探测不到就只显示 `TeXLive`。
                刻意不展示安装树路径 / 原始输出（不向客户端泄露服务器细节） */}
          {/* 悬停显示完整版本号（TeX Live 2025）：不带安装路径，不加任何解释性文案 */}
          {/* FIXED: 2026-11-10 版本号原来只有浏览器默认的下边距，上方紧贴字标，看起来
                上下不对称。改成上下各 12.5px，与字标和版权行保持匀称的间距。 */}
          <p
            title={texLiveVersionTitle(texLiveVersion)}
            style={{ margin: '12.5px 0' }}
          >
            <strong>{texLiveVersionLabel(texLiveVersion)}</strong>
          </p>
          {/* FIXED: 2026-11-24 版权保护方改为配置驱动（cn 公司主体 / sg 产品名） */}
          <p>{copyrightLine()}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button bsStyle="primary" onClick={() => setShowAboutModal(false)}>
            {t('close')}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* FIXED: 2026-11-19 trackChangesVisible 原来写死 false，导致「审阅」那组
          快捷键（Ctrl/Cmd+J 等）在弹窗里永远不显示。这里跟右侧审阅按钮同源。 */}
      <HotkeysModal
        show={showHotkeysModal}
        handleHide={() => setShowHotkeysModal(false)}
        isMac={isMac}
        trackChangesVisible={Boolean(shouldDisplayReviewButton)}
        newSourceEditor={true}
      />

      <GitInfoModal
        showModal={showGitInfo}
        handleClose={() => setShowGitInfo(false)}
        projectId={projectId}
      />
    </>
  )
}

IdeMenuBar.propTypes = {
  onShowLeftMenuClick: PropTypes.func,
  openShareModal: PropTypes.func.isRequired,
  historyIsOpen: PropTypes.bool,
  toggleHistoryOpen: PropTypes.func.isRequired,
  isRestrictedTokenMember: PropTypes.bool,
  chatIsOpen: PropTypes.bool,
  toggleChatOpen: PropTypes.func.isRequired,
  unreadMessageCount: PropTypes.number.isRequired,
  hasPublishPermissions: PropTypes.bool,
  cobranding: PropTypes.object,
  shouldDisplayPublishButton: PropTypes.bool,
  projectName: PropTypes.string,
  renameProject: PropTypes.func,
  hasRenamePermissions: PropTypes.bool,
  onOpenProjectInfo: PropTypes.func,
  shouldDisplayReviewButton: PropTypes.bool,
  reviewPanelOpen: PropTypes.bool,
  toggleReviewPanelOpen: PropTypes.func.isRequired,
}

const ToolbarHeader = React.memo(function ToolbarHeader({
  cobranding,
  onShowLeftMenuClick,
  chatIsOpen,
  toggleChatOpen,
  reviewPanelOpen,
  toggleReviewPanelOpen,
  historyIsOpen,
  toggleHistoryOpen,
  unreadMessageCount,
  onlineUsers,
  goToUser,
  isRestrictedTokenMember,
  hasPublishPermissions,
  projectName,
  renameProject,
  hasRenamePermissions,
  openShareModal,
  trackChangesVisible,
  hasWritePermissions,
}) {
  const { t } = useTranslation()
  const shouldDisplayPublishButton = hasPublishPermissions && PublishButton
  const shouldDisplayTrackChangesButton =
    trackChangesVisible && !isRestrictedTokenMember

  // FIXED: 2026-11 项目名称 + 标签在顶部常态展示，编辑入口收在「项目信息」弹窗里
  // （工具条上不放输入框：`.toolbar-center` 在窄屏只有一两百像素，放输入框必然挤爆）
  const projectId = getMeta('ol-project_id')
  const projectTags = useProjectTags(projectId)
  const [showProjectInfo, setShowProjectInfo] = useState(false)
  const openProjectInfo = useCallback(() => setShowProjectInfo(true), [])
  const closeProjectInfo = useCallback(() => setShowProjectInfo(false), [])

  const projectInfoModal = (
    <ProjectInfoModal
      show={showProjectInfo}
      onHide={closeProjectInfo}
      projectName={projectName}
      hasRenamePermissions={hasRenamePermissions}
      onRename={renameProject}
      tagsState={projectTags}
    />
  )

  if (SHOW_IDE_MENU_BAR) {
    return (
      <header
        className="toolbar toolbar-header toolbar-with-labels toolbar-with-menu-bar"
        role="navigation"
        aria-label={t('project_layout_sharing_submission')}
      >
        <IdeMenuBar
          onShowLeftMenuClick={onShowLeftMenuClick}
          openShareModal={openShareModal}
          historyIsOpen={historyIsOpen}
          toggleHistoryOpen={toggleHistoryOpen}
          isRestrictedTokenMember={isRestrictedTokenMember}
          chatIsOpen={chatIsOpen}
          toggleChatOpen={toggleChatOpen}
          unreadMessageCount={unreadMessageCount}
          hasPublishPermissions={hasPublishPermissions}
          cobranding={cobranding}
          shouldDisplayPublishButton={shouldDisplayPublishButton}
          projectName={projectName}
          renameProject={renameProject}
          hasRenamePermissions={hasRenamePermissions}
          onOpenProjectInfo={openProjectInfo}
          shouldDisplayReviewButton={shouldDisplayTrackChangesButton}
          reviewPanelOpen={reviewPanelOpen}
          toggleReviewPanelOpen={toggleReviewPanelOpen}
        />
        <div className="toolbar-content">
          <div className="toolbar-left">
            <MenuButton onClick={onShowLeftMenuClick} />
            {cobranding && cobranding.logoImgUrl && (
              <CobrandingLogo {...cobranding} />
            )}
            <BackToProjectsButton />
          </div>
          {window.showUpgradePrompt && <UpgradePrompt />}
          <div className="toolbar-center project-title-bar">
            <ProjectNameEditableLabel
              projectName={projectName}
              hasRenamePermissions={hasRenamePermissions}
              onChange={renameProject}
            />
            <ProjectTagsPills
              tags={projectTags.projectTags}
              canEdit={projectTags.canEdit}
              onEdit={openProjectInfo}
            />
          </div>

          <div className="toolbar-right">
            <OnlineUsersWidget onlineUsers={onlineUsers} goToUser={goToUser} />

            {shouldDisplayTrackChangesButton && (
              <TrackChangesToggleButton
                onMouseDown={toggleReviewPanelOpen}
                disabled={historyIsOpen}
                trackChangesIsOpen={reviewPanelOpen}
              />
            )}

            {shouldDisplayPublishButton && (
              <PublishButton cobranding={cobranding} />
            )}

            <GitSyncButton hasWritePermissions={hasWritePermissions} />
          </div>
        </div>
        {projectInfoModal}
      </header>
    )
  }

  return (
    <header
      className="toolbar toolbar-header toolbar-with-labels"
      role="navigation"
      aria-label={t('project_layout_sharing_submission')}
    >
      <div className="toolbar-left">
        <MenuButton onClick={onShowLeftMenuClick} />
        {cobranding && cobranding.logoImgUrl && (
          <CobrandingLogo {...cobranding} />
        )}
        <BackToProjectsButton />
      </div>
      {window.showUpgradePrompt && <UpgradePrompt />}
      <div className="toolbar-center project-title-bar">
        <ProjectNameEditableLabel
          projectName={projectName}
          hasRenamePermissions={hasRenamePermissions}
          onChange={renameProject}
        />
        <ProjectTagsPills
          tags={projectTags.projectTags}
          canEdit={projectTags.canEdit}
          onEdit={openProjectInfo}
        />
      </div>

      <div className="toolbar-right">
        <OnlineUsersWidget onlineUsers={onlineUsers} goToUser={goToUser} />

        {shouldDisplayTrackChangesButton && (
          <TrackChangesToggleButton
            onMouseDown={toggleReviewPanelOpen}
            disabled={historyIsOpen}
            trackChangesIsOpen={reviewPanelOpen}
          />
        )}

        <ShareProjectButton onClick={openShareModal} />
        {shouldDisplayPublishButton && (
          <PublishButton cobranding={cobranding} />
        )}

        {!isRestrictedTokenMember && (
          <HistoryToggleButton
            historyIsOpen={historyIsOpen}
            onClick={toggleHistoryOpen}
          />
        )}

        <GitSyncButton hasWritePermissions={hasWritePermissions} />

        <LayoutDropdownButton />
      </div>
      {projectInfoModal}
    </header>
  )
})

ToolbarHeader.propTypes = {
  onShowLeftMenuClick: PropTypes.func.isRequired,
  cobranding: PropTypes.object,
  chatIsOpen: PropTypes.bool,
  toggleChatOpen: PropTypes.func.isRequired,
  reviewPanelOpen: PropTypes.bool,
  toggleReviewPanelOpen: PropTypes.func.isRequired,
  historyIsOpen: PropTypes.bool,
  toggleHistoryOpen: PropTypes.func.isRequired,
  unreadMessageCount: PropTypes.number.isRequired,
  onlineUsers: PropTypes.array.isRequired,
  goToUser: PropTypes.func.isRequired,
  isRestrictedTokenMember: PropTypes.bool,
  hasPublishPermissions: PropTypes.bool,
  projectName: PropTypes.string.isRequired,
  renameProject: PropTypes.func.isRequired,
  hasRenamePermissions: PropTypes.bool,
  openShareModal: PropTypes.func.isRequired,
  trackChangesVisible: PropTypes.bool,
  hasWritePermissions: PropTypes.bool.isRequired,
}

export default ToolbarHeader
