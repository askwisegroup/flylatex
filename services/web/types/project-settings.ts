import { OverallTheme } from '../frontend/js/features/source-editor/extensions/theme'
import { Brand } from './helpers/brand'

export type AllowedImageName = {
  imageDesc: string
  imageName: string
}

export type DocId = Brand<string, 'DocId'>
export type MainDocument = {
  doc: {
    name: string
    id: DocId
    type: string
    selected: boolean
  }
  path: string
}

export type ProjectCompiler = 'pdflatex' | 'latex' | 'xelatex' | 'lualatex'

export type Keybindings = 'default' | 'vim' | 'emacs'

/**
 * FIXED: 2026-10-30 AI 面板展示位置。
 * side   = 右侧面板（覆盖 PDF 预览区，默认，沿用原行为）
 * bottom = 底部停靠，横跨编辑器 + 预览，可拖动调节高度
 *
 * FIXED: 2026-11-13 新增 modal（居中弹窗）。
 * 动机：批注面板（review panel）要占右侧/底部，AI 面板再挤就没有位置了。
 * 语义是「真模态」：
 *   - 水平/垂直居中，PC 端宽度 50%（移动端维持原有全屏浮层）；
 *   - 点遮罩不关闭，Esc 也不关闭，只有面板上的 ✕（或工具栏按钮）才关；
 *   - 遮罩吞掉点击，打开期间不与编辑器争焦点。
 * 批注功能落地后，打开批注即可把 AI 面板默认切到 modal。
 */
export type AIPanelLayout = 'side' | 'bottom' | 'modal'

/**
 * FIXED: 2026-11-01 设置的显示方式。
 * left  = 点「文件 - 设置」时从左侧展开面板（默认，沿用原行为）
 * modal = 居中弹出大弹窗，设置项按分类展示
 */
export type SettingsPanelMode = 'left' | 'modal'

/** 搜索/替换面板位置：'bottom'（编辑器底部，默认，现状）| 'top'（顶部） */
export type SearchPanelPosition = 'top' | 'bottom'

/**
 * FIXED: 2026-11-06 导航栏是否显示项目/文章标题。
 * false = 不显示（默认，沿用原行为）；true = 在菜单之后显示标题。
 */
export type NavbarShowTitle = boolean

export type OverallThemeMeta = {
  name: string
  // 本地化名称的翻译 key，缺省时回退到 name
  nameKey?: string
  path: string
  val: OverallTheme
}

export type PdfViewer = 'pdfjs' | 'native'

export type SpellCheckLanguage = {
  name: string
  code: string
}
