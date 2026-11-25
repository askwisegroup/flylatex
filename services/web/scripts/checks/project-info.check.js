/**
 * 「项目信息」弹窗（编辑器里改项目名称 / 标签）的静态检查
 *
 * 需求背景：进了项目就想看到名称和标签，改标签不用退回项目列表；
 * 但编辑入口要收在弹窗里（工具条上摊输入框在窄屏必然挤爆）。
 *
 * 这些点错了都不会报错，只会在浏览器里表现为「标签不显示 / 点保存 403 /
 * 显示裸 key / 改了标签刷新又没了」，所以钉成脚本：
 *
 *   1. 接线：顶部两种 header 分支都渲染了药丸 + 弹窗，文件菜单有入口
 *   2. 接口：hook 用的 /tag 端点在 router.js 里真的存在
 *   3. CSRF：请求走 infrastructure/fetch-json，不能手写 fetch
 *   4. 一致性：乐观更新失败必须回滚（否则界面和服务端各说各话）
 *   5. i18n：所有 key 在 4 个语言 + extracted-translations.json 里都有
 *
 * Run: cd services/web && node scripts/checks/project-info.check.js
 */

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '../..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const COMPONENT_DIR = 'frontend/js/features/editor-navigation-toolbar'
const FILES = {
  hook: `${COMPONENT_DIR}/hooks/use-project-tags.ts`,
  pills: `${COMPONENT_DIR}/components/project-tags-pills.tsx`,
  modal: `${COMPONENT_DIR}/components/project-info-modal.jsx`,
  header: `${COMPONENT_DIR}/components/toolbar-header.jsx`,
  less: 'frontend/stylesheets/app/editor/toolbar.less',
}

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${err.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const LANG = ['en', 'zh-CN', 'zh-TW', 'ru']
const locales = {}
const whitelist = JSON.parse(read('frontend/extracted-translations.json'))
for (const lang of LANG) {
  locales[lang] = JSON.parse(read(`locales/${lang}.json`))
}

console.log('project info (项目名称/标签) checks')

// ---------------------------------------------------------------- 文件存在
check('三个新文件都在', () => {
  for (const key of ['hook', 'pills', 'modal']) {
    assert(fs.existsSync(path.join(root, FILES[key])), `${FILES[key]} 不存在`)
  }
})

// ---------------------------------------------------------------- 接线
check('顶部两种 header 分支都渲染了标签药丸', () => {
  const src = read(FILES.header)
  const occurrences = (src.match(/<ProjectTagsPills/g) || []).length
  assert(
    occurrences === 2,
    `ProjectTagsPills 应渲染 2 次（IDE 菜单栏 / 经典），实际 ${occurrences}`
  )
  assert(
    /import ProjectTagsPills from '\.\/project-tags-pills'/.test(src),
    'toolbar-header 没 import ProjectTagsPills'
  )
  // 两个分支都要把药丸包在 .toolbar-center 里，否则会跑到工具条左边
  assert(
    (src.match(/toolbar-center project-title-bar/g) || []).length === 2,
    '两个 header 分支都应把名称 + 标签放在同一个 .toolbar-center 容器里'
  )
})

check('两种 header 分支都渲染了「项目信息」弹窗', () => {
  const src = read(FILES.header)
  assert(
    (src.match(/\{projectInfoModal\}/g) || []).length === 2,
    '弹窗组件应在两个 header 分支里各渲染一次'
  )
  assert(
    /import ProjectInfoModal from '\.\/project-info-modal'/.test(src),
    'toolbar-header 没 import ProjectInfoModal'
  )
})

check('文件菜单里有「项目信息」入口（编辑入口收在菜单里）', () => {
  const src = read(FILES.header)
  assert(
    /onClick=\{onOpenProjectInfo\}/.test(src),
    '文件菜单的「项目信息」没有 onClick={onOpenProjectInfo}'
  )
  assert(
    /onOpenProjectInfo: PropTypes\.func/.test(src),
    'IdeMenuBar 的 propTypes 里没有 onOpenProjectInfo'
  )
})

check('工具条上不摊输入框（编辑只在弹窗里）', () => {
  const pills = read(FILES.pills)
  assert(
    !/<input|<textarea/.test(pills),
    `${FILES.pills} 里不该出现 input/textarea（会挤坏工具条）`
  )
  // 工具条中间那一块只有「名称（只读）+ 药丸」，输入框都在弹窗里
  const header = read(FILES.header)
  const centre = header.slice(
    header.indexOf('project-title-bar'),
    header.indexOf('</div>', header.indexOf('project-title-bar'))
  )
  assert(!/<input|<textarea/.test(centre), 'toolbar-center 里出现了输入框')
  assert(
    /<input/.test(read(FILES.modal)),
    'project-info-modal 里应该有可以改名字的 input'
  )
})

check('标签药丸有数量上限和窄屏降级', () => {
  const pills = read(FILES.pills)
  assert(/const MAX_PILLS = \d+/.test(pills), '药丸没有数量上限')
  assert(/hiddenCount > 0/.test(pills), '超出上限的标签应折叠成 +N')
  const less = read(FILES.less)
  assert(
    /\.project-tags-pill\s*\{[\s\S]*?display: none/.test(less) ||
      /@media[^{]*\{\s*\.project-tags-pill\s*\{[\s\S]*?display: none/.test(
        less
      ),
    '窄屏时应隐藏药丸（只留编辑按钮）'
  )
})

// ---------------------------------------------------------------- 接口
check('hook 用到的 /tag 端点在 router.js 里都存在', () => {
  const hook = read(FILES.hook)
  const router = read('app/src/router.js')
  assert(hook.includes("getJSON('/tag')"), '读标签应该用 GET /tag')
  assert(hook.includes("postJSON('/tag'"), '新建标签应该用 POST /tag')
  assert(
    hook.includes('`/tag/${tagId}/projects`'),
    '打标签应该用 POST /tag/:tagId/projects'
  )
  assert(
    hook.includes('`/tag/${tagId}/project/${projectId}`'),
    '去标签应该用 DELETE /tag/:tagId/project/:projectId'
  )

  const routes = [
    "'/tag',",
    "'/tag/:tagId/projects',",
    "'/tag/:tagId/project/:projectId',",
  ]
  for (const route of routes) {
    assert(router.includes(route), `router.js 里找不到路由: ${route}`)
  }
  assert(
    /webRouter\.delete\(\s*'\/tag\/:tagId\/project\/:projectId'/.test(router),
    'router.js 里找不到 DELETE /tag/:tagId/project/:projectId'
  )
})

check('改名复用 editor context 的 renameProject（不另开一条写接口）', () => {
  const modal = read(FILES.modal)
  assert(/onRename\(trimmedName\)/.test(modal), '改名应该调用传进来的 onRename')
  assert(
    !/\/rename/.test(modal),
    '弹窗不该自己打 /project/:id/rename（会和 context 里的名字状态打架）'
  )
  assert(
    /onRename=\{renameProject\}/.test(read(FILES.header)),
    'toolbar-header 应该把 context 的 renameProject 传进弹窗'
  )
})

// ---------------------------------------------------------------- CSRF
check('请求走 fetch-json（自动带 CSRF token），不手写 fetch', () => {
  for (const key of ['hook', 'modal']) {
    const src = read(FILES[key])
    if (key === 'hook') {
      assert(
        /from '\.\.\/\.\.\/\.\.\/infrastructure\/fetch-json'/.test(src),
        'hook 必须从 infrastructure/fetch-json 导入请求函数'
      )
      assert(
        !/window\.fetch\(|\bfetch\(/.test(src),
        'hook 里不要手写 fetch（会漏 X-CSRF-Token，写请求直接 403）'
      )
    }
  }
})

// ---------------------------------------------------------------- 回滚
check('乐观更新失败后会回滚', () => {
  const hook = read(FILES.hook)
  const addTag = hook.slice(
    hook.indexOf('const addTag'),
    hook.indexOf('const removeTag')
  )
  const removeTag = hook.slice(
    hook.indexOf('const removeTag'),
    hook.indexOf('const createAndAddTag')
  )
  assert(
    /patchTag\(tagId, true\)[\s\S]*catch[\s\S]*patchTag\(tagId, false\)/.test(
      addTag
    ),
    'addTag 失败没有回滚本地状态'
  )
  assert(
    /patchTag\(tagId, false\)[\s\S]*catch[\s\S]*patchTag\(tagId, true\)/.test(
      removeTag
    ),
    'removeTag 失败没有回滚本地状态'
  )
})

// ---------------------------------------------------------------- i18n
check('用到的 i18n key 在 4 个语言 + 白名单里都有', () => {
  const used = new Set()
  for (const key of ['pills', 'modal', 'header']) {
    const src = read(FILES[key])
    for (const [, name] of src.matchAll(/\bt\('([a-z0-9_]+)'\)/g)) {
      used.add(name)
    }
  }
  // 只校验本需求新增的 key，历史 key（rename_project 等）另有检查兜着
  const mine = [...used].filter(k => k.startsWith('project_info'))
  assert(
    mine.length >= 8,
    `project_info* key 只找到 ${mine.length} 个，疑似替换丢了`
  )

  for (const name of mine) {
    assert(
      name in whitelist,
      `extracted-translations.json 缺 ${name}（前端会回落英文）`
    )
    for (const lang of LANG) {
      const value = locales[lang][name]
      assert(typeof value === 'string' && value, `${lang}.json 缺 ${name}`)
      assert(value !== name, `${lang}.json 的 ${name} 值等于 key`)
      if (lang === 'ru') {
        assert(
          !/[\u4e00-\u9fff]/.test(value),
          `ru.json 的 ${name} 里出现汉字：${value}`
        )
      }
    }
    // 中文长句两版不能完全一样（否则等于没翻繁中）
    const zhCN = locales['zh-CN'][name]
    const zhTW = locales['zh-TW'][name]
    if (zhCN.length > 4) {
      assert(zhCN !== zhTW, `zh-TW 与 zh-CN 的 ${name} 完全相同：${zhCN}`)
    }
  }
})

// ---------------------------------------------------------------- 匿名防护
check('匿名只读（无登录用户）不打标签接口', () => {
  const hook = read(FILES.hook)
  assert(/getMeta\('ol-user_id'\)/.test(hook), 'hook 没有读 ol-user_id')
  assert(
    /if \(projectId && canEdit\)/.test(hook),
    '没有用户时不该调 GET /tag（必然被踢到登录页）'
  )
  assert(
    /canEdit=\{projectTags\.canEdit\}/.test(read(FILES.header)),
    'toolbar-header 没把 canEdit 传给药丸（匿名下会冒出无效的编辑按钮）'
  )
})

// ---------------------------------------------------------------- 权限
check('改名按钮受 hasRenamePermissions 约束', () => {
  const modal = read(FILES.modal)
  assert(/disabled=\{!canRename/.test(modal), '改名输入/按钮没有按权限禁用')
  const header = read(FILES.header)
  assert(
    /hasRenamePermissions=\{hasRenamePermissions\}/.test(header),
    'toolbar-header 没把权限传给弹窗'
  )
})

if (failures.length) {
  console.error(`\n${failures.length} 项检查失败：`)
  for (const name of failures) {
    console.error(`  - ${name}`)
  }
  process.exit(1)
}

console.log('\nALL PASS')
