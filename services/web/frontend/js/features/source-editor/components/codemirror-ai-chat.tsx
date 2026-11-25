import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  useLayoutEffect,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
// FIXED: 2026-10-16 使用共享 markdown 渲染，外链自动新标签页打开
// OLD: import { marked } from 'marked'
import { MathJaxMarkdown } from '../../../shared/components/mathjax-markdown'
import { useCodeMirrorViewContext } from './codemirror-editor'
// FIXED: 2026-11-02 选区/光标快照（随 AI 请求发给后端，供 get_editor_context /
// replace_selection 工具使用）
import { buildEditorContext } from '../../../shared/utils/editor-context'
// FIXED: 2026-11-17 输入框里 @ 指定文件（只让 Agent 关注这几个文件）
import {
  collectMentionFiles,
  filterMentionFiles,
  getMentionQuery,
  removeMentionToken,
  MAX_MENTION_FILES,
  type MentionFile,
} from '@/features/ai-chat/utils/mention-files'
// FIXED: 2026-11-18 输入框 `/` 指定 MCP 服务（与 @ 文件同一套交互）
import {
  getSlashQuery,
  filterMcpServers,
  removeSlashToken,
  type McpServerOption,
} from '@/features/ai-chat/utils/mcp-slash'
import { useFileTreeData } from '@/shared/context/file-tree-data-context'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import Icon from '../../../shared/components/icon'
import getMeta from '../../../utils/meta'
import type { AIPanelLayout } from '../../../../../types/project-settings'
// FIXED: 2026-10-30 历史对话改成弹层菜单 + 删除前确认弹窗
import { Dropdown, Modal, Button } from 'react-bootstrap'
import AccessibleModal from '../../../shared/components/accessible-modal'
import AISparklesIcon from '../../../shared/components/ai-sparkles-icon'
import { showSuccessToast, showErrorToast } from '../../../shared/utils/toast'
import {
  postJSON,
  getJSON,
  deleteJSON,
} from '../../../infrastructure/fetch-json'
// FIXED: 2026-10-23 输入法选词时的 Enter 不应触发发送
import { isImeComposing } from '../../../shared/utils/ime'
// FIXED: 2026-11-16 选区浮条「问 AI」把选中内容塞进输入框
import {
  AI_PREFILL_EVENT,
  consumeAiPrefill,
  mergePrefill,
} from '@/features/ai-chat/utils/ai-prefill'
// FIXED: 2026-10-29 ask/agent 模式按项目记忆（与 ai-chat-panel 共用一份实现）
import {
  readChatMode,
  storeChatMode,
  currentProjectId,
} from '../../../shared/utils/chat-mode-storage'
// FIXED: 2026-10-30 一个项目多段对话（新建/历史/删除）
import {
  newConversationId,
  readActiveConversationId,
  storeActiveConversationId,
  sortConversations,
  displayTitle,
  type ConversationSummary,
} from '../../../shared/utils/ai-conversations'
// FIXED: 2026-11-07 流式（SSE）：工具步骤与结论边跑边显示
import {
  streamAiChat,
  upsertStep,
  isAbortError,
  isStreamInterrupted,
  newRunId,
  stopAiRun,
  getAiRunStatus,
  // FIXED: 2026-11 切回页面时接上进行中的一轮（快照 + 增量）
  resumeAiRun,
  type AiChatStep,
  type AiChatDonePayload,
} from '../../../shared/utils/ai-chat-stream'
import AiSteps from '../../../shared/components/ai-steps'
import { debugConsole } from '@/utils/debugging'
import {
  resolveSideDockFromState,
  isSideDockAvailableByDom,
  isBottomDockAvailable,
  getSideDockPane,
} from '@/features/ai-chat/utils/ai-panel-layout'
// FIXED: 2026-11-17 消息时间戳（提问/回复下方、功能按钮前面），与侧栏面板共用一套格式
import AiMessageTime from '../../../shared/components/ai-message-time'
import { computeElapsedByMessageId } from '../../../shared/utils/chat-time'

// FIXED: 2026-11-07 流式请求统一走 shared/utils/ai-chat-stream.ts（内部 POST /ft-ai）
// OLD: const FETCH_AI_BASE = '/ft-ai'
const AI_CHAT_API_BASE = '/api/ai-chat'

// FIXED: 2026-10-16 marked 配置统一收敛到 shared/utils/markdown.ts
// OLD:
// // 配置 marked，禁用一些可能不安全的功能
// marked.setOptions({ breaks: true, gfm: true })

type ChatMode = 'ask' | 'agent'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  isLoading?: boolean
  model?: string
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  processMarkdown?: string // ← 执行过程信息
  statusHistory?: string[] // ← 流式状态历史
  showProcess?: boolean // ← 是否展开执行过程
  images?: Array<{ url: string; name: string }> // ← 图片数据
  isExpanded?: boolean // ← FIXED: 2026-10-16 长消息是否展开（默认折叠）
  // FIXED: 2026-11-07 流式新增：工具步骤（只存内存，不落库）/ 当前阶段文案 / 用户已停止
  steps?: AiChatStep[]
  statusText?: string
  stopped?: boolean
  /**
   * @deprecated 2026-11 不再使用：这条「连接中断但后台还在跑」的状态已并入
   * resumingRun 的统一流程（见 handleSend 的 isStreamInterrupted 分支），
   * 之前它会让界面同时出现「结论」和「上一轮仍在执行」两套说法。
   */
  interrupted?: boolean
  // FIXED: 2026-11-17 时间戳：历史消息用服务端的 createdAt，实时消息在「不再 loading」时补上
  createdAt?: string
}

// FIXED: 2026-11 用户点过「停止」之后，这段时间内不再为同一个 runId 显示
// 「仍在后台执行」占位（服务端已经即时摘表，这里是防旧版本服务端/多副本的兜底）
const STOPPED_RUN_GRACE_MS = 90000

/**
 * FIXED: 2026-11 重连退避：1.5s → 3s → 5s → 8s → 10s 封顶。
 * 连不上就别每 1.5 秒锤一次，但也不能等太久（用户正盯着）。
 */
function resumeBackoff(attempts: number): number {
  const table = [1500, 3000, 5000, 8000, 10000]
  return table[Math.min(Math.max(attempts - 1, 0), table.length - 1)]
}

/**
 * FIXED: 2026-11 服务端历史里「最后一句提问之后有没有回答」。
 * 用来区分「这一轮跑完了只是还没拉回来」和「这一轮根本没留下结果」。
 */
function hasReplyAfterLastUser(list: Message[]): boolean {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') return i < list.length - 1
  }
  return list.length > 0
}

// FIXED: 2026-10-16 长输入默认折叠，避免整段编译日志把对话撑爆
const COLLAPSE_CHAR_THRESHOLD = 400 // 超过 400 字
const COLLAPSE_LINE_THRESHOLD = 8 // 或超过 8 行

function isLongContent(text: string): boolean {
  if (!text) return false
  return (
    text.length > COLLAPSE_CHAR_THRESHOLD ||
    text.split('\n').length > COLLAPSE_LINE_THRESHOLD
  )
}

/**
 * FIXED: 2026-10-16 用户消息按「空行」分段渲染
 *
 * 问题：用户消息是纯文本 + white-space: pre-wrap，导致每个空行都按整行高
 *       （13px × 1.5 ≈ 19.5px）撑开；而助手消息走 markdown，空行只产生 8px 段间距。
 * 方案：按空行切成段，段间距 8px（与助手一致）；段内仍用 pre-wrap 保留单个换行。
 */
function PlainTextBlocks({ text }: { text: string }) {
  return (
    <>
      {text.split(/\r?\n[ \t]*\r?\n+/).map((para, i) =>
        para === '' ? null : (
          <div key={i} className="ai-plain-block">
            {para}
          </div>
        )
      )}
    </>
  )
}

function AIChatPanelContent({
  onClose,
  onRequestClose,
  temporaryBottomDock = false,
}: {
  onClose: () => void
  /**
   * 主动请求收起面板（当前用于移动端：Agent 改完文件、编译已发出，先把屏幕让给 PDF）。
   *
   * FIXED: 2026-11 这里原来直接调用外层组件的 `setIsOpen` —— 它不在本组件作用域里，
   * 于是移动端每次「Agent 改完文件」都会抛 ReferenceError: setIsOpen is not defined，
   * 被外层 catch 捕获后又把这句话当成错误消息显示给用户。
   */
  onRequestClose?: () => void
  /** 用户设的是右侧，但右侧没展开，此刻临时停靠到底部 */
  temporaryBottomDock?: boolean
}) {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const [docName] = useScopeValue<string>('editor.open_doc_name')
  // FIXED: 2026-11-02 选区/光标要一起发给后端，Agent 才能做「翻译选中内容并原文替换」
  const [docId] = useScopeValue<string>('editor.open_doc_id')
  const [selectionHint, setSelectionHint] = useState<{
    lines: number
    chars: number
  } | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  // FIXED: 2026-11-17 消息时间戳：历史消息自带服务端的 createdAt，实时消息在
  //   「不再 loading」的那一帧补一个。放 effect 里而不是散在 4 处收尾分支上，
  //   是因为流式中断/恢复/停止都各自 setMessages 一次，漏一处就没时间戳。
  useEffect(() => {
    if (!messages.some(m => !m.isLoading && !m.createdAt)) return
    setMessages(prev => {
      let changed = false
      const next = prev.map(m => {
        if (m.isLoading || m.createdAt) return m
        changed = true
        return { ...m, createdAt: new Date().toISOString() }
      })
      // 没变就返回原引用，避免「effect 再跑一轮」
      return changed ? next : prev
    })
  }, [messages])
  // 每条回复的用时（回复时间 - 它前面那条提问时间），渲染时只读
  const elapsedByMessageId = useMemo(
    () => computeElapsedByMessageId(messages),
    [messages]
  )
  // FIXED: 2026-11-16 面板是「打开才挂载」的：挂载时先吃掉浮条留下的待填内容，
  // 再监听事件（已挂载的情况）。
  const [input, setInput] = useState(() => consumeAiPrefill() || '')
  const [isLoading, setIsLoading] = useState(false)
  // FIXED: 2026-10-29 初始值取自当前项目的记忆值（无记录时仍是 'ask'）
  // OLD: const [chatMode, setChatMode] = useState<ChatMode>('ask')
  const [chatMode, setChatMode] = useState<ChatMode>(() =>
    readChatMode(currentProjectId())
  )
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; name: string }>
  >([])
  const [selectedImage, setSelectedImage] = useState<{
    url: string
    name: string
  } | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null) // 待删除的消息 ID
  // FIXED: 2026-10-30 当前会话 id / 历史列表 / 抽屉开关 / 待确认删除的会话
  const projectId = currentProjectId()
  const [conversationId, setConversationId] = useState<string>(() =>
    readActiveConversationId(currentProjectId())
  )
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false)
  const [pendingDeleteConversationId, setPendingDeleteConversationId] =
    useState<string | null>(null)
  const [deletingConversation, setDeletingConversation] = useState(false)
  // FIXED: 2026-10-30 「清除」原来点一下就没了，和其他删除动作不一致
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // FIXED: 2026-11-18 消息列表（真正的滚动容器）的 ref，滚到底只动它，
  // 不再用 scrollIntoView（原因见 scrollToBottom 的注释）。
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ---- FIXED: 2026-11-17 输入框 @ 文件 ----
  // 文件清单来自文件树（项目打开时由 file-tree 维护，重命名/移动/删除都会同步）
  const { fileTreeData } = useFileTreeData()
  const mentionFiles = useMemo(
    () => collectMentionFiles(fileTreeData),
    [fileTreeData]
  )
  /** 本条消息要「重点只看」的文件；chip 是唯一可信来源，发送时用它的 path 列表 */
  const [focusFiles, setFocusFiles] = useState<MentionFile[]>([])
  /** 当前正在输入的 `@查询词`；null = 没有弹候选 */
  const [mention, setMention] = useState<{
    start: number
    query: string
  } | null>(null)

  // ---- FIXED: 2026-11-18 `/` 指定 MCP 服务 ----
  /** 当前用户「有效（启用中）」的 MCP 服务；空数组 = 没有，`/` 就什么都不弹 */
  const [mcpServers, setMcpServers] = useState<McpServerOption[]>([])
  const mcpFetchedAtRef = useRef(0)
  /** 当前正在输入的 `/查询词` */
  const [mcpMention, setMcpMention] = useState<{
    start: number
    query: string
  } | null>(null)
  const [mcpIndex, setMcpIndex] = useState(0)
  /** 本轮明确指定的 MCP 服务（chip 是唯一可信来源） */
  const [focusMcp, setFocusMcp] = useState<McpServerOption | null>(null)
  const mcpCandidates = useMemo(
    () => (mcpMention ? filterMcpServers(mcpServers, mcpMention.query) : []),
    [mcpMention, mcpServers]
  )

  /**
   * 懒加载服务列表：只在真的敲了 `/` 时请求一次（60s 内复用）。
   * 拿不到（没权限 / 接口挂了）就当没有 —— 菜单不出现，其它功能不受影响。
   */
  const ensureMcpServers = useCallback(() => {
    if (Date.now() - mcpFetchedAtRef.current < 60 * 1000) return
    mcpFetchedAtRef.current = Date.now()
    getJSON<{ code: number; data: { servers?: McpServerOption[] } }>(
      '/ft-ai/mcp-servers/usable'
    )
      .then(payload => {
        const servers = payload?.data?.servers
        setMcpServers(Array.isArray(servers) ? servers : [])
      })
      .catch(() => {
        // 失败不打扰用户：当作「没有可用服务」
        setMcpServers([])
      })
  }, [])
  /** 候选里高亮第几条（键盘上下键） */
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionCandidates = useMemo(
    () => (mention ? filterMentionFiles(mentionFiles, mention.query) : []),
    [mention, mentionFiles]
  )

  /** 输入变化后重新判断「光标前是不是 @查询词」 */
  const syncMention = useCallback(
    (value: string, caret: number | null) => {
      const hit = getMentionQuery(value, caret ?? value.length)
      setMention(hit)
      setMentionIndex(0)

      // FIXED: 2026-11-18 `/` 菜单：@ 已经在弹的时候不抢（两者互斥）
      const slash = hit ? null : getSlashQuery(value, caret ?? value.length)
      setMcpMention(slash)
      setMcpIndex(0)
      if (slash) ensureMcpServers()
    },
    [ensureMcpServers]
  )

  /** 选中一个候选：把 `@路径 ` 写进文本框，并记进 focusFiles */
  const pickMention = useCallback(
    (file: MentionFile) => {
      const el = inputRef.current
      const caret = el?.selectionStart ?? input.length
      const start = mention ? mention.start : caret
      // 用 textarea 里的真实位置切片，用户可能已经手动滚动过光标
      const before = input.slice(0, Math.max(0, Math.min(start, caret)))
      const after = input.slice(caret)
      const token = `@${file.path} `
      const next = before + token + after
      const caretAfter = before.length + token.length

      setInput(next)
      setMention(null)
      setFocusFiles(prev =>
        prev.some(item => item.path === file.path)
          ? prev
          : [...prev, file].slice(0, MAX_MENTION_FILES)
      )

      // 光标放回 token 之后（受控 textarea 要等这一帧渲染完）
      requestAnimationFrame(() => {
        const node = inputRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(caretAfter, caretAfter)
      })
    },
    [input, mention]
  )

  /** 选中一个 MCP 服务：把 `/服务名 ` 写进文本框，并记为「本轮用它」 */
  const pickMcp = useCallback(
    (server: McpServerOption) => {
      const el = inputRef.current
      const caret = el?.selectionStart ?? input.length
      const start = mcpMention ? mcpMention.start : caret
      const before = input.slice(0, Math.max(0, Math.min(start, caret)))
      const after = input.slice(caret)
      const token = `/${server.name} `
      const next = before + token + after
      const caretAfter = before.length + token.length

      setInput(next)
      setMcpMention(null)
      setFocusMcp(server)

      requestAnimationFrame(() => {
        const node = inputRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(caretAfter, caretAfter)
      })
    },
    [input, mcpMention]
  )

  /** 点掉 MCP chip：同时清掉文本里的 `/服务名` */
  const removeFocusMcp = useCallback(() => {
    if (!focusMcp) return
    setInput(prev => removeSlashToken(prev, focusMcp.name))
    setFocusMcp(null)
    setMcpMention(null)
  }, [focusMcp])

  /** 点掉 chip：同时把文本框里的 `@路径` 也去掉，避免文本和 chip 不一致 */
  const removeFocusFile = useCallback(
    (path: string) => {
      setFocusFiles(prev => prev.filter(item => item.path !== path))
      setInput(prev => removeMentionToken(prev, path))
      setMention(null)
    },
    []
  )

  // FIXED: 2026-11-16 选区浮条「问 AI」：面板已经打开时靠这个事件把文本填进去
  useEffect(() => {
    const handler = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text
      if (!text) {
        return
      }
      setInput(current => mergePrefill(current, text))
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener(AI_PREFILL_EVENT, handler as EventListener)
    return () =>
      window.removeEventListener(AI_PREFILL_EVENT, handler as EventListener)
  }, [])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // FIXED: 2026-11-07 当前这轮流式请求的中止句柄（“停止”按钮用）
  const stopRef = useRef<AbortController | null>(null)
  // FIXED: 2026-11-01 切走页面继续跑：本轮 runId + “上一轮仍在执行”的恢复状态
  const runIdRef = useRef<string | null>(null)
  // FIXED: 2026-11 兜底占位也带进度（步数 / 当前步骤 / 已运行时长），
  // 免得"接不上流式"时又回到只有一个转圈的黑盒。
  const [resumingRun, setResumingRun] = useState<{
    runId?: string
    stepCount?: number
    currentStep?: string | null
    statusText?: string | null
    elapsedMs?: number
    textLength?: number
    /**
     * FIXED: 2026-11 已经挂上服务端的 live 流了（占位消息自己在显进度）。
     * 这时不需要再额外弹「仍在后台执行」的横幅，但**必须**仍然算“忙”：
     * 输入框要禁用、发送键要变成停止。
     * 之前这里一律置 null，结果就是：上面还在跑，下面却能输入能发送，而且停不了。
     */
    attached?: boolean
  } | null>(null)
  const hadDetachedRunRef = useRef(false)
  // FIXED: 2026-11 手动催一次「去问服务端这一轮还在不在跑」。
  // 发送途中流被掐断时用它把状态交给恢复流程接管，而不是自己另画一条横幅。
  const [resumeTick, setResumeTick] = useState(0)
  // FIXED: 2026-11 刚点过「停止」的 runId（runId → 时间戳）。
  // 服务端摘表是即时的，但旧版本服务端 / 多副本部署下可能还会报 running，
  // 这一小段「别再把它弹回来」的窗口就是防那个「点停止→横幅又回来」的循环。
  const stoppedRunIdsRef = useRef<Map<string, number>>(new Map())
  const isLoadingRef = useRef(false)
  // FIXED: 2026-11 切回页面接上后台那一轮时，它并不走 setIsLoading（那是本端发送用的），
  // 所以必须单独算一个“忙”。否则就是用户看到的：上面还在跑，下面能输入能发送，而且停不了。
  const resumedActive = Boolean(resumingRun && resumingRun.attached)
  // 只要“有一轮在跑”（不管是不是接上来的 live 流）就算忙：
  // 输入框禁用、发送键变停止键。接不上流（只有横幅）的那种也要能停、也不能重复发。
  const busy = isLoading || Boolean(resumingRun)
  // FIXED: 2026-10-23 记录 compositionend 时间，兜住 Safari 先结束组合再派发 Enter 的情况
  const compositionEndedAtRef = useRef(0)

  // 始终从服务器加载历史对话（唯一事实源）
  // FIXED: 2026-10-30 换成按会话加载：切换会话时重取，不再只取项目那一份
  // FIXED: 2026-11-01 抽成回调：「后台跑完」之后也能主动重拉一次
  // FIXED: 2026-11 拉历史**不能**把「正在流式的那条」抹掉。
  // 现场：切走页面再回来，偶尔整个回复区空着（只剩自己那句提问）。
  // 原因是面板打开时有两个请求在跑——这里拉历史、那边查“上一轮还在跑吗”并铺占位；
  // 历史请求晚回来时一句 setMessages(server) 就把占位覆盖没了，而这一轮还没落库。
  // 现在：保留本地的在流消息（resumed-* / isLoading），拼在服务端消息后面。
  const loadMessagesFromServer = useCallback(async () => {
    try {
      const result = await getJSON<any>(
        `${AI_CHAT_API_BASE}/messages?projectId=${encodeURIComponent(
          projectId
        )}&limit=20&conversationId=${encodeURIComponent(conversationId)}`
      )
      if (result.success && Array.isArray(result.data)) {
        console.log(
          '[CodeMirror AI Chat] Loaded messages from server:',
          result.data.length,
          conversationId
        )
        const serverMessages = result.data as Message[]
        setMessages(prev => {
          const keepTail = prev.filter(
            m => m.id.startsWith('resumed-') || m.isLoading
          )
          if (keepTail.length === 0) return serverMessages
          const existing = new Set(serverMessages.map(m => m.id))
          return [
            ...serverMessages,
            ...keepTail.filter(m => !existing.has(m.id)),
          ]
        })
        return serverMessages
      }
      return null
    } catch (err) {
      console.warn(
        '[CodeMirror AI Chat] Failed to load messages from server:',
        err
      )
      return null
    }
  }, [projectId, conversationId])

  useEffect(() => {
    loadMessagesFromServer()
  }, [loadMessagesFromServer])

  // FIXED: 2026-10-30 历史对话列表
  const refreshConversations = useCallback(async () => {
    try {
      const result = await getJSON<any>(
        `${AI_CHAT_API_BASE}/conversations?projectId=${encodeURIComponent(
          projectId
        )}`
      )
      if (result.success && Array.isArray(result.data)) {
        console.log(
          '[CodeMirror AI Chat] conversations:',
          result.data.map((c: ConversationSummary) => c.conversationId)
        )
        setConversations(sortConversations(result.data))
      } else {
        console.warn(
          '[CodeMirror AI Chat] conversations request failed:',
          result
        )
      }
    } catch (err) {
      console.warn('[CodeMirror AI Chat] Failed to load conversations:', err)
    }
  }, [projectId])

  useEffect(() => {
    refreshConversations()
  }, [refreshConversations, conversationId])

  // FIXED: 2026-11-18 移动端「跑完后输入框突然顶到屏幕上方、只能刷新」的根因修复。
  // OLD: messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  //
  // scrollIntoView 会连锁滚动所有可滚动祖先，含 overflow:hidden 的容器
  // （overflow:hidden 只是不显示滚动条，JS 仍可滚，且不会自动复位）。
  // 移动端浮层链路是 container(overflow:hidden) → 内层 div(overflow:hidden)
  // → .ai-chat-panel，内容瞬时超高时这几层被滚走，就出现「头部出屏、输入框
  // 跑到顶上、下方留白」，scrollTop 没人归零 → 只能刷新。
  // 直接给 .ai-chat-messages 设 scrollTop，只影响它自己，祖先一律不动。
  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current
    if (!el) {
      return
    }
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // FIXED: 2026-11-18 兜底自愈：已经中招的会话（祖先 scrollTop 停在非 0）在面板
  // 挂载时归零，不用再刷新页面；同时兑住 iOS 聚焦输入框时浏览器自行滚祖先链。
  useEffect(() => {
    const resetAncestorScroll = () => {
      let node: HTMLElement | null = messagesRef.current?.parentElement ?? null
      while (node && node !== document.body) {
        if (node.scrollTop !== 0) {
          node.scrollTop = 0
        }
        node = node.parentElement
      }
    }
    resetAncestorScroll()
    const timer = window.setTimeout(resetAncestorScroll, 300)
    return () => window.clearTimeout(timer)
  }, [])

  // 格式化模型名称显示，移除路径前缀和量化后缀
  const formatModelName = useCallback(
    (modelName: string | undefined): string => {
      if (!modelName) return ''

      // 如果包含路径，提取最后一个 / 后的部分
      let displayName = modelName
      if (modelName.includes('/')) {
        displayName = modelName.split('/').pop() || modelName
      }

      // 去掉末尾的量化后缀（-FP8, -FP16, -INT8, -INT4等）
      displayName = displayName.replace(
        /-(?:FP8|FP16|FP32|INT8|INT4|GGUF|AWQLM)$/i,
        ''
      )

      return displayName
    },
    []
  )

  const saveMessageToServer = useCallback(
    async (projectId: string, message: Message, convId: string) => {
      try {
        const result = await postJSON<any>(`${AI_CHAT_API_BASE}/save-message`, {
          body: {
            projectId,
            message,
            // FIXED: 2026-10-30 落到具体会话（老数据/未传时后端按 default 处理）
            conversationId: convId,
          },
        })

        if (result.success) {
          console.log(
            '[CodeMirror AI Chat] Message saved to server:',
            message.id
          )
        } else {
          console.warn(
            '[CodeMirror AI Chat] Server returned error:',
            result.error
          )
        }
      } catch (err) {
        console.warn(
          '[CodeMirror AI Chat] Error saving message to server:',
          err
        )
      }
    },
    []
  )

  // FIXED: 2026-11-02 跟踪当前选区，用于输入框上方的「已选中 N 行」徽标。
  // 只用 DOM 的 selectionchange + 轻微去重，不往 CM6 里加 extension（不改编辑器配置）。
  useEffect(() => {
    if (!view) return
    const update = () => {
      const { state } = view
      const main = state.selection.main
      if (main.empty) {
        setSelectionHint(null)
        return
      }
      const fromLine = state.doc.lineAt(main.from).number
      const toLine = state.doc.lineAt(main.to).number
      const next = {
        lines: toLine - fromLine + 1,
        chars: main.to - main.from,
      }
      setSelectionHint(prev =>
        prev && prev.lines === next.lines && prev.chars === next.chars
          ? prev
          : next
      )
    }
    update()
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [view])

  const handleSend = useCallback(async () => {
    // FIXED: 2026-11 busy 包含「切回来接上的后台那一轮」：
    // 它在跑的时候不能再发（服务端也只会回 409）
    if ((!input.trim() && pastedImages.length === 0) || busy) return

    const inputText = input.trim()
    const images = [...pastedImages]
    // FIXED: 2026-11-17 本次 @ 的文件：随请求发给后端，让它只关注这几个文件
    const focusPaths = focusFiles.map(file => file.path)
    // FIXED: 2026-11-18 本轮明确指定的 MCP 服务（后端只注入它的工具）
    const focusMcpNames = focusMcp ? [focusMcp.name] : []
    // FIXED: 2026-11-02 发送瞬间的编辑状态快照（选区文本 + 行号 + 光标位置）
    const editorContext = buildEditorContext(view, {
      docName,
      docId,
    })

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputText,
      images: images.length > 0 ? images : undefined,
      // FIXED: 2026-11-17 提问时间（回复的用时就是拿它算的）
      createdAt: new Date().toISOString(),
    }

    const loadingMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      isLoading: true,
    }

    // FIXED: 2026-11 重新发一条时，之前那条「这一轮没有留下结果 / 正在重连」的
    // 占位就该让位给新的一轮，否则历史里会一直挂着一条过时的提示。
    setMessages(prev => [
      ...prev.filter(m => !m.id.startsWith('resumed-')),
      userMessage,
      loadingMessage,
    ])
    setInput('')
    setPastedImages([])
    // 发完就清空 chip：下一轮不该继续背上一轮的 @ 文件 / MCP 服务
    setFocusFiles([])
    setFocusMcp(null)
    setMcpMention(null)
    setMention(null)
    setIsLoading(true)
    // FIXED: 2026-11 同步写 ref：useEffect 里那一步慢一帧，
    // 轮询可能刚好在这一帧里把「本端刚起的这一轮」当成上一轮接上去，出现两条一样的消息。
    isLoadingRef.current = true

    saveMessageToServer(projectId, userMessage, conversationId)
      // FIXED: 2026-10-30 先刷新一次列表：AI 请求失败时，新会话也应该出现在历史里
      .then(() => refreshConversations())
      .catch(err => {
        console.warn(
          '[CodeMirror AI Chat] Failed to save user message to server:',
          err
        )
      })

    // FIXED: 2026-11 提到 try 外面：catch 里要用它（流断了但已经流出来的正文不能丢）
    let streamedText = ''
    try {
      const conversationHistory = messages.map((m: any) => ({
        role: m.role,
        content: m.content,
      }))

      // FIXED: 2026-11-07 改走 /ft-ai 的流式（SSE）：工具步骤和结论边跑边显示，
      // 并且可以中途停止；只有拿到 done 才落库，存的就是最后那段结论。
      // OLD: const res = await fetch(FETCH_AI_BASE, {...}); const result = await res.json()
      const controller = new AbortController()
      stopRef.current = controller
      // FIXED: 2026-11-01 本轮 runId：服务端用它做「显式停止」和「回来查还在不在跑」
      const runId = newRunId()
      runIdRef.current = runId
      let steps: AiChatStep[] = []
      let donePayload: AiChatDonePayload | null = null
      let streamError = ''

      const patchLoading = (patch: Partial<Message>) => {
        setMessages(prev =>
          prev.map(m => (m.id === loadingMessage.id ? { ...m, ...patch } : m))
        )
      }

      // 10 秒还收不到任何事件：不重发（agent 可能已在改文件，重发＝重复执行＋重复计费），
      // 只把文案切到“等待完整结果”，连接继续挂着；若只是被代理攒住，最后仍会一次性到达。
      const firstFrameTimer = window.setTimeout(() => {
        patchLoading({
          statusText: '网络似乎不支持流式，正在等待完整结果…',
        })
      }, 10000)

      try {
        await streamAiChat(
          {
            text: inputText,
            // FIXED: 2026-10-23 把粘贴的图片一并送到后端，供多模态模型识别
            images: images.length > 0 ? images : undefined,
            mode: chatMode,
            conversation: conversationHistory,
            workspace: projectId,
            currentDocName: docName,
            // FIXED: 2026-11-01 服务端靠这两个字段把结论落库 / 支持停止与恢复
            conversationId,
            runId,
            // FIXED: 2026-11-02 让 Agent 知道「用户选中了什么 / 光标在哪一行」
            editorContext: editorContext ?? undefined,
            // FIXED: 2026-11-17 @ 指定的文件（后端把正文塞进系统提示，只关注这些文件）
            focusFiles: focusPaths.length > 0 ? focusPaths : undefined,
            // FIXED: 2026-11-18 `/服务名` 指定的 MCP 服务
            focusMcpServers: focusMcpNames.length > 0 ? focusMcpNames : undefined,
            // FIXED: 2026-11-10 后端在多层代理下拿不到真实域名（Host 被换成 localhost），
            // 所以把浏览器当前 origin 显式带过去，后端才能拼出能点开的项目链接
            origin: window.location.origin,
          },
          {
            onFirstEvent: () => window.clearTimeout(firstFrameTimer),
            onStatus: text => patchLoading({ statusText: text }),
            onStep: step => {
              steps = upsertStep(steps, step)
              patchLoading({ steps: [...steps] })
            },
            onDelta: delta => {
              streamedText += delta
              patchLoading({ content: streamedText, statusText: undefined })
            },
            onDone: payload => {
              donePayload = payload
            },
            onError: msg => {
              streamError = msg
            },
          },
          controller.signal
        )
      } finally {
        window.clearTimeout(firstFrameTimer)
      }

      if (streamError) {
        throw new Error(streamError)
      }
      if (!donePayload) {
        throw new Error('AI service error')
      }

      const finalPayload: AiChatDonePayload = donePayload

      // FIXED: 2026-11-01 Agent 改完文件 → 自动重载 + 编译，直接出新的 PDF。
      // 背景：后端 SSE 的 done 事件里一直带着 needsRecompile（= 本轮确实写过 .tex/.bib 等），
      // 但本组件此前完全没接这个字段：桌面端只是碰巧靠「重载文档 → autocompile」生效，
      // 移动端（PDF 单栏、没有编辑器可见）则永远看不到 Agent 的成果。
      // 这里补上唯一的收尾动作；面板关不关由平台决定（见下）。
      if (finalPayload.needsRecompile === true) {
        reloadCurrentDocumentAndRecompile()

        // 手机上 PDF 就是「结果页」，面板是全屏浮层：编译已发出，先把屏幕让出来，
        // 用户直接看到「编译中 → 新 PDF」。桌面端仍保留面板，方便继续追问。
        if (isMobileViewport()) {
          // FIXED: 2026-11 不再引用作用域外的 setIsOpen（见 props 注释）
          onRequestClose?.()
        }
      }

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        // 流式时以 done 里的完整文本为准（防止丢最后一段 delta）
        content: (finalPayload.data || streamedText || '').trim(),
        steps,
        model: finalPayload.model,
        totalTokens: finalPayload.usage?.totalTokens,
        inputTokens: finalPayload.usage?.inputTokens,
        outputTokens: finalPayload.usage?.outputTokens,
      }

      setMessages(prev =>
        prev.map(m => (m.id === loadingMessage.id ? aiMessage : m))
      )

      // FIXED: 2026-11-01 助手消息改为「服务端落库」（见 ai-agent.js persistReply）：
      // 以前是客户端在 done 之后写，用户切走页面就没人写，回来什么都看不到。
      // 这里只负责刷列表 + 从服务端重拉一次（拿到服务端的消息 id/时间）。
      // OLD: saveMessageToServer(projectId, aiMessage, conversationId)
      refreshConversations()
      window.setTimeout(() => {
        loadMessagesFromServer().catch(() => {})
      }, 600)
    } catch (err) {
      // FIXED: 2026-11-07 用户点“停止”：只告知，不落库、不当错误
      if (isAbortError(err)) {
        setMessages(prev =>
          prev.map(m =>
            m.id === loadingMessage.id
              ? {
                  ...m,
                  isLoading: false,
                  stopped: true,
                  content: '',
                  statusText: undefined,
                }
              : m
          )
        )
        return
      }
      // FIXED: 2026-11 连接断了（网络抖动 / 代理掐断 / 长时间无响应）不等于本轮失败：
      // 服务端设计上「客户端离开也会继续跑」，结论会落库。
      // 之前这里会把浏览器的 "Failed to fetch" 原样显示给用户，并且这一轮看起来没了。
      if (isStreamInterrupted(err)) {
        const status = await getAiRunStatus({
          projectId,
          conversationId,
        }).catch(() => ({ running: false, runId: undefined }))
        if (status.running) {
          // FIXED: 2026-11 别在这里另画一套「上一轮仍在后台执行」的横幅。
          // 现场（截图）：agent 已经给出结论（"项目编译目录不存在…"），下面却挂着
          // 「上一轮 Agent 仍在后台执行中…」，界面自己跟自己打架。
          // 现在把这条空壳消息收掉，状态整个交给恢复流程：
          // 它会用服务端快照重建这条消息（正文 / 步骤 / 阶段）并接上 live 增量。
          hadDetachedRunRef.current = true
          setResumingRun(null)
          setMessages(prev => prev.filter(m => m.id !== loadingMessage.id))
          setResumeTick(t => t + 1)
          return
        }
        // 服务端也认为没在跑：可能刚好在这一刻跑完并落库了，拉一次再说
        const list = await loadMessagesFromServer().catch(() => null)
        refreshConversations()
        if (list && hasReplyAfterLastUser(list)) {
          // FIXED: 2026-11 结论已经在历史里了：把这条空壳收掉，别和真结论并排显示
          setMessages(prev => prev.filter(m => m.id !== loadingMessage.id))
          return
        }
        setMessages(prev =>
          prev.map(m =>
            m.id === loadingMessage.id
              ? {
                  ...m,
                  isLoading: false,
                  statusText: undefined,
                  // FIXED: 2026-11 已经流出来的正文不要丢掉（以前一律清空）
                  content:
                    streamedText.trim() ||
                    t('ai_stream_interrupted', {
                      defaultValue:
                        '连接中断了，这一轮没有拿到结果。请重试；如果刚才已经改了文件，编译结果可在页面里确认。',
                    }),
                }
              : m
          )
        )
        return
      }

      console.error('[CodeMirror AI Chat] Error:', err)
      // FIXED: 2026-11-01 服务端现在会返回有意义的原因（如「上一轮 Agent 还在执行中」），
      // 不再一律写成「服务错误」，否则用户不知道该怎么办。
      const errText =
        err instanceof Error &&
        err.message &&
        err.message !== 'AI service error'
          ? err.message
          : t('service_error')
      setMessages(prev => {
        const newMessages = [...prev]
        const lastIndex = newMessages.findIndex(m => m.id === loadingMessage.id)
        if (lastIndex !== -1) {
          newMessages[lastIndex] = {
            ...loadingMessage,
            content: errText,
            isLoading: false,
          }
        }
        return newMessages
      })

      // FIXED: 2026-11-01 兜底：本次发送被服务端拒（如 RUN_IN_PROGRESS），
      // 说明后台确实有一轮在跑 —— 直接把“执行中”占位显示出来，
      // 不依赖上一轮轮询刚好赶上（例如刚打开面板就发送）。
      getAiRunStatus({ projectId, conversationId })
        .then(status => {
          if (status.running) {
            hadDetachedRunRef.current = true
            setResumingRun({ runId: status.runId })
          }
        })
        .catch(() => {})
    } finally {
      stopRef.current = null
      isLoadingRef.current = false
      setIsLoading(false)
      inputRef.current?.focus()
    }
  }, [
    input,
    pastedImages,
    isLoading,
    messages,
    t,
    chatMode,
    projectId,
    conversationId,
    refreshConversations,
    loadMessagesFromServer,
    view,
    docName,
    docId,
    busy,
    // FIXED: 2026-11-17 @ 文件列表参与请求体
    focusFiles,
  ])

  // FIXED: 2026-11-07 「停止」：中断本轮。后端会拆掉上游请求，且这一轮什么都不落库
  // FIXED: 2026-11-01 切页面不再中止后，“停止”必须显式告诉服务端（否则只断开本地 SSE，后台还在烧 token）
  const handleStop = useCallback(() => {
    const runId = runIdRef.current || undefined
    if (runId) stoppedRunIdsRef.current.set(runId, Date.now())
    // FIXED: 2026-11 先本地中止（SSE 立刻断），同时显式告诉服务端。
    // stopAiRun 现在会回报 ok/stopped/running；失败了至少控制台有痕迹。
    stopAiRun({ projectId, conversationId, runId }).catch(() => {})
    stopRef.current?.abort()
  }, [projectId, conversationId])

  // 停止「上一轮仍在跑」的后台任务（回来接上时用）
  const handleStopResumedRun = useCallback(() => {
    const runId = resumingRun?.runId
    // FIXED: 2026-11 占位必须**立刻**消失，不等请求回来：用户已经表达“停”，
    // 界面再显示 3 秒「仍在执行」就是“停不掉”的观感。
    if (runId) stoppedRunIdsRef.current.set(runId, Date.now())
    setResumingRun(null)
    hadDetachedRunRef.current = false
    // FIXED: 2026-11 停止之后这条流式占位必须跟着消失，
    // 否则输入框已经解锁，上面却还挂着一条“正在推理”的消息。
    setMessages(prev => prev.filter(m => !m.id.startsWith('resumed-')))
    stopAiRun({ projectId, conversationId, runId })
      .then(result => {
        if (!result.ok || result.running) {
          // 服务端没停成 / 还在跑：记一笔，但不再把占位弹回来，
          // 让用户能继续输入（下一轮由服务端 409 兜底提示）。
          console.warn('[CodeMirror AI Chat] stop did not settle run', result)
        }
      })
      .catch(() => {})
  }, [projectId, conversationId, resumingRun])

  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  // 恢复占位出现时把它滚进视野（否则用户只看到自己的提问，以为没在跑）
  useEffect(() => {
    if (resumingRun) {
      scrollToBottom()
    }
  }, [resumingRun, scrollToBottom])

  // FIXED: 2026-11-01 切走页面后 Agent 仍在后台跑：面板（重新）打开时把状态接上
  // FIXED: 2026-11 历史遗漏修复：以前这里只会显示「上一轮仍在后台执行中…」，
  // 跑到第几步、写了多少字一律看不到（演示时就是黑盒）。
  // 现在：先拿服务端快照（步骤 / 已生成正文 / 当前阶段），铺成一条“正在流式”的消息，
  // 再把这条连接挂到服务端那一轮上继续收增量；跑完自动换成服务端的最终消息。
  // 只有「接不上」（服务端进程重启 / 多副本没法命中）时才退回原来的 3s 轮询占位。
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let resumeAttempts = 0
    const controller = new AbortController()
    const resumedMessageIdRef = { current: '' as string }

    const patchResumed = (patch: Partial<Message>) => {
      const id = resumedMessageIdRef.current
      if (!id) return
      setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)))
    }

    const dropResumed = () => {
      const id = resumedMessageIdRef.current
      resumedMessageIdRef.current = ''
      if (!id) return
      setMessages(prev => prev.filter(m => m.id !== id))
    }

    const schedule = (ms: number) => {
      timer = window.setTimeout(poll, ms)
    }

    // 空转时的间隔：面板不可见就放慢，别给服务端添无谓的请求
    const nextPollDelay = () =>
      typeof document !== 'undefined' && document.hidden ? 15000 : 5000

    const poll = async () => {
      if (cancelled) return
      if (isLoadingRef.current) {
        // 本端正在跑，不需要轮询（自己就是那一轮）
        schedule(3000)
        return
      }
      const status = await getAiRunStatus({ projectId, conversationId })
      if (cancelled) return

      if (!status.running) {
        setResumingRun(null)
        if (hadDetachedRunRef.current) {
          hadDetachedRunRef.current = false
          const list = await loadMessagesFromServer()
          refreshConversations()
          if (cancelled) return
          // FIXED: 2026-11 这一轮结束了但历史里没有它的结论（被中断 / 服务重启 /
          // 落库失败）：以前是直接把占位删掉，用户看到的就是「回复区什么都没有」。
          // 现在留一句话说明，至少知道发生了什么，也知道可以重新发送。
          if (list && hasReplyAfterLastUser(list)) {
            dropResumed()
          } else {
            patchResumed({
              isLoading: false,
              statusText: undefined,
              content:
                '这一轮没有留下结果（可能被中断或服务重启了）。可以重新发送一次。',
            })
          }
        }
        // FIXED: 2026-11 这里以前直接 return，轮询就此死掉。
        // 于是「上一次发送被掐断时弹出来的横幅」再也没人复核，能挂一整天；
        // 而且这之后用户新起的一轮也不会被接上。现在保持低频空转。
        schedule(nextPollDelay())
        return
      }

      // FIXED: 2026-11 刚点过停止的 runId 不再弹回占位（见 stoppedRunIdsRef）
      const stoppedAt = status.runId
        ? stoppedRunIdsRef.current.get(status.runId)
        : undefined
      if (stoppedAt && Date.now() - stoppedAt < STOPPED_RUN_GRACE_MS) {
        schedule(3000)
        return
      }

      hadDetachedRunRef.current = true
      resumeAttempts += 1

      // 先按快照铺一条“正在执行”的消息（哪怕接不上下面的流，用户也立刻看到跑到哪了）
      if (!resumedMessageIdRef.current) {
        const id = `resumed-${Date.now()}`
        resumedMessageIdRef.current = id
        setMessages(prev => [
          ...prev,
          {
            id,
            role: 'assistant',
            content: '',
            isLoading: true,
            steps: Array.isArray(status.steps) ? status.steps : [],
            statusText: status.statusText || undefined,
          },
        ])
      }
      // FIXED: 2026-11 接上之后**不能**把 resumingRun 置空，
      // 否则输入框解锁、发送键变回纸飞机，而这一轮其实还在跑 ——
      // 就是「上面还在运行、下面能发、停不了」的那张截图。
      setResumingRun({
        runId: status.runId,
        stepCount: status.stepCount,
        currentStep: status.currentStep,
        statusText: status.statusText,
        elapsedMs: status.elapsedMs,
        textLength: status.textLength,
        attached: true,
      })

      let streamedText = ''
      let steps: AiChatStep[] = Array.isArray(status.steps) ? status.steps : []
      let sawTerminal = false

      try {
        const mode = await resumeAiRun(
          { projectId, conversationId },
          {
            onSnapshot: snapshot => {
              streamedText = snapshot.text || ''
              steps = snapshot.steps || []
              patchResumed({
                content: streamedText,
                steps: [...steps],
                statusText: snapshot.status || undefined,
                isLoading: true,
              })
              if (snapshot.terminal) sawTerminal = true
            },
            onStatus: text => patchResumed({ statusText: text }),
            onStep: step => {
              steps = upsertStep(steps, step)
              patchResumed({ steps: [...steps] })
            },
            onDelta: delta => {
              streamedText += delta
              patchResumed({ content: streamedText, statusText: undefined })
            },
            onDone: () => {
              sawTerminal = true
            },
            onError: () => {
              sawTerminal = true
            },
          },
          controller.signal
        )

        if (cancelled) return
        // 只认「收到终止事件」= 这一轮真的结束了。
        // FIXED: 2026-11 之前这里把「流断了」一律当成「跑完了」，于是
        // dropResumed() + 拉历史（历史里还没有这一轮）＝回复区空掉；
        // 而后台其实还在跑，用户一重发就撞上「上一轮仍在执行中」。
        if (sawTerminal && mode === 'streamed') {
          dropResumed()
          setResumingRun(null)
          await loadMessagesFromServer()
          refreshConversations()
          return
        }
        // 没拿到终止事件：这一轮可能还在跑（代理掐断 / 后台休眠 / 服务重启）。
        // 留着占位重连，绝不把已经显示出来的过程清掉。
        patchResumed({
          isLoading: true,
          statusText:
            mode === 'idle'
              ? '正在确认这一轮是否还在执行…'
              : '连接中断，正在重新接上…',
        })
        schedule(mode === 'idle' ? 1200 : resumeBackoff(resumeAttempts))
      } catch (err) {
        if (cancelled || isAbortError(err)) return
        // 接不上（代理掐断 / 进程重启）：留着占位，退回轮询重连
        console.warn(
          '[CodeMirror AI Chat] resume failed, fall back to polling',
          err
        )
        patchResumed({ isLoading: true, statusText: '正在等待这一轮结束…' })
        schedule(resumeBackoff(resumeAttempts))
      }
    }

    poll()
    return () => {
      cancelled = true
      controller.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [
    projectId,
    conversationId,
    loadMessagesFromServer,
    refreshConversations,
    resumeTick,
  ])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // FIXED: 2026-10-23 输入法选词/上屏候选时的 Enter 不发送，交还给输入法
      // OLD: if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
      if (isImeComposing(e, compositionEndedAtRef.current)) {
        return
      }
      // FIXED: 2026-11-17 @ 候选展开时，上下键/Enter/Tab 交给候选列表，
      // 否则 Enter 会直接把「@查询词」当消息发出去。
      // FIXED: 2026-11-18 `/` 候选同样接管方向键/Enter/Tab/Escape
      if (mcpMention && mcpCandidates.length > 0) {
        const count = mcpCandidates.length
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMcpIndex(i => (i + 1) % count)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMcpIndex(i => (i - 1 + count) % count)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          pickMcp(mcpCandidates[Math.min(mcpIndex, count - 1)])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setMcpMention(null)
          return
        }
      }
      if (mcpMention && e.key === 'Escape') {
        e.preventDefault()
        setMcpMention(null)
        return
      }
      if (mention && mentionCandidates.length > 0) {
        const count = mentionCandidates.length
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMentionIndex(i => (i + 1) % count)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMentionIndex(i => (i - 1 + count) % count)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          pickMention(mentionCandidates[Math.min(mentionIndex, count - 1)])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setMention(null)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [
      handleSend,
      mention,
      mentionCandidates,
      mentionIndex,
      pickMention,
      mcpMention,
      mcpCandidates,
      mcpIndex,
      pickMcp,
    ]
  )

  // 处理粘贴图片事件
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      if (pastedImages.length >= 4) {
        showSuccessToast('❌ 最多附带 4 张图片')
        return
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        // 检测是否为图片类型
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) {
            const reader = new FileReader()
            reader.onload = event => {
              const dataUrl = event.target?.result as string
              const imageName =
                file.name || `image_${Date.now()}.${file.type.split('/')[1]}`

              // FIXED: 2026-10-23 与后端限制保持一致，避免图片过大被静默丢弃
              if (dataUrl.length > 5 * 1024 * 1024) {
                showSuccessToast('❌ 图片过大，请压缩后再粘贴')
                return
              }

              // 添加图片到状态
              setPastedImages(prev =>
                prev.length >= 4
                  ? prev
                  : [...prev, { url: dataUrl, name: imageName }]
              )
              console.log('[CodeMirror AI Chat] Image pasted:', imageName)
            }
            reader.readAsDataURL(file)
          }
        }
      }
    },
    [pastedImages.length]
  )

  const handleRemoveImage = useCallback((index: number) => {
    setPastedImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  // 验证图片：大小（200KB）、尺寸（500x400）
  const validateAndAddImage = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        showSuccessToast(`❌ 仅支持图片文件`)
        return
      }

      // 检查文件大小（200KB = 204800 bytes）
      if (file.size > 200 * 1024) {
        showSuccessToast(`❌ 文件大小超过 200KB`)
        return
      }

      // 读取图片尺寸
      return new Promise<void>(resolve => {
        const reader = new FileReader()
        reader.onload = e => {
          const img = new Image()
          img.onload = () => {
            // 检查尺寸是否在 500x400 范围内
            if (img.width > 500 || img.height > 400) {
              showSuccessToast(
                `❌ 图片尺寸超过 500×400 (${img.width}×${img.height})`
              )
              resolve()
              return
            }

            // 验证通过，添加到 pastedImages
            const dataUrl = e.target?.result as string
            const imageName =
              file.name || `image_${Date.now()}.${file.type.split('/')[1]}`
            setPastedImages(prev => [
              ...prev,
              { url: dataUrl, name: imageName },
            ])
            showSuccessToast(`✅ 图片上传成功`)
            resolve()
          }
          img.onerror = () => {
            showSuccessToast(`❌ 无法读取图片`)
            resolve()
          }
          img.src = e.target?.result as string
        }
        reader.readAsDataURL(file)
      })
    },
    [t]
  )

  const handleClear = useCallback(async () => {
    setClearing(true)
    try {
      // FIXED: 2026-10-30 只清空当前会话
      await deleteJSON<any>(
        `${AI_CHAT_API_BASE}/messages?projectId=${encodeURIComponent(
          projectId
        )}&conversationId=${encodeURIComponent(conversationId)}`
      )
      console.log('[CodeMirror AI Chat] Messages cleared from server')
    } catch (err) {
      console.warn(
        '[CodeMirror AI Chat] Failed to clear messages from server:',
        err
      )
    }

    // FIXED: 2026-10-30 清空后换一段新会话 id。
    // 否则下一条消息的 upsert 会命中刚被逻辑删除的那份文档，等于"复活"了旧对话。
    const freshId = newConversationId()
    setConversationId(freshId)
    storeActiveConversationId(projectId, freshId)
    setMessages([])
    refreshConversations()
    inputRef.current?.focus()
    setClearing(false)
    setClearConfirmOpen(false)
  }, [projectId, conversationId, refreshConversations])

  // 删除单条消息
  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      // 如果已经在确认状态，直接删除；否则显示确认
      if (deleteConfirmId === messageId) {
        try {
          // 先等服务器删除成功
          // FIXED: 2026-10-30 带会话 id，避免删到别的会话里的同 id 消息
          await deleteJSON<any>(
            `${AI_CHAT_API_BASE}/messages/${encodeURIComponent(
              messageId
            )}?projectId=${encodeURIComponent(
              projectId
            )}&conversationId=${encodeURIComponent(conversationId)}`
          )
          console.log(
            '[CodeMirror AI Chat] Message deleted from server:',
            messageId
          )

          // 服务器成功后才更新本地状态
          setMessages(prev => prev.filter(m => m.id !== messageId))
        } catch (err) {
          console.error(
            '[CodeMirror AI Chat] Failed to delete message from server:',
            err
          )
        }

        setDeleteConfirmId(null)
      } else {
        // 显示确认状态
        setDeleteConfirmId(messageId)
        // 2秒后自动取消确认
        setTimeout(() => setDeleteConfirmId(null), 2000)
      }
    },
    [deleteConfirmId, projectId, conversationId]
  )

  // FIXED: 2026-10-30 新建对话：本地生成 id，第一次发消息时才真正建库
  const handleNewConversation = useCallback(() => {
    const id = newConversationId()
    setConversationId(id)
    storeActiveConversationId(projectId, id)
    setMessages([])
    setHistoryMenuOpen(false)
    inputRef.current?.focus()
  }, [projectId])

  // FIXED: 2026-10-30 载入某段历史对话
  const handleSelectConversation = useCallback(
    (id: string) => {
      setHistoryMenuOpen(false)
      if (id === conversationId) {
        return
      }
      setConversationId(id)
      storeActiveConversationId(projectId, id)
    },
    [conversationId, projectId]
  )

  // FIXED: 2026-10-30 删除对话：先弹确认框再删（不用 confirm()，也不用"点两下"）
  const openDeleteConversationConfirm = useCallback((id: string) => {
    setHistoryMenuOpen(false)
    setPendingDeleteConversationId(id)
  }, [])

  const confirmDeleteConversation = useCallback(async () => {
    const id = pendingDeleteConversationId
    if (!id) return

    setDeletingConversation(true)
    try {
      await deleteJSON<any>(
        `${AI_CHAT_API_BASE}/conversations/${encodeURIComponent(
          id
        )}?projectId=${encodeURIComponent(projectId)}`
      )
    } catch (err) {
      console.warn('[CodeMirror AI Chat] Failed to delete conversation:', err)
      showErrorToast(t('service_error'), 2600)
      setDeletingConversation(false)
      return
    }

    setDeletingConversation(false)
    setPendingDeleteConversationId(null)
    // 删掉的正是当前会话时，切到一段新的空对话
    if (id === conversationId) {
      const freshId = newConversationId()
      setConversationId(freshId)
      storeActiveConversationId(projectId, freshId)
      setMessages([])
    }
    refreshConversations()
  }, [
    pendingDeleteConversationId,
    projectId,
    conversationId,
    refreshConversations,
    t,
  ])

  // 重新发送：把消息内容填回输入框并聚焦
  const handleResendMessage = useCallback((message: Message) => {
    setInput(message.content)
    setPastedImages(message.images || [])
    inputRef.current?.focus()
  }, [])

  const handleCopy = useCallback(
    (text: string) => {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            showSuccessToast(t('copy') + ' ' + t('success'))
          })
          .catch(() => {
            copyToClipboardFallback(text)
          })
      } else {
        copyToClipboardFallback(text)
      }
    },
    [t]
  )

  const copyToClipboardFallback = (text: string) => {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      document.execCommand('copy')
      showSuccessToast(t('copy') + ' ' + t('success'))
    } catch (err) {
      console.error('Failed to copy:', err)
    }
    document.body.removeChild(textarea)
  }

  const activeConversationTitle = displayTitle(
    conversations.find(
      conversation => conversation.conversationId === conversationId
    )?.title || '',
    ''
  )

  return (
    <div className="ai-chat-panel">
      {/* FIXED: 2026-11-08 用户设置的是「右侧」，但右侧 PDF 区没展开，
          面板临时停靠到底部。这里说明一句，否则用户会以为设置失灵了；
          右侧一展开就自动回到右侧，设置本身没有被改动。 */}
      {temporaryBottomDock && (
        <div className="ai-chat-dock-notice">
          {t('ai_panel_temporary_bottom_hint', {
            defaultValue: '右侧预览未展开，AI 助手暂时停靠在底部',
          })}
        </div>
      )}
      <div className="ai-chat-header">
        <div className="ai-chat-title">
          <Icon type="comments" />
          {/* FIXED: 2026-11-01 移动端位置本来就紧，"AI 助手" 会折行 → 窄屏只留图标
              （样式见 ai-chat.less 的 max-width: @screen-xs-max 块） */}
          <span className="ai-chat-title-label">{t('ai_assistant')}</span>
          {/* FIXED: 2026-10-30 显示当前会话标题，新建/切换后不至于"不知道自己在哪段" */}
          {activeConversationTitle !== '' && (
            <span className="ai-chat-title-conversation">
              {activeConversationTitle}
            </span>
          )}
        </div>
        <div className="ai-chat-actions">
          {/* FIXED: 2026-10-30 新建对话 / 历史对话 */}
          <button
            className="btn btn-link"
            onClick={handleNewConversation}
            title={t('new_conversation')}
          >
            <Icon type="plus" />
          </button>
          <Dropdown
            id="ai-conversation-dropdown"
            pullRight
            open={historyMenuOpen}
            onToggle={(open: boolean) => {
              setHistoryMenuOpen(open)
              // 每次打开都重取一次，避免"新建之后列表没更新"这类过期数据
              if (open) refreshConversations()
            }}
            className="ai-conversation-dropdown"
          >
            <Dropdown.Toggle
              noCaret
              className="btn btn-link"
              title={t('conversation_history')}
              aria-label={t('conversation_history')}
            >
              <Icon type="history" />
            </Dropdown.Toggle>
            <Dropdown.Menu className="ai-conversation-menu">
              <li className="ai-conversation-menu-head">
                {t('conversation_history')}
              </li>
              {conversations.length === 0 && (
                <li className="ai-conversation-empty">
                  {t('no_conversation_history')}
                </li>
              )}
              {conversations.map(conversation => {
                const isActive = conversation.conversationId === conversationId
                return (
                  <li
                    key={conversation.conversationId}
                    className={`ai-conversation-item${
                      isActive ? ' active' : ''
                    }`}
                    onClick={() =>
                      handleSelectConversation(conversation.conversationId)
                    }
                  >
                    <div className="ai-conversation-item-body">
                      <div className="ai-conversation-item-title">
                        {displayTitle(
                          conversation.title,
                          t('untitled_conversation')
                        )}
                      </div>
                      <div className="ai-conversation-item-meta">
                        {t('conversation_message_count', {
                          n: conversation.messageCount,
                        })}
                      </div>
                    </div>
                    <button
                      className="btn btn-link ai-conversation-item-delete"
                      title={t('delete_conversation')}
                      aria-label={t('delete_conversation')}
                      onClick={event => {
                        event.stopPropagation()
                        openDeleteConversationConfirm(
                          conversation.conversationId
                        )
                      }}
                    >
                      <Icon type="trash" />
                    </button>
                  </li>
                )
              })}
            </Dropdown.Menu>
          </Dropdown>
          <button
            className="btn btn-link"
            onClick={() => setClearConfirmOpen(true)}
            title={t('clear')}
            disabled={messages.length === 0}
          >
            <Icon type="trash" />
          </button>
          <button className="btn btn-link" onClick={onClose} title={t('close')}>
            <Icon type="times" />
          </button>
        </div>
      </div>

      <div className="ai-chat-messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="ai-chat-welcome">
            <p>{t('ai_welcome')}</p>
            <ul>
              <li>{t('ai_help_1')}</li>
              <li>{t('ai_help_2')}</li>
              <li>{t('ai_help_3')}</li>
              <li>{t('ai_help_4')}</li>
            </ul>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`ai-message ai-message-${msg.role}`}>
            <div className="ai-message-avatar">
              {msg.role === 'user' ? (
                <Icon type="user" />
              ) : (
                // FIXED: 2026-10-16 fa-robot 在 FontAwesome 4.7 中不存在（原为空白），改用统一 AI 图标
                <AISparklesIcon size={15} />
              )}
            </div>
            <div className="ai-message-content">
              {msg.isLoading ? (
                <div className="ai-message-streaming">
                  {/* FIXED: 2026-11-07 运行中：工具步骤条 + 阶段文案 + 已生成的结论增量 */}
                  <AiSteps
                    steps={msg.steps || []}
                    running
                    statusText={msg.statusText}
                  />
                  {msg.content ? (
                    <MathJaxMarkdown
                      className="ai-message-markdown"
                      markdown={msg.content}
                    />
                  ) : (
                    <span className="ai-loading">
                      {msg.statusText || t('ai_thinking')}
                    </span>
                  )}
                  {/* FIXED: 2026-11-07 不再在消息下面放停止按钮：停止改到发送键位置（见输入区） */}
                </div>
              ) : msg.role === 'assistant' ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {/* FIXED: 2026-11-07 用户主动停止：明确告知，且这一轮不进历史 */}
                  {msg.stopped && (
                    <div className="ai-message-stopped">用户停止任务</div>
                  )}

                  {/* FIXED: 2026-11-07 执行过的工具步骤：收起成一行很淡的痕迹，可展开 */}
                  {!msg.stopped && msg.steps && msg.steps.length > 0 && (
                    <AiSteps steps={msg.steps} running={false} />
                  )}
                  {/* 执行过程信息（可折叠）*/}
                  {msg.processMarkdown && (
                    <div
                      style={{
                        marginBottom: '8px',
                        borderLeft: '3px solid #f0ad4e',
                        paddingLeft: '8px',
                        backgroundColor: '#fffbf0',
                        borderRadius: '4px',
                        padding: '8px 12px',
                      }}
                    >
                      <div
                        onClick={() => {
                          setMessages(prev =>
                            prev.map(m =>
                              m.id === msg.id
                                ? { ...m, showProcess: !m.showProcess }
                                : m
                            )
                          )
                        }}
                        style={{
                          cursor: 'pointer',
                          fontWeight: 'bold',
                          fontSize: '12px',
                          color: '#856404',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                      >
                        <span>{msg.showProcess ? '▼' : '▶'}</span>
                        <span>🔄 {t('execution_trace') || '执行过程'}</span>
                      </div>
                      {msg.showProcess && (
                        <MathJaxMarkdown
                          className="ai-message-markdown"
                          style={{
                            marginTop: '8px',
                            fontSize: '11px',
                            color: '#666',
                            maxHeight: '200px',
                            overflowY: 'auto',
                            paddingRight: '4px',
                          }}
                          markdown={msg.processMarkdown}
                        />
                      )}
                    </div>
                  )}

                  {/* 主体内容 */}
                  <MathJaxMarkdown
                    className="ai-message-markdown"
                    markdown={msg.content}
                  />
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignSelf: 'flex-end',
                      gap: '4px',
                      marginTop: '8px',
                    }}
                  >
                    {msg.model && msg.totalTokens ? (
                      <div
                        style={{
                          fontSize: '11px',
                          color: '#999',
                          textAlign: 'right',
                          lineHeight: '1.4',
                        }}
                      >
                        <div>
                          <strong>{formatModelName(msg.model)}</strong>
                        </div>
                        <div>
                          {t('Tokens')}: {msg.totalTokens}{' '}
                          <span style={{ color: '#bbb' }}>
                            (↓{msg.inputTokens} ↑{msg.outputTokens})
                          </span>
                        </div>
                      </div>
                    ) : null}
                    <div
                      className="ai-msg-meta"
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignSelf: 'flex-end',
                      }}
                    >
                      {/* FIXED: 2026-11-17 时间戳放在功能按钮前面（含本轮用时） */}
                      <AiMessageTime
                        createdAt={msg.createdAt}
                        elapsedMs={elapsedByMessageId[msg.id]}
                      />
                      <button
                        onClick={() => handleCopy(msg.content)}
                        title={t('copy')}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '4px 8px',
                          color: '#666',
                          fontSize: '12px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                        onMouseEnter={e =>
                          (e.currentTarget.style.opacity = '0.7')
                        }
                        onMouseLeave={e =>
                          (e.currentTarget.style.opacity = '1')
                        }
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                          <rect x="8" y="2" width="8" height="4" rx="1" />
                        </svg>
                        {t('copy')}
                      </button>
                      <button
                        onClick={() => handleDeleteMessage(msg.id)}
                        title={deleteConfirmId === msg.id ? '确认删除' : '删除'}
                        style={{
                          background:
                            deleteConfirmId === msg.id ? '#ff4d4f' : 'none',
                          border:
                            deleteConfirmId === msg.id
                              ? '1px solid #ff4d4f'
                              : 'none',
                          cursor: 'pointer',
                          padding: '4px 8px',
                          color:
                            deleteConfirmId === msg.id ? '#fff' : '#ff4d4f',
                          fontSize: '12px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          borderRadius: '4px',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={e =>
                          (e.currentTarget.style.opacity = '0.7')
                        }
                        onMouseLeave={e =>
                          (e.currentTarget.style.opacity = '1')
                        }
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        </svg>
                        {deleteConfirmId === msg.id ? '确认' : '删除'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  {/* FIXED: 2026-10-16 长内容默认折叠，可展开/收起 */}
                  {isLongContent(msg.content) ? (
                    <>
                      <div
                        className={
                          'ai-collapsible' +
                          (msg.isExpanded ? '' : ' is-collapsed')
                        }
                      >
                        <PlainTextBlocks text={msg.content} />
                      </div>
                      <button
                        type="button"
                        className="ai-collapse-toggle"
                        onClick={() =>
                          setMessages(prev =>
                            prev.map(m =>
                              m.id === msg.id
                                ? { ...m, isExpanded: !m.isExpanded }
                                : m
                            )
                          )
                        }
                      >
                        {msg.isExpanded
                          ? '▲ 收起'
                          : `▼ 展开全部（${msg.content.length} 字）`}
                      </button>
                    </>
                  ) : (
                    <PlainTextBlocks text={msg.content} />
                  )}
                  {/* 用户消息中的图片显示 */}
                  {msg.images && msg.images.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        flexWrap: 'wrap',
                      }}
                    >
                      {msg.images.map((img, index) => (
                        <div
                          key={index}
                          onClick={() => setSelectedImage(img)}
                          style={{
                            borderRadius: '4px',
                            overflow: 'hidden',
                            border: '1px solid #ddd',
                            maxWidth: '200px',
                            backgroundColor: '#f5f5f5',
                            cursor: 'pointer',
                            transition: 'transform 0.2s, box-shadow 0.2s',
                          }}
                          onMouseEnter={e => {
                            ;(e.currentTarget as HTMLElement).style.transform =
                              'scale(1.05)'
                            ;(e.currentTarget as HTMLElement).style.boxShadow =
                              '0 2px 8px rgba(0,0,0,0.15)'
                          }}
                          onMouseLeave={e => {
                            ;(e.currentTarget as HTMLElement).style.transform =
                              'scale(1)'
                            ;(e.currentTarget as HTMLElement).style.boxShadow =
                              'none'
                          }}
                        >
                          <img
                            src={img.url}
                            alt={img.name}
                            style={{
                              maxWidth: '100%',
                              maxHeight: '200px',
                              display: 'block',
                            }}
                            title={`${img.name} (click to view)`}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 用户消息的操作按钮 */}
                  <div
                    className="ai-msg-meta"
                    style={{
                      display: 'flex',
                      gap: '8px',
                      alignSelf: 'flex-end',
                      marginTop: '4px',
                    }}
                  >
                    {/* FIXED: 2026-11-17 提问也有时间戳（回复的用时就是拿它算的） */}
                    <AiMessageTime createdAt={msg.createdAt} />
                    <button
                      onClick={() => handleResendMessage(msg)}
                      title="重新发送"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '4px 8px',
                        color: '#666',
                        fontSize: '12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                      onMouseEnter={e =>
                        (e.currentTarget.style.opacity = '0.7')
                      }
                      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M23 4v6h-6" />
                        <path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                      重新发送
                    </button>
                    <button
                      onClick={() => handleDeleteMessage(msg.id)}
                      title={deleteConfirmId === msg.id ? '确认删除' : '删除'}
                      style={{
                        background:
                          deleteConfirmId === msg.id ? '#ff4d4f' : 'none',
                        border:
                          deleteConfirmId === msg.id
                            ? '1px solid #ff4d4f'
                            : 'none',
                        cursor: 'pointer',
                        padding: '4px 8px',
                        color: deleteConfirmId === msg.id ? '#fff' : '#ff4d4f',
                        fontSize: '12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        borderRadius: '4px',
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={e =>
                        (e.currentTarget.style.opacity = '0.7')
                      }
                      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                      {deleteConfirmId === msg.id ? '确认' : '删除'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {/* FIXED: 2026-11-01 切走页面后 Agent 仍在后台跑：
            在消息末尾补一个「回复中」占位气泡（而不是顶部横幅 —— 消息多了会被滚出视野，
            用户只会觉得“没有回复”）。跑完这里消失，服务端的结论自动出现。 */}
        {/* FIXED: 2026-11 接上 live 流之后不再叠加这条横幅（进度由那条流式消息自己显示），
            但 resumingRun 仍然保留着 —— 它同时管着输入框禁用和「停止」按钮 */}
        {resumingRun && !resumedActive && (
          <div className="ai-message ai-message-assistant">
            <div className="ai-message-avatar">
              <AISparklesIcon size={15} />
            </div>
            <div className="ai-message-content">
              <div className="ai-message-streaming">
                <span className="ai-loading">
                  {t('ai_run_resuming', {
                    defaultValue:
                      '上一轮 Agent 仍在后台执行中…（可以关掉页面，跑完会自动出现在这里）',
                  })}
                  {/* FIXED: 2026-11 兜底占位也要能答「跑到哪了」：步数 / 当前步骤 / 时长 / 已生成字数 */}
                  {typeof resumingRun.stepCount === 'number' && (
                    <span className="ai-resume-progress">
                      {' '}
                      · 第 {resumingRun.stepCount} 步
                      {resumingRun.currentStep
                        ? `（${resumingRun.currentStep}）`
                        : ''}
                      {typeof resumingRun.elapsedMs === 'number'
                        ? ` · 已运行 ${Math.max(
                            1,
                            Math.round(resumingRun.elapsedMs / 1000)
                          )} 秒`
                        : ''}
                      {typeof resumingRun.textLength === 'number' &&
                      resumingRun.textLength > 0
                        ? ` · 已生成 ${resumingRun.textLength} 字`
                        : ''}
                    </span>
                  )}
                </span>
                <button
                  className="btn btn-link ai-resume-stop"
                  onClick={handleStopResumedRun}
                >
                  停止
                </button>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-chat-input">
        {/* 模式切换：Ask（只读咨询）/ Agent（完全操作） */}
        {/* FIXED: 2026-11-15 包一层 wrapper，移动端独占一行、字号调小（见 ai-chat.less） */}
        <div className="ai-chat-mode-row">
          <select
            className="ai-chat-mode-select"
            value={chatMode}
            onChange={e => {
              const mode = e.target.value as ChatMode
              setChatMode(mode)
              // FIXED: 2026-10-29 记住到本项目
              storeChatMode(currentProjectId(), mode)
            }}
            disabled={busy}
            style={{
              padding: '8px 12px',
              border: '1px solid var(--fl-border, #ddd)',
              borderRadius: '4px',
              backgroundColor: 'var(--fl-surface, #fff)',
              color: 'var(--fl-text, #333)',
              fontSize: '13px',
              cursor: busy ? 'not-allowed' : 'pointer',
              marginRight: '8px',
              minWidth: '120px',
              maxWidth: '120px',
            }}
          >
            <option value="ask">{t('ask_mode')}</option>
            <option value="agent">{t('agent_mode')}</option>
          </select>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {/* FIXED: 2026-11-02 有选区时提示「会随消息一起发给 AI」，
              否则用户不知道 Agent 为什么能“看到”选中内容 */}
          {selectionHint && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                alignSelf: 'flex-start',
                maxWidth: '100%',
                padding: '3px 8px',
                borderRadius: '999px',
                fontSize: '12px',
                lineHeight: 1.4,
                backgroundColor: 'var(--fl-surface-raised, #f5f5f5)',
                border: '1px solid var(--fl-border, #ddd)',
                color: 'var(--fl-text-muted, #555)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              <i className="fa fa-i-cursor" aria-hidden="true" />
              {t('ai_selection_attached', {
                lines: selectionHint.lines,
                chars: selectionHint.chars,
              })}
            </div>
          )}
          {/* 粘贴图片预览 */}
          {pastedImages.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                flexWrap: 'wrap',
                padding: '8px',
                backgroundColor: '#f5f5f5',
                borderRadius: '4px',
                border: '1px solid #e0e0e0',
              }}
            >
              {pastedImages.map((img, index) => (
                <div
                  key={index}
                  style={{
                    position: 'relative',
                    width: '60px',
                    height: '60px',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    border: '1px solid #ddd',
                    backgroundColor: '#fff',
                  }}
                >
                  <img
                    src={img.url}
                    alt={img.name}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveImage(index)}
                    style={{
                      position: 'absolute',
                      top: '-4px',
                      right: '-4px',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      backgroundColor: '#ff4d4f',
                      border: 'none',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                    title={`Remove ${img.name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* FIXED: 2026-11-17 @ 指定的文件（chip）：点 ✕ 同时清掉文本里的 @路径 */}
          {focusFiles.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                alignSelf: 'flex-start',
                maxWidth: '100%',
              }}
            >
              {focusFiles.map(file => (
                <span
                  key={file.path}
                  title={`本轮只关注：${file.path}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    maxWidth: '100%',
                    padding: '2px 4px 2px 8px',
                    borderRadius: '999px',
                    fontSize: '12px',
                    lineHeight: 1.5,
                    backgroundColor: 'var(--fl-surface-raised, #f5f5f5)',
                    border: '1px solid var(--fl-border, #ddd)',
                    color: 'var(--fl-text, #333)',
                  }}
                >
                  <i
                    className="fa fa-file-text-o"
                    aria-hidden="true"
                    style={{ opacity: 0.7 }}
                  />
                  <span
                    style={{
                      maxWidth: '180px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {file.name}
                  </span>
                  {/* FIXED: 2026-11-18 上传文件(fileRef) 标一下：Agent 首次访问会把它转成可编辑文档 */}
                  {file.source === 'file' && (
                    <span
                      style={{
                        fontSize: '10px',
                        padding: '0 4px',
                        borderRadius: '3px',
                        backgroundColor: 'var(--fl-surface, #fff)',
                        border: '1px solid var(--fl-border, #ddd)',
                        color: 'var(--fl-text-muted, #666)',
                        whiteSpace: 'nowrap',
                      }}
                      title="这是上传的文件，Agent 首次读取时会自动转成可编辑文档"
                    >
                      上传文件
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`移除 ${file.path}`}
                    title={`移除 ${file.path}`}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => removeFocusFile(file.path)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '16px',
                      height: '16px',
                      padding: 0,
                      border: 'none',
                      borderRadius: '50%',
                      background: 'transparent',
                      color: 'inherit',
                      opacity: 0.6,
                      cursor: 'pointer',
                      fontSize: '11px',
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* FIXED: 2026-11-18 `/` 指定的 MCP 服务（chip）：点 ✕ 同时清掉文本里的 /服务名 */}
          {focusMcp && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                alignSelf: 'flex-start',
                maxWidth: '100%',
              }}
            >
              <span
                title={`本轮只用这个 MCP 服务：${focusMcp.name}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  maxWidth: '100%',
                  padding: '2px 4px 2px 8px',
                  borderRadius: '999px',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  backgroundColor: 'var(--fl-surface-raised, #f5f5f5)',
                  border: '1px solid var(--fl-border, #ddd)',
                  color: 'var(--fl-text, #333)',
                }}
              >
                <i
                  className="fa fa-plug"
                  aria-hidden="true"
                  style={{ opacity: 0.7 }}
                />
                <span
                  style={{
                    maxWidth: '180px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {focusMcp.name}
                </span>
                <button
                  type="button"
                  aria-label={`取消指定 ${focusMcp.name}`}
                  title="取消指定（恢复在所有 MCP 里自动选择）"
                  onMouseDown={event => event.preventDefault()}
                  onClick={removeFocusMcp}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '16px',
                    height: '16px',
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: '11px',
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          )}

          {/* FIXED: 2026-11-17 输入 @ 后的候选列表：↑↓ 选择，Enter/Tab 确认，Esc 关闭
              （键盘处理见 handleKeyDown；这里用 mousedown preventDefault 保住选区焦点） */}
          {mention && (
            <div
              role="listbox"
              aria-label="选择要指定给 AI 的文件"
              style={{
                border: '1px solid var(--fl-border, #ddd)',
                borderRadius: '4px',
                backgroundColor: 'var(--fl-surface, #fff)',
                overflow: 'hidden',
              }}
            >
              {mentionCandidates.length === 0 ? (
                <div
                  style={{
                    padding: '6px 10px',
                    fontSize: '12px',
                    color: 'var(--fl-text-muted, #666)',
                  }}
                >
                  没有匹配的文件（只列 .tex / .sty / .bib / .md 等文本源文件）
                </div>
              ) : (
                <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                  {mentionCandidates.map((file, index) => (
                    <button
                      key={file.path}
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      onMouseDown={event => event.preventDefault()}
                      onMouseEnter={() => setMentionIndex(index)}
                      onClick={() => pickMention(file)}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: '8px',
                        width: '100%',
                        padding: '6px 10px',
                        border: 'none',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontSize: '12px',
                        lineHeight: 1.5,
                        color: 'var(--fl-text, #333)',
                        backgroundColor:
                          index === mentionIndex
                            ? 'var(--fl-surface-raised, #f5f5f5)'
                            : 'transparent',
                      }}
                    >
                      <i
                        className="fa fa-file-text-o"
                        aria-hidden="true"
                        style={{ opacity: 0.7 }}
                      />
                      <span style={{ whiteSpace: 'nowrap' }}>{file.name}</span>
                      <span
                        style={{
                          opacity: 0.55,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {file.path}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* FIXED: 2026-11-18 输入 `/` 后的 MCP 服务候选：只列有效（启用中）的服务。
              没有可用服务时整块不渲染（需求：没有就不管）。 */}
          {mcpMention && mcpCandidates.length > 0 && (
            <div
              role="listbox"
              aria-label="选择本轮使用的 MCP 服务"
              style={{
                border: '1px solid var(--fl-border, #ddd)',
                borderRadius: '4px',
                backgroundColor: 'var(--fl-surface, #fff)',
                overflow: 'hidden',
              }}
            >
              <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                {mcpCandidates.map((server, index) => (
                  <button
                    key={server.id || server.name}
                    type="button"
                    role="option"
                    aria-selected={index === mcpIndex}
                    onMouseDown={event => event.preventDefault()}
                    onMouseEnter={() => setMcpIndex(index)}
                    onClick={() => pickMcp(server)}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: '8px',
                      width: '100%',
                      padding: '6px 10px',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '12px',
                      background:
                        index === mcpIndex
                          ? 'var(--fl-surface-raised, #f5f5f5)'
                          : 'transparent',
                    }}
                  >
                    <i
                      className="fa fa-plug"
                      aria-hidden="true"
                      style={{ opacity: 0.7 }}
                    />
                    <span style={{ whiteSpace: 'nowrap' }}>{server.name}</span>
                    <span style={{ opacity: 0.55, fontSize: '11px' }}>
                      MCP 服务
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: '4px',
              borderRadius: '4px',
              border: '1px solid #ddd',
              overflow: 'hidden',
            }}
          >
            {/* 📎 附件按钮 - 使用 SVG 图标 */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title="上传图片"
              style={{
                backgroundColor: '#f5f5f5',
                border: 'none',
                padding: '8px 10px',
                cursor: busy ? 'not-allowed' : 'pointer',
                color: '#666',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={e =>
                !busy && (e.currentTarget.style.backgroundColor = '#e8e8e8')
              }
              onMouseLeave={e =>
                (e.currentTarget.style.backgroundColor = '#f5f5f5')
              }
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            {/* 隐藏的文件输入 */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => {
                if (e.target.files?.[0]) {
                  validateAndAddImage(e.target.files[0])
                  e.target.value = '' // 重置
                }
              }}
            />
            {/* Textarea */}
            {/* FIXED: 2026-11 统一 class，窄视图里 placeholder 只允许单行（见 ai-chat.less） */}
            <textarea
              className="fl-ai-chat-textarea"
              ref={inputRef}
              value={input}
              // FIXED: 2026-11-17 一边输入一边判断「光标前是不是 @查询词」
              onChange={e => {
                const value = e.target.value
                setInput(value)
                syncMention(value, e.target.selectionStart)
              }}
              // 点击/方向键移动光标后，若落在已有 @词 里也要能重新弹出候选
              onClick={e =>
                syncMention(e.currentTarget.value, e.currentTarget.selectionStart)
              }
              onKeyUp={e => {
                const navigationKeys = [
                  'ArrowDown',
                  'ArrowUp',
                  'Enter',
                  'Tab',
                  'Escape',
                ]
                if (navigationKeys.includes(e.key)) return
                syncMention(e.currentTarget.value, e.currentTarget.selectionStart)
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionEnd={() => {
                // FIXED: 2026-10-23 记录组合输入结束时刻，供 Enter 判定使用
                compositionEndedAtRef.current = Date.now()
              }}
              placeholder={
                (chatMode === 'ask'
                  ? t('ask_input_placeholder')
                  : t('agent_input_placeholder')) +
                '  ' +
                t('ai_mention_hint', { defaultValue: '@ 可指定文件' })
              }
              rows={1}
              disabled={busy}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                padding: '8px',
                resize: 'none',
                borderRadius: 0,
              }}
            />
          </div>
        </div>
        {/* FIXED: 2026-11-07 发送/停止同位置切换（参考 flylatex-agent）：
            跑的时候这个键变成停止，不再在下面另给一个“停止”按钮 */}
        {busy ? (
          <button
            className="btn btn-danger"
            // FIXED: 2026-11 本端发的走 handleStop，切回来接上的后台那一轮走
            // handleStopResumedRun（它带的是服务端那个 runId）
            onClick={isLoading ? handleStop : handleStopResumedRun}
            title="停止"
            aria-label="停止"
          >
            <Icon type="stop" />
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={!input.trim() && pastedImages.length === 0}
          >
            <Icon type="paper-plane" />
          </button>
        )}
      </div>

      {/* 图片查看大图 Modal */}
      {selectedImage &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10000,
            }}
            onClick={() => setSelectedImage(null)}
          >
            <div
              style={{
                position: 'relative',
                backgroundColor: '#fff',
                borderRadius: '8px',
                padding: '16px',
                maxWidth: '90vw',
                maxHeight: '90vh',
                overflow: 'auto',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
              }}
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setSelectedImage(null)}
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '8px',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  backgroundColor: '#f5f5f5',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#333',
                  transition: 'background-color 0.2s',
                }}
                onMouseEnter={e =>
                  (e.currentTarget.style.backgroundColor = '#e0e0e0')
                }
                onMouseLeave={e =>
                  (e.currentTarget.style.backgroundColor = '#f5f5f5')
                }
                title="Close"
              >
                ✕
              </button>
              <img
                src={selectedImage.url}
                alt={selectedImage.name}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  display: 'block',
                  borderRadius: '4px',
                }}
              />
              <div
                style={{
                  marginTop: '12px',
                  fontSize: '13px',
                  color: '#666',
                  textAlign: 'center',
                }}
              >
                {selectedImage.name}
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* FIXED: 2026-10-30 删除对话前先确认 */}
      <AccessibleModal
        show={pendingDeleteConversationId != null}
        onHide={() => setPendingDeleteConversationId(null)}
        className="ai-delete-conversation-modal"
        // FIXED: 2026-11-17 面板浮层是 z-index:10000，bootstrap 默认遮罩(1040)会被盖住，
        // 给它单独一个类，在 ai-chat.less 里抬到 20000（见那里的说明）。
        backdropClassName="ai-chat-confirm-backdrop"
      >
        <Modal.Header closeButton>
          <Modal.Title>{t('delete_conversation')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {pendingDeleteConversationId != null && (
            <p className="ai-delete-conversation-name">
              {displayTitle(
                conversations.find(
                  conversation =>
                    conversation.conversationId === pendingDeleteConversationId
                )?.title || '',
                t('untitled_conversation')
              )}
            </p>
          )}
          <p>{t('delete_conversation_confirm')}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button
            onClick={() => setPendingDeleteConversationId(null)}
            disabled={deletingConversation}
          >
            {t('cancel')}
          </Button>
          <Button
            bsStyle="primary"
            onClick={confirmDeleteConversation}
            disabled={deletingConversation}
          >
            {deletingConversation ? t('deleting') : t('delete')}
          </Button>
        </Modal.Footer>
      </AccessibleModal>

      {/* FIXED: 2026-10-30 清除当前对话前先确认，和"删除对话"保持一致 */}
      <AccessibleModal
        show={clearConfirmOpen}
        onHide={() => {
          if (!clearing) setClearConfirmOpen(false)
        }}
        className="ai-clear-conversation-modal"
        // FIXED: 2026-11-17 面板浮层是 z-index:10000，bootstrap 默认遮罩(1040)会被盖住，
        // 给它单独一个类，在 ai-chat.less 里抬到 20000（见那里的说明）。
        backdropClassName="ai-chat-confirm-backdrop"
      >
        <Modal.Header closeButton>
          <Modal.Title>{t('clear')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>{t('clear_conversation_confirm')}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button
            onClick={() => setClearConfirmOpen(false)}
            disabled={clearing}
          >
            {t('cancel')}
          </Button>
          <Button bsStyle="primary" onClick={handleClear} disabled={clearing}>
            {clearing ? t('clearing') : t('clear')}
          </Button>
        </Modal.Footer>
      </AccessibleModal>
    </div>
  )
}

// FIXED: 2026-11-01 移动端判定（与 Bootstrap xs 断点一致，和 ide.js / mobile-pdf-only.less 同一口径）。
// 只用于「面板要不要占满全屏 / 编译完要不要自动收起」，不参与任何业务逻辑。
function isMobileViewport() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px)').matches
  )
}

// FIXED: 2026-11-01 Agent 改过文件后的收尾动作：重载当前文档 → 触发一次编译。
// 全部复用已有入口，不新增第二套编译实现：
//   1) window._ide.editorManager.reloadCurrentDocument()（ai-chat-panel / 工具栏 AI 用的同一个）
//   2) window.dispatchEvent(new Event('pdf:recompile'))
//      —— Ctrl+S 走的就是它（use-compile-triggers → startCompile → compiler.compile），
//         编译完 pdfUrl 一变，PDF 预览自己刷新，不需要额外通知视图。
// 顺序不能反：compile() 开头会 dispatch 'flush-changes'，
// 若编辑器里还留着 Agent 修改前的旧缓冲区，可能把刚写好的内容又推回服务端覆盖掉。
function reloadCurrentDocumentAndRecompile() {
  try {
    const editorManager = (window as any)._ide?.editorManager
    if (
      editorManager &&
      typeof editorManager.reloadCurrentDocument === 'function'
    ) {
      editorManager.reloadCurrentDocument()
    } else {
      debugConsole.warn(
        '[CodeMirror AI Chat] editorManager.reloadCurrentDocument not available'
      )
    }
  } catch (e) {
    // 重载失败不阻断编译：编译是服务端按 MongoDB 里的内容跑的
    debugConsole.warn('[CodeMirror AI Chat] reloadCurrentDocument failed', e)
  }

  try {
    window.dispatchEvent(new Event('pdf:recompile'))
  } catch (e) {
    debugConsole.warn('[CodeMirror AI Chat] pdf:recompile dispatch failed', e)
  }
}

// 预创建容器元素，确保它在渲染前存在
function CodeMirrorAIChat() {
  const view = useCodeMirrorViewContext()
  const [isOpen, setIsOpen] = useState(false)
  // FIXED: 2026-10-30 AI 面板展示位置：side（右侧，默认）/ bottom（底部停靠，横跨编辑器+预览）
  const [panelLayout, setPanelLayout] = useState<AIPanelLayout>(
    () => (getMeta('ol-aiPanelLayout') as AIPanelLayout) || 'side'
  )
  const [containerReady, setContainerReady] = useState(false)

  // FIXED: 2026-11-01 移动端（<= 767px）面板落点：body 上的全屏浮层。
  // 手机上是 PDF 单栏只读模式，右侧 PDF 区不存在、jquery-layout 的 south 面板也不可见，
  // 侧边 / 底部两个落点都用不了（以前会挂进 0 高度容器，表现就是「点了没反应」）。
  // 用响应式状态而不是「打开时判断一次」：旋转屏幕、桌面端拖窄窗口都能跟着切。
  const [mobileViewport, setMobileViewport] = useState(() => isMobileViewport())
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia('(max-width: 767px)')
    const onChange = () => setMobileViewport(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // FIXED: 2026-11-08 解决「设置右侧、但右侧没展开」的悖论。
  //
  // 右侧到底开没开，IDE 里有权威状态，不该去量 DOM：
  //   ui.pdfOpen   —— 右侧 PDF 区是否展开（editor.pug 上 open-east 绑的就是它）
  //   ui.pdfLayout —— 'sideBySide' | 'flat'，开关右侧时由 ide.js 双向同步
  //   ui.view      —— 'editor' | 'file' 才看得见编辑器布局（PDF 全屏/历史时不显示）
  // 这三个值都是 Angular scope 值，用 useScopeValue 读，变化会自动触发重渲染。
  // 只有当这套页面没有这些状态（例如 React 版 IDE）时，才退回 DOM 度量。
  const [pdfOpen] = useScopeValue<boolean | null>('ui.pdfOpen')
  const [pdfLayout] = useScopeValue<string | null>('ui.pdfLayout')
  const [uiView] = useScopeValue<string | null>('ui.view')

  const sideDockByState = resolveSideDockFromState({
    pdfOpen,
    pdfLayout,
    view: uiView,
  })

  // 状态拿不到时才用几何度量兜底，并监听布局变化
  const [layoutEpoch, setLayoutEpoch] = useState(0)
  const needsDomFallback = sideDockByState === null

  useEffect(() => {
    if (!isOpen || !needsDomFallback) {
      return
    }

    let timer: number | undefined
    const debounced = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setLayoutEpoch(epoch => epoch + 1), 120)
    }

    const eastPanes = Array.from(
      document.querySelectorAll('.ui-layout-east')
    ) as HTMLElement[]
    const resizeObserver =
      eastPanes.length > 0 ? new ResizeObserver(debounced) : null
    eastPanes.forEach(pane => resizeObserver!.observe(pane))

    const mutationObserver = new MutationObserver(debounced)
    for (const host of [
      document.querySelector('[layout="pdf"]'),
      document.querySelector('#ide-body'),
    ]) {
      if (host) {
        mutationObserver.observe(host, {
          childList: true,
          subtree: false,
          attributes: true,
          attributeFilter: ['class', 'style'],
        })
      }
    }

    return () => {
      window.clearTimeout(timer)
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
    }
  }, [isOpen, needsDomFallback, panelLayout])

  // 仅用于 DOM 兜底路径触发重渲染
  void layoutEpoch

  // 右侧此刻能不能挂面板
  const sideDockAvailable = sideDockByState ?? isSideDockAvailableByDom()

  // FIXED: 2026-11-08 ui.pdfOpen 刚翻成 true 的那一帧，jquery-layout 还没把宽度
  // 写到 .ui-layout-east 上。此时往 body 兜底会让面板「先闪到右边浮层再跳回来」。
  // 状态明确说右侧可用时，最多等 20 帧（约 300ms）让布局落定。
  const [mountRetry, setMountRetry] = useState(0)

  // 实际落点：用户设 bottom 就 bottom；设 side 且右侧可用 → side；
  // 设 side 但右侧此刻不可用、而底部容器存在 → 临时 bottom
  // FIXED: 2026-11-01 移动端固定为 'side' 占位 —— 真正的挂载由下面的
  // mobileViewport 分支接管（body 全屏浮层）。这里给 'side' 是为了不去打开
  // 看不见的 south 面板（fl:ai-dock 事件只认 bottom）。
  // FIXED: 2026-11-13 弹窗模式也要按 'side' 占位：modal 挂到 body，
  // 不能顺手把 jquery-layout 的 south 面板打开。
  // OLD: const dockLayout = mobileViewport ? 'side' : panelLayout === 'bottom' ? ...
  const dockLayout: AIPanelLayout =
    mobileViewport || panelLayout === 'modal'
      ? 'side'
      : panelLayout === 'bottom'
      ? 'bottom'
      : sideDockAvailable || !isBottomDockAvailable()
      ? 'side'
      : 'bottom'

  const [width, setWidth] = useState(() => {
    // 从 localStorage 读取保存的宽度，默认 400px
    const saved = localStorage.getItem('flylatex-ai-chat-width')
    return saved ? parseInt(saved, 10) : 400
  })

  // 使用 ref 存储容器和 ResizeObserver
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pdfPanelRef = useRef<HTMLElement | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  // 监听 toggle 事件
  useEffect(() => {
    const handleToggleAIChat = () => {
      setIsOpen(prev => !prev)
    }

    window.addEventListener('editor:toggle-ai-chat', handleToggleAIChat)

    return () => {
      window.removeEventListener('editor:toggle-ai-chat', handleToggleAIChat)
    }
  }, [])

  // FIXED: 2026-10-16 广播面板的实际开闭状态，供工具栏图标保持同步
  // 背景：工具栏与面板此前各持一份 isOpen，只靠 toggle 事件通信；在面板内点 ✕ 关闭后
  //       工具栏不知道，图标仍显示为「开启」→ 下一次点击语义相反。
  //       这里以「面板实际状态」为唯一事实来源向外广播（含 IDE 菜单栏、外部关闭等所有入口）。
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('editor:ai-chat-state', { detail: { open: isOpen } })
    )
  }, [isOpen])

  // FIXED: 2026-10-30 设置里切换「侧边 / 底部停靠」时即时生效
  useEffect(() => {
    const handleLayoutChange = (event: Event) => {
      const next = (event as CustomEvent).detail
      // FIXED: 2026-11-13 新增 'modal'
      if (next === 'side' || next === 'bottom' || next === 'modal') {
        setPanelLayout(next)
      }
    }
    document.addEventListener('fl:ai-panel-layout', handleLayoutChange)
    return () => {
      document.removeEventListener('fl:ai-panel-layout', handleLayoutChange)
    }
  }, [])

  // FIXED: 2026-10-30 底部停靠由 jquery-layout 的 south 面板实现。
  // 这个 effect 必须排在"建容器"的 layout effect 之前：先让 south 面板有高度，
  // 再把 React 容器挂进去，否则第一帧会挂到一个 0 高度的节点上。
  useLayoutEffect(() => {
    document.dispatchEvent(
      new CustomEvent('fl:ai-dock', {
        detail: { open: isOpen && dockLayout === 'bottom' },
      })
    )
  }, [isOpen, dockLayout])

  // 使用 layout effect 在渲染前准备好容器
  useLayoutEffect(() => {
    if (!isOpen) {
      // 关闭时把「等布局落定」的计数归零，下次打开重新从 0 开始等
      if (mountRetry !== 0) {
        setMountRetry(0)
      }
      // isOpen = false 时删除容器
      if (containerRef.current?.parentNode) {
        containerRef.current.parentNode.removeChild(containerRef.current)
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
      }
      containerRef.current = null
      pdfPanelRef.current = null
      resizeObserverRef.current = null
      setContainerReady(false)
      return
    }

    // isOpen = true 时创建容器
    if (containerRef.current) {
      // FIXED: 2026-10-30 切换「侧边 / 底部停靠」时父节点变了：
      // 原来看到容器已存在就直接 return，结果面板留在原来的位置不动。
      // 这里先把旧容器摘掉，下面按新目标重建。
      containerRef.current.parentNode?.removeChild(containerRef.current)
      containerRef.current = null
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
      setContainerReady(false)
    }

    debugConsole.log('[CodeMirror AI Chat] Creating container...')
    const container = document.createElement('div')
    container.className = 'ai-chat-panel-wrapper'
    container.id = 'ai-chat-container-' + Date.now()
    containerRef.current = container

    // FIXED: 2026-11-01 移动端：全屏浮层挂到 body。
    // 必须排在 bottom / side 两个分支之前 —— 手机上前两者的容器都不可见。
    // 用 fixed + 四边 0（而不是 right:0 + 固定宽 400px），才是真正的「整屏」，
    // 窄屏上也不会露出一条被挤压的 PDF。
    if (mobileViewport) {
      container.classList.add('ai-chat-panel-wrapper-mobile')
      container.style.position = 'fixed'
      container.style.top = '0'
      container.style.left = '0'
      container.style.right = '0'
      container.style.bottom = '0'
      container.style.width = '100%'
      container.style.height = '100%'
      container.style.zIndex = '10000'
      container.style.backgroundColor = 'var(--fl-surface, #ffffff)'
      container.style.borderLeft = 'none'
      container.style.overflow = 'hidden'
      document.body.appendChild(container)
      setContainerReady(true)
      return
    }

    // FIXED: 2026-11-13 弹窗（居中）模式：真模态。
    //
    // 为什么放在 mobile 之后：移动端保持原样（全屏浮层），需求里明确「移动端不变」。
    //
    // 语义：
    //   - 容器铺满视口（fixed + 四边 0），半透明遮罩，flex 居中；
    //   - **不注册任何 click / keydown 监听**：点遮罩不关、Esc 也不关，
    //     只有面板头部的 ✕（或工具栏按钮）这类明确入口才关；
    //   - 遮罩吞掉点击，打开期间不与编辑器抢焦点（这才是「模态」）；
    //   - 具体宽高由 portal 里的内层 div 决定（PC 50%，见下面的 innerStyle）。
    if (panelLayout === 'modal') {
      container.classList.add('ai-chat-panel-wrapper-modal')
      container.style.position = 'fixed'
      container.style.top = '0'
      container.style.left = '0'
      container.style.right = '0'
      container.style.bottom = '0'
      container.style.width = '100%'
      container.style.height = '100%'
      container.style.display = 'flex'
      container.style.alignItems = 'center'
      container.style.justifyContent = 'center'
      container.style.padding = '24px'
      container.style.boxSizing = 'border-box'
      container.style.zIndex = '10000'
      container.style.backgroundColor =
        'var(--fl-modal-backdrop, rgba(15, 23, 42, 0.38))'
      // 基础类 .ai-chat-panel-wrapper 带 border-top，弹窗里不需要
      container.style.border = 'none'
      document.body.appendChild(container)
      setContainerReady(true)
      return
    }

    // FIXED: 2026-10-30 底部停靠模式挂到 south 面板里的容器，横跨编辑器 + 预览
    if (dockLayout === 'bottom') {
      const dock = document.querySelector('#fl-ai-dock') as HTMLElement | null
      if (dock) {
        container.classList.add('ai-chat-panel-wrapper-docked')
        container.style.position = 'absolute'
        container.style.top = '0'
        container.style.left = '0'
        container.style.right = '0'
        container.style.bottom = '0'
        container.style.width = '100%'
        container.style.height = '100%'
        container.style.overflow = 'hidden'
        dock.appendChild(container)
        setContainerReady(true)
        return
      }
      console.warn(
        '[CodeMirror AI Chat] #fl-ai-dock not found, falling back to side panel'
      )
    }

    // FIXED: 2026-11-08 目标容器统一由 getSideDockPane() 给出（优先 PDF 区的 east）。
    // 原来直接 querySelector('.ui-layout-east')，页面上有多个同名 pane 时会挂错。
    const layoutEast = getSideDockPane()

    // 状态说右侧可用、但宽度还没落定 → 等下一帧，不要急着退回 body
    if (
      dockLayout === 'side' &&
      sideDockByState === true &&
      (!layoutEast || layoutEast.offsetWidth === 0) &&
      mountRetry < 20
    ) {
      const rafId = window.requestAnimationFrame(() =>
        setMountRetry(count => count + 1)
      )
      return () => window.cancelAnimationFrame(rafId)
    }

    // FIXED: 2026-11-08 右侧 pane 存在但被收起（宽度 0）时不要往里塞，
    // 否则面板挂进一个 0 宽容器里 = 看不见。直接走 body 兜底（原行为）。
    if (layoutEast && layoutEast.offsetWidth > 0) {
      console.log(
        '[CodeMirror AI Chat] Found ui-layout-east, attaching chat panel...'
      )

      // 获取 PDF 容器的宽度（AI Chat 打开时完全覆盖 PDF）
      const pdfWidth = layoutEast.offsetWidth
      debugConsole.log('[CodeMirror AI Chat] PDF container width:', pdfWidth)

      // 设置容器样式 - absolute 定位，完全覆盖 PDF 区域
      container.style.position = 'absolute'
      container.style.top = '0'
      container.style.left = '0' // 从左边开始
      container.style.right = '0' // 延伸到右边（完全覆盖）
      container.style.bottom = '0'
      container.style.width = '100%' // 占满整个父容器宽度
      container.style.zIndex = '999' // 高于其他内容
      // FIXED: 2026-10-30 侧边面板的底色/描边原来写死白色 + #ddd，柔和色调里会露出白边。
      // 走 --fl-* 变量（浅色/柔和主题各自有一份），拿不到时再退回原值。
      container.style.backgroundColor = 'var(--fl-surface, #ffffff)'
      container.style.borderLeft = '1px solid var(--fl-border, #ddd)'
      container.style.overflow = 'hidden'
      container.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)'

      layoutEast.appendChild(container)
      debugConsole.log(
        '[CodeMirror AI Chat] Container appended to ui-layout-east, will cover full width:',
        pdfWidth
      )

      // 监听 layoutEast 宽度变化（用户可能调整面板大小）
      // 由于使用 100% 宽度，容器会自动适应父容器宽度变化
      resizeObserverRef.current = new ResizeObserver(() => {
        const newWidth = layoutEast.offsetWidth
        if (newWidth && newWidth > 200) {
          setWidth(newWidth)
          debugConsole.log(
            '[CodeMirror AI Chat] Parent width changed to:',
            newWidth
          )
        }
      })
      resizeObserverRef.current.observe(layoutEast)
    } else {
      // 备用方案：添加到 body
      console.warn(
        '[CodeMirror AI Chat] ui-layout-east not found, using body as fallback'
      )
      container.style.position = 'fixed'
      container.style.top = '0'
      container.style.right = '0'
      container.style.bottom = '0'
      container.style.width = `${width}px`
      container.style.zIndex = '10000'
      container.style.backgroundColor = '#ffffff'
      container.style.borderLeft = '1px solid #ddd'
      container.style.overflow = 'hidden'
      container.style.boxShadow = '0 2px 12px rgba(0,0,0,0.15)'
      document.body.appendChild(container)
      debugConsole.log(
        '[CodeMirror AI Chat] Container appended to body (fallback)'
      )
    }

    // 容器创建完毕，标记为就绪以触发重新渲染
    setContainerReady(true)
  }, [
    isOpen,
    dockLayout,
    sideDockByState,
    mountRetry,
    mobileViewport,
    panelLayout,
  ])

  // 当宽度变化时保存到 localStorage（用户可能调整布局）
  useEffect(() => {
    if (isOpen && width) {
      localStorage.setItem('flylatex-ai-chat-width', String(width))
    }
  }, [width, isOpen])

  if (!isOpen || !containerReady || !containerRef.current) {
    // FIXED: 2026-11-08 删掉这里的 console.log：它在每次 render 都会跑，
    // 面板关闭时等于每个渲染帧刷一行，F12 直接被刷屏。
    return null
  }

  // FIXED: 2026-11-08 同上，这行也是每帧输出的渲染日志

  // FIXED: 2026-11-13 弹窗模式的内层容器：PC 占视口 50%（560~1280px 夹紧）、
  // 高度 min(80vh, 900px)，圆角 + 阴影；移动端给全屏（实际走上面的 mobile 分支）。
  // 其余模式保持原来的 100% / 100%（容器已经定好尺寸）。
  const innerStyle: React.CSSProperties =
    panelLayout === 'modal'
      ? {
          position: 'relative',
          width: mobileViewport ? '100%' : '50%',
          minWidth: mobileViewport ? undefined : 560,
          maxWidth: mobileViewport ? undefined : 1280,
          height: mobileViewport ? '100%' : 'min(80vh, 900px)',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--fl-surface, #ffffff)',
          borderRadius: mobileViewport ? 0 : 12,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.28)',
          overflow: 'hidden',
        }
      : {
          width: '100%', // 100% of container width (which is already set)
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#ffffff',
        }

  return createPortal(
    <div style={innerStyle}>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <AIChatPanelContent
          onClose={() => setIsOpen(false)}
          onRequestClose={() => setIsOpen(false)}
          temporaryBottomDock={
            panelLayout === 'side' && dockLayout === 'bottom'
          }
        />
      </div>
    </div>,
    containerRef.current
  )
}

export default CodeMirrorAIChat
