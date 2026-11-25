import type { OverallTheme } from '../../source-editor/extensions/theme'

/**
 * 全局主题与编辑器（语法高亮）主题的对应关系。
 *
 * 两套主题是独立的设置项：`overallTheme` 决定外壳配色（导航条/工具栏/面板），
 * `editorTheme` 决定代码区的配色。以前只能靠用户自己碰运气搭配，经常出现
 * "暖色外壳 + 冷白代码区"这种不协调的组合。
 *
 * 这里给出每个全局主题的推荐编辑器主题，切换全局主题时会自动带上；
 * 用户之后手动改编辑器主题不会被覆盖（见 use-user-wide-settings.tsx 里的判断）。
 *
 * FIXED: 2026-11-05 导航栏也有一个「全局主题」快捷切换（navbar-marketing.pug），
 * 它没法引用这个 TS 模块，所以服务端在 ExpressLocals 里按同一张表算出
 * "选中该主题时要一并保存的编辑器主题"，两处改动请保持一致。
 */
export const DEFAULT_EDITOR_THEME = 'textmate'

export const recommendedEditorTheme: Record<OverallTheme, string> = {
  // 主色调：深色外壳 + 白色代码区 —— 用经典的 textmate（默认值）
  '': 'textmate',
  // 亮色调：白底蓝调界面 —— eclipse 的冷蓝高亮更贴
  'light-': 'eclipse',
  // 柔和色调：米白纸感 + 陶土橙 —— 专用主题，代码区底色与页面同为 #faf9f5
  'soft-': 'soft',
}

/**
 * FIXED: 2026-11-05 抽出「切全局主题时该不该顺带改编辑器主题」的判断，
 * 让编辑器设置面板和项目列表页的快捷切换共用同一套规则，避免两处行为不一致。
 *
 * 返回 undefined 表示不需要改动编辑器主题。
 */
export function getPairedEditorTheme(
  currentEditorTheme: string | undefined,
  currentOverallTheme: OverallTheme | undefined,
  nextOverallTheme: OverallTheme
): string | undefined {
  // 当前编辑器主题未知（例如老 session 快照里没有这个字段）时不动它，
  // 否则会把用户自定义的编辑器主题覆盖掉。
  if (currentEditorTheme == null) {
    return undefined
  }

  const previousRecommended =
    recommendedEditorTheme[currentOverallTheme ?? ''] ?? DEFAULT_EDITOR_THEME
  const nextRecommended = recommendedEditorTheme[nextOverallTheme]
  const userHasCustomEditorTheme = currentEditorTheme !== previousRecommended

  if (
    !userHasCustomEditorTheme &&
    nextRecommended &&
    currentEditorTheme !== nextRecommended
  ) {
    return nextRecommended
  }

  return undefined
}
