import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
// FIXED: 2026-10-16 使用共享 markdown 渲染，外链自动新标签页打开
// OLD: import { marked } from 'marked'
import { MathJaxMarkdown } from '../../../shared/components/mathjax-markdown'
import Icon from '../../../shared/components/icon'
import AISparklesIcon from '../../../shared/components/ai-sparkles-icon'
import * as eventTracking from '../../../infrastructure/event-tracking'
import { showSuccessToast } from '../../../shared/utils/toast'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import { postJSON, getJSON, deleteJSON } from '../../../infrastructure/fetch-json'
// FIXED: 2026-10-23 输入法选词时的 Enter 不应触发发送
import { isImeComposing } from '../../../shared/utils/ime'
// FIXED: 2026-10-29 ask/agent 模式按项目记忆（与 codemirror-ai-chat 共用一份实现）
import {
  readChatMode,
  storeChatMode,
  currentProjectId,
} from '../../../shared/utils/chat-mode-storage'
// FIXED: 2026-11-07 流式（SSE）：工具步骤与结论边跑边显示（与 codemirror-ai-chat 共用一份实现）
import {
  streamAiChat,
  upsertStep,
  isAbortError,
  newRunId,
  stopAiRun,
  type AiChatStep,
  type AiChatDonePayload,
} from '../../../shared/utils/ai-chat-stream'
import AiSteps from '../../../shared/components/ai-steps'
// FIXED: 2026-11-17 消息时间戳（提问/回复下方、功能按钮前面），与浮层面板共用一套格式
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
  processMarkdown?: string  // ← 执行过程信息（执行追踪、Agent 调用等）
  statusHistory?: string[]  // ← 流式状态历史（实时更新）
  showProcess?: boolean     // ← 是否显示执行过程（可折叠）
  isExpanded?: boolean      // ← FIXED: 2026-10-16 长消息是否展开（默认折叠）
  // FIXED: 2026-11-07 流式新增：工具步骤（只存内存，不落库）/ 当前阶段文案 / 用户已停止
  steps?: AiChatStep[]
  statusText?: string
  stopped?: boolean
  // FIXED: 2026-11-17 时间戳：历史消息用服务端的 createdAt，实时消息在「不再 loading」时补上
  createdAt?: string
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
 * 问题：用户消息是纯文本 + white-space: pre-wrap，导致文本里每个空行都按整行高
 *       （13px × 1.5 ≈ 19.5px）撑开；而助手消息走 markdown，空行只产生 8px 段间距。
 *       同一段日志，用户气泡的间距因此明显大于助手气泡。
 * 方案：按空行切成段，段间距用 8px（与助手一致）；段内仍用 pre-wrap 保留单个换行。
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

export default function AIChatPanel({ onClose }) {
  const { t } = useTranslation()
  const { startCompile } = useCompileContext()
  const [messages, setMessages] = useState<Message[]>([])
  // FIXED: 2026-11-17 消息时间戳：历史消息自带服务端的 createdAt，实时消息在
  //   「不再 loading」的那一帧补一个（收尾分支有好几处，集中在这里才不会漏）。
  useEffect(() => {
    if (!messages.some(m => !m.isLoading && !m.createdAt)) return
    setMessages(prev => {
      let changed = false
      const next = prev.map(m => {
        if (m.isLoading || m.createdAt) return m
        changed = true
        return { ...m, createdAt: new Date().toISOString() }
      })
      return changed ? next : prev
    })
  }, [messages])
  // 每条回复的用时（回复时间 - 它前面那条提问时间）
  const elapsedByMessageId = useMemo(
    () => computeElapsedByMessageId(messages),
    [messages]
  )
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [statusText, setStatusText] = useState('')
  // FIXED: 2026-10-29 初始值取自当前项目的记忆值（无记录时仍是 'ask'）
  const [chatMode, setChatMode] = useState<ChatMode>(() =>
    readChatMode(currentProjectId())
  )
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // FIXED: 2026-11-18 消息列表（真正的滚动容器）的 ref：滚到底改成直接动它，
  // 不再用 scrollIntoView（原因见下面 scrollToBottom 的注释）。
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // FIXED: 2026-11-07 当前这轮流式请求的中止句柄（“停止”按钮用）
  const stopRef = useRef<AbortController | null>(null)
  // FIXED: 2026-11 本轮 runId（服务端用它识别「用户主动停止」，不再把断开当停止）
  const stopRunIdRef = useRef<string | null>(null)
  // FIXED: 2026-10-23 记录 compositionend 时间，兜住 Safari 先结束组合再派发 Enter 的情况
  const compositionEndedAtRef = useRef(0)

  // FIXED: 2026-11-18 移动端「输入框被顶到屏幕上方、只能刷新恢复」的根因修复。
  // OLD: messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  //
  // scrollIntoView 会把**所有可滚动祖先**一起滚，包括 overflow:hidden 的容器
  // （overflow:hidden 只是不出滚动条，JS 照样能滚，而且滚完不会自己复位）。
  // AI 浮层在移动端是 fixed 全屏：container / 内层 div 的 overflow 都是 hidden，
  // 一旦流式输出或步骤卡片让内容瞬时超高，这几层祖先就会被滚走 —— 表现就是
  // 头部出屏、输入框跑到屏幕上方、下面一片空白；scrollTop 没人归零，所以
  // 只能刷新。直接给消息列表设 scrollTop 只影响它自己，祖先一律不动。
  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current
    if (!el) {
      return
    }
    // 有平滑滚动就用平滑，不支持（或用户要减少动效）时退回直接赋值
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // FIXED: 2026-11-18 兜底自愈：老版本 scrollIntoView 留下的祖先偏移（已经中招的
  // 用户，scrollTop 停在非 0 上）在挂载时归零，不必再刷新页面。
  // 同时覆盖 iOS 聚焦输入框时浏览器自行滚动祖先链的情况。
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
    // 首次挂载时高度可能还没收敛，300ms 后再来一次
    const timer = window.setTimeout(resetAncestorScroll, 300)
    return () => window.clearTimeout(timer)
  }, [])

  // 格式化模型名称显示，移除路径前缀和量化后缀
  const formatModelName = useCallback((modelName: string | undefined): string => {
    if (!modelName) return ''
    
    // 如果包含路径，提取最后一个 / 后的部分
    let displayName = modelName
    if (modelName.includes('/')) {
      displayName = modelName.split('/').pop() || modelName
    }
    
    // 去掉末尾的量化后缀（-FP8, -FP16, -INT8, -INT4等）
    displayName = displayName.replace(/-(?:FP8|FP16|FP32|INT8|INT4|GGUF|AWQLM)$/i, '')
    
    return displayName
  }, [])

  // 从服务器加载历史对话
  useEffect(() => {
    const loadMessages = async () => {
      const projectId = window.project_id || 'unknown'
      try {
        const result = await getJSON<any>(
          `${AI_CHAT_API_BASE}/messages?projectId=${encodeURIComponent(projectId)}&limit=20`
        )
        if (result.success && Array.isArray(result.data)) {
          console.log('[AI Chat] Loaded messages from server:', result.data.length)
          setMessages(result.data)
        }
      } catch (err) {
        console.warn('[AI Chat] Failed to load messages from server:', err)
      }
    }
    loadMessages()
  }, [])

  const saveMessageToServer = useCallback(async (projectId: string, message: Message) => {
    try {
      await postJSON(`${AI_CHAT_API_BASE}/save-message`, {
        body: { projectId, message },
      })
    } catch (err) {
      console.warn('[AI Chat] Error saving message to server:', err)
    }
  }, [])

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      // FIXED: 2026-11-17 提问时间（回复的用时就是拿它算的）
      createdAt: new Date().toISOString(),
    }

    const loadingMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      isLoading: true,
    }

    setMessages(prev => [...prev, userMessage, loadingMessage])
    setInput('')
    setIsLoading(true)

    const projectId = window.project_id || 'unknown'
    saveMessageToServer(projectId, userMessage)

    try {
      // FIXED: 2026-10-23 当前问题由后端统一追加，避免历史里重复一条 user 消息
      const conversationHistory = messages.map(m => ({
        role: m.role,
        content: m.content,
      }))

      // FIXED: 2026-11-07 改走 /ft-ai 的流式（SSE）：工具步骤和结论边跑边显示，
      // 并且可以中途停止；只有拿到 done 才落库，存的就是最后那段结论。
      // OLD: const res = await fetch(FETCH_AI_BASE, {...}); const data = await res.json()
      const controller = new AbortController()
      stopRef.current = controller
      let streamedText = ''
      let steps: AiChatStep[] = []
      let donePayload: AiChatDonePayload | null = null
      let streamError = ''

      const patchLoading = (patch: Partial<Message>) => {
        setMessages(prev =>
          prev.map(m => (m.id === loadingMessage.id ? { ...m, ...patch } : m))
        )
      }

      // 10 秒没有任何事件：不重发（agent 可能已在改文件，重发＝重复执行＋重复计费），
      // 只把文案切到“等待完整结果”，连接继续挂着
      const firstFrameTimer = window.setTimeout(() => {
        patchLoading({ statusText: '网络似乎不支持流式，正在等待完整结果…' })
      }, 10000)

      try {
        // FIXED: 2026-11 带上 runId：服务端靠它区分「用户主动停止」和「客户端断开」。
        // 之前这里不带 runId，服务端走的是兼容旧客户端的老逻辑——切走页面等于
        // 中止这一轮，既不落库也不发终止事件，回来就只剩自己那句提问。
        const runId = newRunId()
        stopRunIdRef.current = runId
        await streamAiChat(
          {
            text: input.trim(),
            mode: chatMode,
            conversation: conversationHistory,
            workspace: window.project_id,
            runId,
          },
          {
            onFirstEvent: () => window.clearTimeout(firstFrameTimer),
            onStatus: text => {
              setStatusText(text)
              patchLoading({ statusText: text })
            },
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
        throw new Error('No response from server')
      }

      const finalPayload: AiChatDonePayload = donePayload
      const finalText = (finalPayload.data || streamedText || '').trim()

      // 如果需要重新编译，重新加载编辑器中当前打开的文档内容
      if (finalPayload.needsRecompile === true) {
        console.log('[AI Chat] AI modified LaTeX files, reloading current document in editor ai-chat-panel')
        
        try {
          // 通过 IDE 编辑器管理器重新加载当前文档（从 MongoDB 获取最新内容）
          const ide = (window as any)._ide
          const editorManager = ide?.editorManager
          
          if (editorManager && typeof editorManager.reloadCurrentDocument === 'function') {
            editorManager.reloadCurrentDocument()
            console.log('[AI Chat] Reloading current document completed')
          } else {
            console.warn('[AI Chat] EditorManager.reloadCurrentDocument not available')
          }
        } catch (e) {
          console.warn('[AI Chat] Error reloading document:', e)
        }
      }

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: finalText,
        steps,
        // FIXED: 2026-11-08 去掉写死的 'deepseek-chat' 兜底：
        // 模型名只有一个口径 —— 后端 done 事件里报的实际模型（= 用户设置里选的，
        // 没选就是系统默认）。拿不到就干脆不显示这个徽标，不要瞎猜一个名字。
        // OLD: model: finalPayload.model || 'deepseek-chat',
        model: finalPayload.model,
        totalTokens: finalPayload.usage?.totalTokens,
        inputTokens: finalPayload.usage?.inputTokens,
        outputTokens: finalPayload.usage?.outputTokens,
      }

      setMessages(prev =>
        prev.map(m => (m.id === loadingMessage.id ? aiMessage : m))
      )

      // FIXED: 2026-11-07 只存最终结论；工具步骤不落库（刷新后历史里只看结论）
      saveMessageToServer(projectId, aiMessage)
    } catch (err) {
      // FIXED: 2026-11-07 用户点“停止”：只告知，不落库、不当错误
      if (isAbortError(err)) {
        setMessages(prev =>
          prev.map(m =>
            m.id === loadingMessage.id
              ? { ...m, isLoading: false, stopped: true, content: '', statusText: undefined }
              : m
          )
        )
        return
      }
      setMessages(prev => {
        const newMessages = [...prev]
        const lastIndex = newMessages.findIndex(m => m.id === loadingMessage.id)
        if (lastIndex !== -1) {
          newMessages[lastIndex] = {
            ...loadingMessage,
            content: t('service_error'),
            isLoading: false,
          }
        }
        return newMessages
      })
    } finally {
      stopRef.current = null
      setIsLoading(false)
      inputRef.current?.focus()
    }
  }, [input, isLoading, messages, t])

  // FIXED: 2026-11-07 「停止」：中断本轮。后端会拆掉上游请求，且这一轮什么都不落库
  // FIXED: 2026-11 自从发送带上 runId，光中断本地 fetch 已经停不掉服务端那一轮了
  // （服务端会把「断开」当成「用户只是离开了」）。所以必须显式调 /ft-ai/stop。
  // OLD: stopRef.current?.abort()
  const handleStop = useCallback(() => {
    const runId = stopRunIdRef.current || undefined
    stopRunIdRef.current = null
    stopRef.current?.abort()
    stopAiRun({
      projectId: currentProjectId(),
      // 这个面板不带 conversationId，服务端按默认会话处理（传空串同样落到 default）
      conversationId: '',
      runId,
    }).catch(() => {})
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // FIXED: 2026-10-23 输入法选词/上屏候选时的 Enter 不发送，交还给输入法
      // OLD: if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
      if (isImeComposing(e, compositionEndedAtRef.current)) {
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleClear = useCallback(async () => {
    const projectId = window.project_id || 'unknown'
    try {
      await deleteJSON<any>(
        `${AI_CHAT_API_BASE}/messages?projectId=${encodeURIComponent(projectId)}`
      )
    } catch (err) {
      console.warn('[AI Chat] Failed to clear messages from server:', err)
    }
    setMessages([])
    inputRef.current?.focus()
  }, [])

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (deleteConfirmId === messageId) {
      const projectId = window.project_id || 'unknown'
      try {
        await deleteJSON<any>(
          `${AI_CHAT_API_BASE}/messages/${encodeURIComponent(messageId)}?projectId=${encodeURIComponent(projectId)}`
        )
        setMessages(prev => prev.filter(m => m.id !== messageId))
      } catch (err) {
        console.error('[AI Chat] Failed to delete message:', err)
      }
      setDeleteConfirmId(null)
    } else {
      setDeleteConfirmId(messageId)
      setTimeout(() => setDeleteConfirmId(null), 2000)
    }
  }, [deleteConfirmId])

  const handleCopy = useCallback((text: string) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        showSuccessToast(t('copy') + ' ' + t('success'))
      }).catch(() => {
        copyToClipboardFallback(text)
      })
    } else {
      copyToClipboardFallback(text)
    }
  }, [t])

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

  return (
    <div className="ai-chat-panel">
      <div className="ai-chat-header">
        <div className="ai-chat-title">
          <Icon type="comments" />
          <span>{t('ai_assistant')}</span>
        </div>
        <div className="ai-chat-actions">
          <button
            className="btn btn-link"
            onClick={handleClear}
            title={t('clear')}
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
                    statusText={msg.statusText || statusText}
                  />
                  {msg.content ? (
                    <MathJaxMarkdown
                      className="ai-message-markdown"
                      markdown={msg.content}
                    />
                  ) : (
                    <span className="ai-loading">
                      {msg.statusText || statusText || t('ai_thinking')}
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
                          {t('tokens')}: {msg.totalTokens}{' '}
                          <span style={{ color: '#bbb' }}>
                            (↓{msg.inputTokens} ↑{msg.outputTokens})
                          </span>
                        </div>
                      </div>
                    ) : null}
                    {/* FIXED: 2026-11-17 时间戳放在功能按钮前面（含本轮用时）。
                        外层这一栏是 column，单独包一层让它靠右。 */}
                    <div style={{ alignSelf: 'flex-end' }}>
                      <AiMessageTime
                        createdAt={msg.createdAt}
                        elapsedMs={elapsedByMessageId[msg.id]}
                      />
                    </div>
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
                        alignSelf: 'flex-end',
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.opacity = '0.7')
                      }
                      onMouseLeave={(e) =>
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
                        background: deleteConfirmId === msg.id ? '#ff4d4f' : 'none',
                        border: deleteConfirmId === msg.id ? '1px solid #ff4d4f' : 'none',
                        cursor: 'pointer',
                        padding: '4px 8px',
                        color: deleteConfirmId === msg.id ? '#fff' : '#ff4d4f',
                        fontSize: '12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        borderRadius: '4px',
                        alignSelf: 'flex-end',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                      {deleteConfirmId === msg.id ? '确认' : '删除'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                  <div
                    className="ai-msg-meta"
                    style={{ display: 'flex', gap: '8px', alignSelf: 'flex-end' }}
                  >
                    {/* FIXED: 2026-11-17 提问也有时间戳（回复的用时就是拿它算的） */}
                    <AiMessageTime createdAt={msg.createdAt} />
                    <button
                      onClick={() => {
                        setInput(msg.content)
                        inputRef.current?.focus()
                      }}
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
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                        background: deleteConfirmId === msg.id ? '#ff4d4f' : 'none',
                        border: deleteConfirmId === msg.id ? '1px solid #ff4d4f' : 'none',
                        cursor: 'pointer',
                        padding: '4px 8px',
                        color: deleteConfirmId === msg.id ? '#fff' : '#ff4d4f',
                        fontSize: '12px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        borderRadius: '4px',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-chat-input">
        <select
          value={chatMode}
          onChange={e => {
            const mode = e.target.value as ChatMode
            setChatMode(mode)
            // FIXED: 2026-10-29 记住到本项目
            storeChatMode(currentProjectId(), mode)
          }}
          disabled={isLoading}
          style={{
            padding: '8px 12px',
            border: '1px solid var(--fl-border, #ddd)',
            borderRadius: '4px',
            backgroundColor: 'var(--fl-surface, #fff)',
            color: 'var(--fl-text, #333)',
            fontSize: '13px',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            marginRight: '8px',
          }}
          title={chatMode === 'ask' ? t('ask_mode_tooltip') : t('agent_mode_tooltip')}
        >
          <option value="ask">{t('ask_mode')}</option>
          <option value="agent">{t('agent_mode')}</option>
        </select>
        {/* FIXED: 2026-11 统一 class，窄视图里 placeholder 只允许单行（见 ai-chat.less） */}
        <textarea
          className="fl-ai-chat-textarea"
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionEnd={() => {
            // FIXED: 2026-10-23 记录组合输入结束时刻，供 Enter 判定使用
            compositionEndedAtRef.current = Date.now()
          }}
          placeholder={chatMode === 'ask' ? t('ask_input_placeholder') : t('agent_input_placeholder')}
          rows={1}
          disabled={isLoading}
          style={{ flex: 1 }}
        />
        {/* FIXED: 2026-11-07 发送/停止同位置切换（参考 flylatex-agent）：
            跑的时候这个键变成停止，不再在消息下面另给一个“停止”按钮 */}
        {isLoading ? (
          <button
            className="btn btn-danger"
            onClick={handleStop}
            title="停止"
            aria-label="停止"
          >
            <Icon type="stop" />
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={!input.trim()}
          >
            <Icon type="paper-plane" />
          </button>
        )}
      </div>
    </div>
  )
}
