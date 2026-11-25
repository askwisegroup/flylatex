import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

/**
 * FIXED: 2026-11-16 线上事故回归测试。
 *
 * 事故经过：页签组件用了 `useEditorManagerContext()` —— 那是 **React IDE 专属** Context。
 * 旧版（Angular）编辑器页面的 Provider 树是 ContextRoot，里面只有 EditorProvider，
 * 没有 EditorManagerProvider/MetadataProvider 等，于是「打开任何项目」都抛
 * `useEditorManagerContext is only available inside EditorManagerProvider`，
 * 被编辑器错误边界接住，整页变成「抱歉，出错了」。所有项目全挂。
 *
 * 这个测试不渲染组件（那要搭半棵树），而是直接盯住最容易再犯的地方：
 * **这两个目录里不许 import 任何 `features/ide-react/context/*`**。
 * util/ 与 types/ 下的纯函数可以用（它们不依赖 Provider）。
 */

const FORBIDDEN =
  /from\s+['"](@\/features\/ide-react|\.\.?\/.*ide-react)\/context\//

const FEATURE_DIRS = [
  'frontend/js/features/editor-tabs',
  'frontend/js/features/comment-bar',
]

function listSourceFiles(dir) {
  const full = path.join(process.cwd(), dir)
  if (!fs.existsSync(full)) {
    return []
  }
  const files = []
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(child))
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(child)
    }
  }
  return files
}

describe('editor-tabs / comment-bar 的 Provider 依赖', function () {
  it('不允许依赖 React IDE 专属 Context（两棵树都要能跑）', function () {
    const offenders = []

    for (const dir of FEATURE_DIRS) {
      for (const file of listSourceFiles(dir)) {
        const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
        source.split('\n').forEach((line, index) => {
          if (FORBIDDEN.test(line)) {
            offenders.push(`${file}:${index + 1}  ${line.trim()}`)
          }
        })
      }
    }

    expect(
      offenders,
      `这两个组件会被挂进旧版（Angular）编辑器，那里没有 EditorManagerProvider。\n` +
        `要用 useIdeContext() / useScopeValue() / useEditorContext() 这类两棵树共有的入口：\n` +
        offenders.join('\n')
    ).to.deep.equal([])
  })

  it('入口组件有静默错误边界（再出问题只降级，不连累编辑器）', function () {
    for (const file of [
      'frontend/js/features/editor-tabs/editor-tabs-bar.tsx',
      'frontend/js/features/comment-bar/comment-bar.tsx',
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      expect(source, `${file} 应该用 withErrorBoundary 包一层`).to.include(
        'withErrorBoundary'
      )
    }
  })
})
