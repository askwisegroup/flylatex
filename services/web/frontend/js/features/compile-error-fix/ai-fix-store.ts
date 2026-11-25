import { postJSON } from '@/infrastructure/fetch-json'
import { showToast } from '@/shared/utils/toast'
import { debugConsole } from '@/utils/debugging'
import type { CompileErrorForFix } from './collect-errors'

/**
 * FIXED: 2026-11-16 「AI 修复」的状态放在模块级 store，而不是组件内。
 *
 * 原因（线上截图）：面板原来渲染在 `.logs-pane-actions` 里面 —— 那是个右对齐、
 * 高度 flex-grow 的小容器，定宽面板一旦比它宽就向左边溢出，被 `.logs-pane` 的
 * overflow 裁掉（表现为「修复建议」少了「AI」、「main.tex:311」只剩「tex:311」）。
 *
 * 现在：按钮留在 .logs-pane-actions（底部的动作行），面板渲染成
 * `.logs-pane-content` 里的一块**普通整宽区块**（见 pdf-ai-fix-panel.jsx），
 * 两者通过这个 store 共享状态 —— 不需要给日志面板加 Provider。
 */

export type AiFixProposal = {
  id: string
  file: string
  oldText: string
  newText: string
  explanation?: string
  startLine?: number
  endLine?: number
}

type AiFixState = {
  status: 'idle' | 'loading' | 'ready'
  proposals: AiFixProposal[]
  notice: string
  applied: Record<string, 'ok' | 'error' | 'skip'>
  applyingId: string | null
}

const initialState: AiFixState = {
  status: 'idle',
  proposals: [],
  notice: '',
  applied: {},
  applyingId: null,
}

let state: AiFixState = { ...initialState }
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) {
    listener()
  }
}

function setState(patch: Partial<AiFixState>) {
  state = { ...state, ...patch }
  emit()
}

export function subscribeAiFix(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getAiFixState(): AiFixState {
  return state
}

export function dismissAiFix() {
  setState({ status: 'idle', proposals: [], notice: '', applied: {} })
}

export async function requestAiFix(
  projectId: string,
  errors: CompileErrorForFix[]
) {
  setState({
    status: 'loading',
    notice: '',
    applied: {},
    proposals: [],
  })

  try {
    const result = await postJSON('/ft-ai/error-fix', {
      body: { workspace: projectId, errors },
    })

    if (result.code !== 0) {
      // 一次性的提示（没有可定位的错误 / 环境类问题）→ toast，不占面板
      showToast(result.msg || '没有拿到修复建议', { duration: 4500 })
      dismissAiFix()
      return
    }

    const proposals: AiFixProposal[] = result.data?.proposals || []
    if (!proposals.length) {
      showToast(
        result.data?.explanation || result.msg || '这条错误看起来不是源码问题',
        { duration: 5000 }
      )
      dismissAiFix()
      return
    }

    setState({
      status: 'ready',
      proposals,
      notice: result.data?.explanation || '',
      applied: {},
    })
  } catch (error: any) {
    debugConsole.warn('[ai-fix] 请求失败', error)
    showToast(error?.message || '请求失败，请重试', { duration: 4000 })
    dismissAiFix()
  }
}

export async function applyAiFix(projectId: string, proposal: AiFixProposal) {
  setState({ applyingId: proposal.id })

  try {
    const result = await postJSON('/ft-ai/error-fix/apply', {
      body: {
        workspace: projectId,
        file: proposal.file,
        oldText: proposal.oldText,
        newText: proposal.newText,
      },
    })

    if (result.code !== 0) {
      setState({
        applyingId: null,
        applied: { ...state.applied, [proposal.id]: 'error' },
      })
      showToast(result.msg || '应用失败', { duration: 4000 })
      return
    }

    const applied = { ...state.applied, [proposal.id]: 'ok' as const }
    setState({ applyingId: null, applied })
    const okCount = Object.values(applied).filter(v => v === 'ok').length
    showToast(
      okCount >= state.proposals.length
        ? `已应用全部 ${okCount} 处修改，重新编译即可看到结果`
        : `已应用：${proposal.file}`,
      { duration: 2500, fadeOut: true }
    )
  } catch (error: any) {
    setState({
      applyingId: null,
      applied: { ...state.applied, [proposal.id]: 'error' },
    })
    showToast(error?.message || '应用失败，请重试', { duration: 4000 })
  }
}

export function skipAiFix(proposalId: string) {
  setState({ applied: { ...state.applied, [proposalId]: 'skip' } })
}
