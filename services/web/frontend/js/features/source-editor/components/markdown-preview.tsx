import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import useDebounce from '../../../shared/hooks/use-debounce'
import { MathJaxMarkdown } from '../../../shared/components/mathjax-markdown'
import EditorSwitch from './editor-switch'
import AIChatToggleButton from './ai-chat-toggle-button'
import Icon from '../../../shared/components/icon'
import { debugConsole } from '@/utils/debugging'

type ShareJsDocLike = {
  doc?: {
    on?: (event: string, handler: () => void) => void
    off?: (event: string, handler: () => void) => void
  }
  getSnapshot: () => string | undefined
}

const snapshot = (target: ShareJsDocLike | null): string =>
  target?.getSnapshot?.() ?? ''

/**
 * FIXED: 2026-11-08 把预览正文抽成独立组件，供两处共用：
 *   1) MarkdownPreview（doc 的可视化编辑器，绝对定位盖住 CodeMirror）
 *   2) file-view（存成 file 实体的 .md，在文件视图里直接显示）
 * 同一个 .markdown-preview-body + 同一套样式 + 同一份链接/空文档处理，
 * 不存在第二套 Markdown 排版。这里不读任何 Angular scope，所以两处都能用。
 */
export function MarkdownPreviewBody({ markdown }: { markdown: string }) {
  const { t } = useTranslation()

  // 预览里点链接：外链已经由 renderMarkdown 加了 target=_blank；
  // 站内相对链接如果在 IDE 里直接跳转，会把用户从编辑器带走，所以拦下来。
  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (/^(https?:)?\/\//i.test(href) || href.startsWith('mailto:')) return
    event.preventDefault()
    debugConsole.log('[markdown-preview] 忽略站内/相对链接', href)
  }, [])

  const empty = useMemo(() => markdown.trim() === '', [markdown])

  return (
    // tabIndex 让这一块可以接收焦点，PageUp/PageDown、方向键能正常滚动
    <div className="markdown-preview-body" tabIndex={0} onClick={handleClick}>
      {empty ? (
        <p className="markdown-preview-empty">
          {t('markdown_preview_empty', {
            defaultValue: '这个 Markdown 文档还没有内容',
          })}
        </p>
      ) : (
        <MathJaxMarkdown markdown={markdown} sanitize />
      )}
    </div>
  )
}

/**
 * FIXED: 2026-11-08 Markdown 的「可视化编辑器」视图（只读浏览）。
 *
 * 需求：`.md` 也能切到可视化编辑器，但可视化编辑器本身是 LaTeX 的所见即所得
 * （CM6 的 rich-text 扩展），套在 Markdown 上会把内容显示成一团源码。
 * 折衷方案：`.md` 在这个模式下提供一个**只读渲染视图**，顶部一行小提示说明
 * 「浏览模式，要改请切回代码编辑器」；表格 / 链接 / 公式都正常渲染，配色跟随主题。
 *
 * 内容来源：editor.sharejs_doc（ShareJS 文档），订阅其 change 事件实时刷新，
 * 输入侧没有写入，所以不存在「预览里改了但没同步」的问题。
 */
type MarkdownPreviewProps = {
  /**
   * FIXED: 2026-11-08 传入 markdown 时，同一个视图用于 file-view 里的 .md：
   * 内容来自文件本身，文件不能编辑，所以开关只显示「可视化编辑器」选中、不可切换。
   * 除此之外与 doc 的可视化编辑器是同一份代码、同一套样式。
   */
  markdown?: string
  /**
   * FIXED: 2026-11-08 文件视图里要能下载这个文件，直接放进这条工具条
   * （AI 按钮左边），不再单独占一行。
   */
  downloadUrl?: string
}

export function MarkdownPreview({
  markdown,
  downloadUrl,
}: MarkdownPreviewProps = {}) {
  const { t } = useTranslation()
  const fromFile = typeof markdown === 'string'
  const [doc] = useScopeValue<ShareJsDocLike | null>('editor.sharejs_doc')
  const [text, setText] = useState<string>(() => snapshot(doc))

  // 文档内容变化 → 更新源码文本（做一次 120ms 去抖，连续输入不重复排版）
  useEffect(() => {
    if (!doc) {
      setText('')
      return
    }
    setText(snapshot(doc))

    const inner = doc.doc
    if (!inner || typeof inner.on !== 'function') return

    const onChange = () => setText(snapshot(doc))
    inner.on('change', onChange)
    return () => {
      inner.off?.('change', onChange)
    }
  }, [doc])

  // 进入浏览模式时把焦点从下面的 CodeMirror 拿走：
  // 编辑器只是被覆盖，如果它还留着焦点，用户敲键盘就会改到看不见的文档里。
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && active.closest && active.closest('.cm-editor')) {
      active.blur()
    }
  }, [])

  const debouncedText = useDebounce(text, 120)
  const sourceText = fromFile ? markdown : debouncedText

  // FIXED: 2026-11-08 定位/尺寸用内联样式（和 .markdown-preview 里的规则一致）。
  // 只把「必须盖住编辑器」这件事做成内联，样式表只负责配色：
  // 样式表一旦没重新构建（漏跑 webpack）或浏览器不支持某条声明，覆盖层就会
  // 退化成普通块元素被编辑器挤到可视区外——现象是「点了可视化编辑器还是代码界面」。
  return (
    <div
      className="markdown-preview"
      style={
        // FIXED: 2026-11-08 两种场景的容器行为不同：
        //   编辑器里 = 绝对定位覆盖层（盖住 CodeMirror）
        //   文件视图里 = 普通定位，工具条与正文分成两块：
        //                工具条 flex: 0 0 auto 固定，正文 flex: 1 1 auto + overflow:auto
        //                自己就是那个独立滚动容器（见 file-view.less）
        fromFile
          ? // 只用 CSS 里既有的 flex 纵向布局（display:flex / flex-direction:column /
            // overflow:hidden），这里仅把「绝对定位覆盖层」换成普通定位
            { position: 'relative' }
          : {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              // 底色也给个兜底（默认/浅色/柔和三套主题的 @fl-surface 都接近白色）
              backgroundColor: '#fff',
            }
      }
    >
      {/*
        FIXED: 2026-11-08 提示条做成 TeX 工具条的样子：同一套背景/高度/字体，
        并且直接复用真的 EditorSwitch（就是工具条上那个「代码编辑器 | 可视化编辑器」
        开关）。两个理由：
          1. 预览整层盖住了编辑器，而工具条是 CM6 的 panel（属于编辑器 DOM），
             不在这里放一个开关，用户就没有「切回去」的入口；
          2. 复用同一个组件 + 同一套主题变量，多主题下观感与 TeX 工具条完全一致，
             不会有一块「外来控件」的突兀感。
      */}
      <div className="markdown-preview-hint" role="note">
        {/* 文件视图里开关只显示状态（可视化编辑器），不响应点击 */}
        <EditorSwitch readOnly={fromFile} />
        <span className="markdown-preview-hint-text">
          {fromFile
            ? t('markdown_preview_file_readonly_hint', {
                defaultValue: '此文件为 Markdown，仅支持浏览',
              })
            : t('markdown_preview_readonly_hint', {
                defaultValue:
                  'Markdown 文档在可视化编辑器中仅支持浏览，如需修改请切换到「代码编辑器」',
              })}
        </span>
        {downloadUrl && (
          <a
            download
            href={downloadUrl}
            className="markdown-preview-download"
            title={t('download')}
          >
            <Icon type="download" fw />
            <span>{t('download')}</span>
          </a>
        )}
        {/* 右侧复用 TeX 工具条那颗 AI 助手按钮（同一个组件，主题一致） */}
        <AIChatToggleButton />
      </div>
      <MarkdownPreviewBody markdown={sourceText} />
    </div>
  )
}

export default MarkdownPreview
