// AI 助手的 ask/agent 模式记忆
//
// 背景：chatMode 一直是各面板组件里的 useState('ask')，刷新一次就弹回 ask，
// 常用 agent 的人在同一个项目里每次都得重新拨一次。
//
// 记忆粒度是「项目」：key 里带 projectId，所以
// - 同一项目内刷新 / 重开面板：保持上次选择
// - 换项目、新建项目：该项目没有记录，回到默认 ask
//
// 两个面板（ai-chat-panel.tsx 与 codemirror-ai-chat.tsx）共用这一份实现。

export type ChatMode = 'ask' | 'agent'

const KEY_PREFIX = 'fl-ai-chat-mode'
export const DEFAULT_CHAT_MODE: ChatMode = 'ask'

/** 当前项目 id（没有时退化为 'unknown'，两个面板原有做法一致） */
export function currentProjectId(): string {
  return window.project_id || 'unknown'
}

function storageKey(projectId: string) {
  return `${KEY_PREFIX}:${projectId}`
}

export function readChatMode(projectId: string): ChatMode {
  try {
    return window.localStorage.getItem(storageKey(projectId)) === 'agent'
      ? 'agent'
      : DEFAULT_CHAT_MODE
  } catch {
    // 隐私模式 / localStorage 被禁用时静默退回默认值
    return DEFAULT_CHAT_MODE
  }
}

export function storeChatMode(projectId: string, mode: ChatMode) {
  try {
    window.localStorage.setItem(storageKey(projectId), mode)
  } catch {
    // 忽略：存不下就只是不记忆，不影响发送
  }
}
