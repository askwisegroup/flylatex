import type { EditorView } from '@codemirror/view'

/**
 * FIXED: 2026-11-02 AI Agent 需要「用户选中了什么 / 光标在哪」
 *
 * 背景：Agent 的工具集里只有按文件读写的能力，没有任何「当前编辑状态」的概念。
 * 用户常说「把选中的文字翻译成英文然后原文替换」，模型既不知道选了什么，
 * 也不知道在哪一行，只能靠猜文件里的片段 —— 这是工具链缺了一环。
 *
 * 做法：在前端把「本次请求的编辑状态快照」算出来，随消息一起发给后端
 * （`editorContext`）。后端据此提供 get_editor_context / replace_selection 两个工具。
 *
 * 为什么是「请求时快照」而不是「工具回调前端取实时状态」：
 * 后端是纯 HTTP 请求-响应，没有向浏览器发起回调的通道；而选区在用户点发送那一刻
 * 就是确定的 —— 快照足够，且不需要改动 socket 协议。
 */

/** 单条消息里最多带多少选中的字符（保护上下文窗口与请求体大小） */
export const MAX_SELECTION_CHARS = 12000
/** 「光标所在行」的文本上限 */
export const MAX_CURRENT_LINE_CHARS = 400

export type EditorSelectionContext = {
  /** 选中的原文（可能被截断，看 truncated） */
  text: string
  /** CodeMirror 文档偏移（0 起） */
  from: number
  to: number
  /** 1 起的行号 */
  fromLine: number
  toLine: number
  lineCount: number
  charCount: number
  /** 是否因为超过 MAX_SELECTION_CHARS 被截断 */
  truncated: boolean
}

export type EditorContextSnapshot = {
  /** 当前文档名（.tex 相对路径），与编辑器标签页一致 */
  docName?: string
  docId?: string
  /** 当前文档字符数（用于让模型判断规模） */
  docLength: number
  /** 没有选中任何内容时为 null */
  selection: EditorSelectionContext | null
  /** 光标（1 起的行、列） */
  cursor: { line: number; column: number; offset: number }
  /** 光标所在整行 */
  currentLine: { line: number; text: string }
}

/**
 * 从 CodeMirror 的 view 里取编辑状态快照。
 * view 为 null/undefined 时返回 null（例如纯 Ace 老编辑器或初始化前）。
 */
export function buildEditorContext(
  view: EditorView | null | undefined,
  options: { docName?: string; docId?: string } = {}
): EditorContextSnapshot | null {
  if (!view) {
    return null
  }

  const { state } = view
  const { doc, selection } = state
  const main = selection.main

  const cursorLineObj = doc.lineAt(main.head)
  const cursor = {
    line: cursorLineObj.number,
    column: main.head - cursorLineObj.from + 1,
    offset: main.head,
  }
  const currentLine = {
    line: cursorLineObj.number,
    // 长行截断，避免把一整段没有换行的大文本塞进去
    text: cursorLineObj.text.slice(0, MAX_CURRENT_LINE_CHARS),
  }

  let selectionContext: EditorSelectionContext | null = null
  if (!main.empty) {
    const fromLineObj = doc.lineAt(main.from)
    const toLineObj = doc.lineAt(main.to)
    const rawText = doc.sliceString(main.from, main.to)
    const truncated = rawText.length > MAX_SELECTION_CHARS
    selectionContext = {
      text: truncated ? rawText.slice(0, MAX_SELECTION_CHARS) : rawText,
      from: main.from,
      to: main.to,
      fromLine: fromLineObj.number,
      toLine: toLineObj.number,
      lineCount: toLineObj.number - fromLineObj.number + 1,
      charCount: rawText.length,
      truncated,
    }
  }

  return {
    docName: options.docName,
    docId: options.docId,
    docLength: doc.length,
    selection: selectionContext,
    cursor,
    currentLine,
  }
}
