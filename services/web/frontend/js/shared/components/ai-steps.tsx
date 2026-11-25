import { useState } from 'react'
import type { AiChatStep } from '../utils/ai-chat-stream'

/**
 * FIXED: 2026-11-07 AI 对话的「工具调用步骤条」
 *
 * 设计参考 flylatex-agent 的 steps.tsx：原始工具名（read_file_range /
 * replace_text）对用户没有意义，所以这里做一次本地化映射，只显示
 * 「正在读取文件 · main.tex」这样的说法。
 *
 * 三种状态：
 * - 运行中：默认也是折叠的，只留一行带转圈的摘要（想细看再点开）
 * - 结束：收起成一行很淡的痕迹（"本轮执行了 4 个步骤"），点一下还能看
 * - 用户停止：不展示步骤，由调用方显示"用户停止任务"
 */

/** 工具名 → 人话。没收录的走兜底（去掉下划线原样显示）。 */
const TOOL_LABELS: Record<string, string> = {
  read_latex_file: '读取文件',
  read_file_range: '读取文件',
  read_file: '查看编译产物',
  list_files: '列出编译产物',
  list_project_files: '列出项目文件',
  write_latex_file: '写入文件',
  replace_text: '修改内容',
  replace_with_lines: '修改内容',
  replace_selection: '替换选中内容',
  insert_line: '插入内容',
  delete_lines: '删除内容',
  undo_last_edit: '撤销修改',
  get_editor_context: '读取选区',
  search_references: '检索参考文献',
  // FIXED: 2026-11 检索工具合并为一个入口（CrossRef + AMiner 自动合并）
  search_literature: '检索文献',
  search_papers_online: '检索文献',
  update_bib_file: '更新参考文献',
  compile_latex: '编译',
  // FIXED: 2026-11 agent 可以直接触发编译（工具名 compile_project）
  compile_project: '编译并检查',
  // FIXED: 2026-11 只换引擎不编译（一次设置更新，几百毫秒）
  set_compiler: '切换编译器',
  // FIXED: 2026-11 设主文件（没设主文件时编译会直接 no main file specified）
  set_main_file: '设置主文件',
  // FIXED: 2026-11 agent 可以重命名项目文件（zip 导入的乱码名靠它修）
  rename_file: '重命名文件',
  // FIXED: 2026-11-15 agent 可以重命名项目本身（平台层面的项目名）
  rename_project: '重命名项目',
  // FIXED: 2026-11-15 文件整理三件套 + 历史回滚
  delete_file: '删除文件',
  move_file: '移动文件',
  mkdir_folder: '新建文件夹',
  list_history_versions: '查看历史版本',
  restore_file: '恢复文件',
  // FIXED: 2026-11-16 读上次编译日志（不重新编译）
  read_compile_log: '查看编译日志',
  // FIXED: 2026-11-10 个人知识库（用户自己所有项目的 LaTeX 稿件）。
  // 老名字保留映射，历史会话里出现过这些工具名时不至于显示成裸函数名。
  kb: '个人知识库',
  kb_list: '列出知识库',
  kb_search: '检索知识库',
  kb_read: '读取知识库章节',
  kb_cite: '生成引用',
  compile: '编译',
}

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]
  return name.replace(/_/g, ' ')
}

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

export type AiStepsProps = {
  steps: AiChatStep[]
  running: boolean
  /** 当前阶段文案（模型等待、正在执行 xxx 等） */
  statusText?: string
  /** 用户主动停止：整块不展示 */
  stopped?: boolean
}

function AiSteps({ steps, running, statusText, stopped }: AiStepsProps) {
  // FIXED: 2026-11-07 默认折叠（之前运行中默认展开，步骤一多就刷屏）。
  // 运行中只留一行摘要 + 转圈，能看出“在动、在第几步”，细节点开才看。
  const [expanded, setExpanded] = useState(false)

  if (stopped) return null
  if (steps.length === 0 && !running && !statusText) return null

  const failedCount = steps.filter(step => step.status === 'error').length
  const summary = running
    ? statusText ||
      (steps.length > 0 ? `正在执行…（第 ${steps.length} 步）` : '正在准备…')
    : steps.length > 0
    ? `本轮执行了 ${steps.length} 个步骤${
        failedCount > 0 ? `（${failedCount} 个失败）` : ''
      }`
    : statusText || ''

  return (
    <div
      className={`ai-steps${running ? ' ai-steps-running' : ' ai-steps-done'}${
        expanded ? ' ai-steps-expanded' : ''
      }`}
    >
      <button
        type="button"
        className="ai-steps-toggle"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
      >
        <span className="ai-steps-caret">{expanded ? '▾' : '▸'}</span>
        {running && <span className="ai-steps-spinner" aria-hidden="true" />}
        <span className="ai-steps-summary">{summary}</span>
      </button>

      {expanded && steps.length > 0 && (
        <ul className="ai-steps-list">
          {steps.map(step => (
            <li key={step.id} className={`ai-step ai-step-${step.status}`}>
              <span className="ai-step-icon" aria-hidden="true">
                {step.status === 'running'
                  ? '⏳'
                  : step.status === 'error'
                  ? '⚠'
                  : '✓'}
              </span>
              <span className="ai-step-label">{toolLabel(step.name)}</span>
              {step.detail && (
                <span className="ai-step-detail">{step.detail}</span>
              )}
              {step.status === 'done' && step.durationMs !== undefined && (
                <span className="ai-step-time">
                  {formatDuration(step.durationMs)}
                </span>
              )}
              {step.status === 'error' && step.error && (
                <span className="ai-step-error" title={step.error}>
                  {step.error.length > 60
                    ? `${step.error.slice(0, 60)}…`
                    : step.error}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default AiSteps
