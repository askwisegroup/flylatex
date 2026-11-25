#!/usr/bin/env node
/**
 * 主题自检：确认「主色调 / 亮色调 / 柔和色调」三套样式表都能编译，且关键外壳色真的不同。
 *
 * 用法（在 services/web 下）：
 *   node scripts/check_themes.js            # 只检查旧版体系（style / light-style / soft-style）
 *   node scripts/check_themes.js --all      # 连新版体系（main-*）一起检查
 *
 * 为什么要有这个脚本：
 *   主题是"每个主题各编译一份 CSS"，任何一处把颜色写死回 #2c3645，
 *   都会让某个主题出现一块不属于它的深蓝色，而这种问题在单页面上很难肉眼发现。
 *   这里把三个入口分别编译，断言同一选择器在不同主题下取到不同的值。
 *
 * 找不到 lessc 时以 2 退出（跳过），不阻塞 CI。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const STYLESHEETS_DIR = path.join(__dirname, '..', 'frontend', 'stylesheets')
const REPO_ROOT = path.join(__dirname, '..', '..', '..')

const THEMES = [
  {
    name: '主色调',
    entry: 'style',
    chromeBg: '#2c3645',
    accent: '#3e70bb',
    darkHeader: true,
  },
  {
    name: '亮色调',
    entry: 'light-style',
    chromeBg: '#fff',
    accent: '#3e70bb',
    darkHeader: false,
  },
  {
    name: '柔和色调',
    entry: 'soft-style',
    chromeBg: '#efeadd',
    accent: '#c15f3c',
    darkHeader: false,
  },
]

const MAIN_THEMES = [
  {
    name: '主色调(main)',
    entry: 'main-style',
    chromeBg: '#2c3645',
    darkHeader: true,
  },
  {
    name: '亮色调(main)',
    entry: 'main-light-style',
    chromeBg: '#fff',
    darkHeader: false,
  },
  {
    name: '柔和色调(main)',
    entry: 'main-soft-style',
    chromeBg: '#efeadd',
    darkHeader: false,
  },
]

function findLessc() {
  const candidates = [
    process.env.LESSC,
    path.join(REPO_ROOT, 'node_modules', '.bin', 'lessc'),
    path.join(__dirname, '..', 'node_modules', '.bin', 'lessc'),
  ].filter(Boolean)
  return candidates.find(p => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** 取某个选择器块里 background-color 的第一个值 */
function bgOf(css, selector) {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) return null
  const block = css.slice(start, css.indexOf('\n}', start))
  const m = block.match(/background-color:\s*([^;]+);/)
  return m ? m[1].trim() : null
}

/** 取某个选择器块里某个属性的第一个值 */
function propOf(css, selector, prop) {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) return null
  const block = css.slice(start, css.indexOf('\n}', start))
  const m = block.match(new RegExp(`${prop}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

/** #e4e8ee 这种接近纯白的颜色，在浅色底上等于隐身 */
function isNearWhite(value) {
  if (!value) return false
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!hex) return false
  let h = hex[1]
  if (h.length === 3)
    h = h
      .split('')
      .map(c => c + c)
      .join('')
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
  return r >= 0xe0 && g >= 0xe0 && b >= 0xe0
}

function compile(lessc, entry) {
  return execFileSync(lessc, [`${entry}.less`], {
    cwd: STYLESHEETS_DIR,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  })
}

function main() {
  const lessc = findLessc()
  if (!lessc) {
    console.log('跳过：找不到 lessc（可设置 LESSC=/path/to/lessc）')
    process.exit(2)
  }

  const checkAll = process.argv.includes('--all')
  const themes = checkAll ? [...THEMES, ...MAIN_THEMES] : THEMES

  let failed = 0
  const seen = new Map()

  for (const theme of themes) {
    let css
    try {
      css = compile(lessc, theme.entry)
    } catch (err) {
      console.error(
        `✗ ${theme.name}: 编译失败\n${err.message
          .split('\n')
          .slice(0, 5)
          .join('\n')}`
      )
      failed++
      continue
    }

    const barBg = bgOf(css, '.ide-menu-bar')
    const ok = barBg === theme.chromeBg
    if (!ok) {
      console.error(
        `✗ ${theme.name}: .ide-menu-bar 背景应为 ${theme.chromeBg}，实际 ${barBg}`
      )
      failed++
      continue
    }
    if (theme.accent && !css.includes(theme.accent)) {
      console.error(`✗ ${theme.name}: 输出里找不到强调色 ${theme.accent}`)
      failed++
      continue
    }
    // 顶栏是浅色的主题里，这几处颜色历史上都是"给深色顶栏写的近白色"，
    // 一旦谁再把它们写死回去，整块 UI 就变成白底白字（项目列表页踩过）
    if (theme.darkHeader === false) {
      const checks = [
        ['.navbar-title', 'color', '顶栏 FlyLaTeX 字标'],
        [
          '.project-list-react ul.project-list-filters > li > button',
          'color',
          '项目列表左侧筛选菜单',
        ],
      ]
      for (const [selector, prop, label] of checks) {
        const value = propOf(css, selector, prop)
        if (isNearWhite(value)) {
          console.error(
            `✗ ${theme.name}: ${label} 仍是近白色 ${value}（浅色底上看不见）`
          )
          failed++
        }
      }
      const gradient = propOf(css, '.navbar-default', 'background-image')
      if (gradient && gradient !== 'none') {
        console.error(
          `✗ ${theme.name}: 顶栏还在用品牌渐变 ${gradient}（应为 none，用纯色）`
        )
        failed++
      }
    }

    seen.set(theme.name, barBg)
    console.log(`✓ ${theme.name}: .ide-menu-bar = ${barBg}`)
  }

  // 同一体系内三套主题的外壳色必须互不相同，否则等于没做多主题
  // （旧版 style.less 与新版 main-style.less 的取值本来就一样，分组比较）
  for (const group of ['legacy', 'main']) {
    const entries = [...seen.entries()].filter(([name]) =>
      group === 'main' ? name.endsWith('(main)') : !name.endsWith('(main)')
    )
    const distinct = new Set(entries.map(([, bg]) => bg))
    if (entries.length > 1 && distinct.size !== entries.length) {
      console.error(
        `✗ ${group} 体系里主题外壳色重复：${JSON.stringify(entries)}`
      )
      failed++
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} 项检查失败`)
    process.exit(1)
  }
  console.log('\n主题检查通过')
}

main()
