/**
 * FIXED: 2026-11-07 /ft-ai 流式客户端（SSE）
 *
 * 背景：`POST /ft-ai` 原来是「跑完整轮 Agent 才回一个 JSON」，
 * 前端只能一直显示「思考中…」，看不到工具在做什么，也没法停止。
 * 现在同一个接口多一个 `stream: true`：后端边跑边推事件，
 * 这里的任务只是把这些事件翻译成回调。
 *
 * 服务端事件（见 overleaf-ne-login/ai-agent.js）：
 *   status         { phase, text }                        当前阶段/等待提示
 *   tool_started   { id, name, detail }                   工具开始（detail 是文件名之类）
 *   tool_finished  { id, name, status, message, error, durationMs }
 *   text_delta     { delta }                              结论增量
 *   done           { data, model, usage, needsRecompile } 最终结论
 *   error          { code, msg }                          失败
 *
 * 兼容：不支持流式的老服务端/中间层可能直接回 JSON（因为参数校验失败时后端还没发头），
 * 这里按 content-type 分辨，JSON 也能正常当作一次 done/error 处理，不会白屏。
 */

export type AiChatStepStatus = 'running' | 'done' | 'error'

export type AiChatStep = {
  id: string
  /** 原始工具名，只用于映射展示文案，不直接给用户看 */
  name: string
  /** 参数摘要，例如 main.tex / references.bib */
  detail?: string
  status: AiChatStepStatus
  /** 成功时的结果摘要 */
  message?: string
  error?: string
  startedAt: number
  durationMs?: number
}

export type AiChatDonePayload = {
  data: string
  model?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  needsRecompile?: boolean
}

/**
 * FIXED: 2026-11 切回页面「接上」时服务端回的第一帧：
 * 这一轮到目前为止的正文、工具步骤与当前阶段（GET /ft-ai/stream）。
 */
export type AiRunSnapshot = {
  runId?: string
  startedAt?: string
  elapsedMs?: number
  /** 已生成的正文；之后继续用 text_delta 接增量 */
  text: string
  textTruncated?: boolean
  steps: AiChatStep[]
  status?: string
  seq?: number
  /** 极端竞态：挂上之前这一轮已经有结论了 */
  terminal?: { event: 'done' | 'error'; data: any } | null
}

export type AiChatStreamHandlers = {
  /** 重连快照：先铺底（正文 + 步骤 + 阶段），再等后续增量 */
  onSnapshot?: (snapshot: AiRunSnapshot) => void
  /** 阶段文案（"正在执行：replace_text…"、"模型响应较慢，已等待 20 秒…"） */
  onStatus?: (text: string) => void
  /** 工具步骤新增/更新（按 id upsert） */
  onStep?: (step: AiChatStep) => void
  /** 结论增量文本 */
  onDelta?: (delta: string) => void
  onDone?: (payload: AiChatDonePayload) => void
  onError?: (msg: string) => void
  /** 收到第一帧业务事件（用于「10 秒还没动静」的提示逻辑） */
  onFirstEvent?: () => void
}

export type AiChatStreamBody = {
  text: string
  mode: string
  conversation?: Array<{ role: string; content: string }>
  workspace?: string
  currentDocName?: string
  editorContext?: unknown
  images?: unknown
  // FIXED: 2026-11-17 输入框里 @ 指定的文件（相对路径）。
  // 后端会把正文直接塞进系统提示，并按「只看这些文件」约束模型，省掉全项目遍历。
  focusFiles?: string[]
  // FIXED: 2026-11-18 输入框里 `/服务名` 指定的 MCP 服务（名字）。
  // 后端只注入这些服务的工具，并在系统提示里写明「本轮就用它」。
  focusMcpServers?: string[]
  // FIXED: 2026-11-10 浏览器 window.location.origin，后端用它拼项目访问链接；
  // 后端拿不到真实域名（多层代理把 Host 换成 localhost），所以只能由前端显式带过去。
  origin?: string
  // FIXED: 2026-11-01 会话 id + 本轮 runId：
  // 服务端靠 conversationId 把结论落库（客户端走了也能存下来），
  // 靠 runId 支持「显式停止」以及重新打开面板时查“上一轮是不是还在跑”。
  conversationId?: string
  runId?: string
}

/** 本轮运行的标识（服务端会原样记录，供 /ft-ai/stop 与 /ft-ai/run 使用） */
export function newRunId(): string {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export type AiRunStatus = {
  running: boolean
  runId?: string
  startedAt?: string
  elapsedMs?: number
  clientGone?: boolean
  // FIXED: 2026-11 进度（切回页面时先让人看到"跑到哪了"，而不是只转圈）
  stepCount?: number
  doneStepCount?: number
  currentStep?: string | null
  statusText?: string | null
  textLength?: number
  steps?: AiChatStep[]
  lastActivityAt?: string
  seq?: number
}

export type StopAiRunResult = {
  /** 请求本身是否成功送达（4xx/5xx 或断网都算 false） */
  ok: boolean
  /** 服务端是否真的摘掉了一轮运行 */
  stopped: boolean
  /** 停完之后服务端认为还有没有在跑 */
  running: boolean
}

/**
 * 显式停止一轮运行（现在「停止」不能只靠 abort fetch：切页面不会中断了）。
 *
 * FIXED: 2026-11 不能再无声失败。
 * 之前这里只 catch 网络异常，HTTP 4xx/5xx 一律当成功 —— 于是「点停止没反应、
 * 横幅又回来」时，控制台里什么都看不到，等于把问题藏起来了。
 */
export async function stopAiRun(params: {
  projectId: string
  conversationId: string
  runId?: string
}): Promise<StopAiRunResult> {
  try {
    const res = await fetch('/ft-ai/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: params.projectId,
        conversationId: params.conversationId,
        runId: params.runId,
      }),
    })
    if (!res.ok) {
      console.warn('[ai-chat] stop request rejected:', res.status)
      return { ok: false, stopped: false, running: true }
    }
    const json = await res.json().catch(() => null)
    const data = (json && json.data) || {}
    return {
      ok: true,
      stopped: data.stopped === true,
      running: data.running === true,
    }
  } catch (err) {
    // 停止失败不应阻塞前端：本地 abort 仍会断开 SSE
    console.warn('[ai-chat] stop request failed', err)
    return { ok: false, stopped: false, running: true }
  }
}

/** 查询该会话是否还有一轮在跑（打开面板 / 恢复时用） */
export async function getAiRunStatus(params: {
  projectId: string
  conversationId: string
}): Promise<AiRunStatus> {
  try {
    const res = await fetch(
      `/ft-ai/run?projectId=${encodeURIComponent(
        params.projectId
      )}&conversationId=${encodeURIComponent(params.conversationId)}`,
      { headers: { Accept: 'application/json' } }
    )
    if (!res.ok) return { running: false }
    const json = await res.json()
    return (json && json.data) || { running: false }
  } catch (err) {
    return { running: false }
  }
}

/**
 * FIXED: 2026-11 切回页面时「接上」还在跑的那一轮。
 *
 * 返回：
 *   'streamed' 拿到了快照并已开始收增量（调用方按正常流式处理收尾）
 *   'idle'     当前没有可接的运行（204），调用方去拉历史消息即可
 */
export async function resumeAiRun(
  params: { projectId: string; conversationId: string },
  handlers: AiChatStreamHandlers,
  signal?: AbortSignal
): Promise<'streamed' | 'idle'> {
  let res: Response
  try {
    res = await fetch(
      `/ft-ai/stream?projectId=${encodeURIComponent(
        params.projectId
      )}&conversationId=${encodeURIComponent(params.conversationId)}`,
      { headers: { Accept: 'text/event-stream' }, signal }
    )
  } catch (err) {
    if (isAbortError(err)) throw err
    return 'idle'
  }

  // 没有可接的一轮：服务端直接 204
  if (res.status === 204) return 'idle'

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    return 'idle'
  }

  await consumeStream(res, handlers)
  return 'streamed'
}

/** 一帧 SSE：`event: xxx` + `data: {...}`（多行 data 会拼接） */
type SseFrame = { event: string; data: string }

function parseFrame(rawFrame: string): SseFrame | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of rawFrame.split('\n')) {
    if (line.startsWith(':')) continue // 注释/心跳（`: ping`）
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 区分“用户主动停止”和真正的失败（fetch abort 抛的是 DOMException: AbortError） */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: string }).name
  const message = String((error as { message?: string }).message || '')
  return name === 'AbortError' || /abort/i.test(message)
}

/** AI 流式专用错误码：网络断开 / 连接静默超时 / 服务端提前收尾 */
export type AiStreamErrorCode = 'network' | 'idle' | 'truncated'

export class AiStreamError extends Error {
  code: AiStreamErrorCode
  constructor(code: AiStreamErrorCode, message: string) {
    super(message)
    this.name = 'AiStreamError'
    this.code = code
  }
}

/**
 * 「连接断了」而不是「这一轮失败了」。
 *
 * FIXED: 2026-11 现场：网络抖一下、或者睡醒的笔记本切回前台，用户看到的就是
 * 「Failed to fetch」这种原样抛给用户的浏览器英文，并且这一轮在界面上等于没了。
 * 其实服务端还在跑（设计上「客户端离开继续跑」），结论也会落库。
 * 这类错误必须单独区分出来，交给上层切换到「后台执行中」的等待态。
 */
export function isStreamInterrupted(error: unknown): boolean {
  return (
    error instanceof AiStreamError &&
    (error.code === 'network' ||
      error.code === 'idle' ||
      error.code === 'truncated')
  )
}

/** 服务端每 15s 发一条心跳注释帧；这么久一个字都没收到，就当连接已死 */
const STREAM_IDLE_TIMEOUT_MS = 75000

/**
 * 发一次流式对话请求。只在 `done` 之后调用方才会落库（只存最终结论）。
 * 中止由传进来的 signal 负责：abort 后后端会拆掉上游请求且本轮不写历史。
 */
/**
 * 工具步骤按 id 合并：`tool_finished` 事件自带的是“结束时刻”，
 * 直接覆盖会把开始时间弄丢（耗时/排序都会错），所以这里保留旧的 startedAt。
 */
export function upsertStep(
  steps: AiChatStep[],
  next: AiChatStep
): AiChatStep[] {
  const index = steps.findIndex(step => step.id === next.id)
  if (index === -1) return [...steps, next]
  const previous = steps[index]
  const merged: AiChatStep = { ...next, startedAt: previous.startedAt }
  if (next.durationMs === undefined && previous.durationMs !== undefined) {
    merged.durationMs = previous.durationMs
  }
  const copy = steps.slice()
  copy[index] = merged
  return copy
}

export async function streamAiChat(
  body: AiChatStreamBody,
  handlers: AiChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  let res: Response
  try {
    res = await fetch('/ft-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ ...body, stream: true }),
    })
  } catch (err) {
    // 用户主动停止 → 原样抛（上层按 AbortError 处理）
    if (isAbortError(err)) throw err
    // FIXED: 2026-11 不再把浏览器的 "Failed to fetch" 直接甩给用户
    throw new AiStreamError(
      'network',
      '网络连接中断（服务端可能仍在执行，稍后会自动把结果补上）'
    )
  }

  const contentType = res.headers.get('content-type') || ''

  // 没发头就失败（参数/权限/服务端异常）：后端仍是老 JSON，这里当一次性结果处理
  if (!contentType.includes('text/event-stream')) {
    const text = await res.text()
    const json = parseJson(text)
    if (!json) {
      throw new Error(
        res.ok ? 'AI 服务返回了无法解析的内容' : `HTTP ${res.status}`
      )
    }
    handlers.onFirstEvent?.()
    if (json.code === 0) {
      handlers.onDone?.({
        data: typeof json.data === 'string' ? json.data : '',
        model: json.usage?.model || json.model,
        usage: mapUsage(json.usage),
        needsRecompile: json.needsRecompile === true,
      })
    } else {
      handlers.onError?.(json.msg || 'AI 服务异常')
    }
    return
  }

  await consumeStream(res, handlers)
}

/**
 * FIXED: 2026-11 消费一条 SSE 响应。
 * 首轮发送（POST /ft-ai）与切回重连（GET /ft-ai/stream）共用这一套解析与回调。
 */
async function consumeStream(
  res: Response,
  handlers: AiChatStreamHandlers
): Promise<void> {
  if (!res.body) {
    throw new Error('当前浏览器不支持流式响应')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawEvent = false
  let sawTerminal = false // 收到 done / error（本轮有明确结论）
  let idleFired = false

  const dispatch = (frame: SseFrame) => {
    const payload = parseJson(frame.data)
    // 心跳/无法解析的帧直接忽略
    if (!payload) return

    if (!sawEvent) {
      sawEvent = true
      handlers.onFirstEvent?.()
    }

    switch (frame.event) {
      case 'run_snapshot':
        handlers.onSnapshot?.({
          runId: payload.runId,
          startedAt: payload.startedAt,
          elapsedMs:
            typeof payload.elapsedMs === 'number' ? payload.elapsedMs : undefined,
          text: typeof payload.text === 'string' ? payload.text : '',
          textTruncated: payload.textTruncated === true,
          steps: Array.isArray(payload.steps) ? payload.steps : [],
          status: payload.status ? String(payload.status) : undefined,
          seq: typeof payload.seq === 'number' ? payload.seq : undefined,
          terminal:
            payload.terminal &&
            (payload.terminal.event === 'done' || payload.terminal.event === 'error')
              ? payload.terminal
              : null,
        })
        break
      case 'status':
        if (payload.text) handlers.onStatus?.(String(payload.text))
        break
      case 'tool_started':
        handlers.onStep?.({
          id: String(payload.id || payload.name || `step-${Date.now()}`),
          name: String(payload.name || 'tool'),
          detail: payload.detail ? String(payload.detail) : undefined,
          status: 'running',
          startedAt: Date.now(),
        })
        break
      case 'tool_finished':
        handlers.onStep?.({
          id: String(payload.id || payload.name || `step-${Date.now()}`),
          name: String(payload.name || 'tool'),
          status: payload.status === 'failed' ? 'error' : 'done',
          message: payload.message ? String(payload.message) : undefined,
          error: payload.error ? String(payload.error) : undefined,
          startedAt: Date.now(),
          durationMs:
            typeof payload.durationMs === 'number'
              ? payload.durationMs
              : undefined,
        })
        break
      case 'text_delta':
        if (payload.delta) handlers.onDelta?.(String(payload.delta))
        break
      case 'done':
        sawTerminal = true
        handlers.onDone?.({
          data: typeof payload.data === 'string' ? payload.data : '',
          model: payload.usage?.model || payload.model,
          usage: mapUsage(payload.usage),
          needsRecompile: payload.needsRecompile === true,
        })
        break
      case 'error':
        sawTerminal = true
        handlers.onError?.(payload.msg || 'AI 服务异常')
        break
      default:
        break
    }
  }

  // FIXED: 2026-11 连接静默超时保护。
  // 半死的连接（代理掐断 / 手机切网 / 笔记本睡眠）不会报错，reader.read() 会一直挂着，
  // 用户看到的就是「一直转圈、既不出结果也不能用」。心跳 15s 一跳，75s 没动静即判死。
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleFired = true
      try {
        reader.cancel().catch(() => {})
      } catch {}
    }, STREAM_IDLE_TIMEOUT_MS)
  }
  armIdleTimer()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    armIdleTimer()
    // 统一换行，避免 \r\n\r\n 拆帧失败
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

    let sep = buffer.indexOf('\n\n')
    while (sep >= 0) {
      const rawFrame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const frame = parseFrame(rawFrame)
      if (frame) dispatch(frame)
      sep = buffer.indexOf('\n\n')
    }
  }

  if (idleTimer) clearTimeout(idleTimer)

  // 收尾时可能还剩最后一帧（没有以空行结尾）
  const tail = parseFrame(buffer)
  if (tail) dispatch(tail)

  // FIXED: 2026-11 连接结束但没收到 done / error：服务端进程重启、或中间代理
  // 掐了长连接。这里不当「本轮失败」，交给上层判断服务端是不是还在后台跑。
  if (!sawTerminal) {
    throw new AiStreamError(
      idleFired ? 'idle' : 'truncated',
      idleFired
        ? '连接长时间没有响应，已断开（服务端可能仍在执行）'
        : '连接被中断，未收到本轮结果'
    )
  }
}

function mapUsage(usage: any): AiChatDonePayload['usage'] {
  if (!usage || typeof usage !== 'object') return undefined
  return {
    inputTokens: usage.inputTokens ?? usage.prompt_tokens,
    outputTokens: usage.outputTokens ?? usage.completion_tokens,
    totalTokens: usage.totalTokens ?? usage.total_tokens,
  }
}
