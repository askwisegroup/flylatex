'use strict'

/**
 * 站点功能菜单（顶部导航里「白板 / 论文模板 / TikZ 模板」那一排）
 *
 * ---------------------------------------------------------------------------
 * 为什么要改成配置驱动（2026-11-22）
 * ---------------------------------------------------------------------------
 * 这三项原来写死在 `app/views/layout/navbar-marketing.pug` 里：每加一个临时
 * 功能（新活动页、某个灰度入口、某个临时工具）都要改模板 + 发版。而运营
 * 需要「不发版就能加一行菜单」，所以数据搬进 MongoDB，由独立仓库 carsi-mgr
 * 的「导航菜单」页维护。
 *
 * 存储契约（与 carsi-mgr 共用，改字段必须两边一起改）：
 *   库 / 集合   sharelatex / nav_menus
 *   文档 _id    portal            （web 侧硬编码，改了就找不到配置）
 *   文档字段    { items: [...] }  items 必须是数组，数组顺序 = 显示顺序
 *
 * 容错口径（写死在这里，改动前先想清楚会不会把导航整块弄没）：
 *   文档不存在            → 用代码内置的三项（= 和改造前完全一致）
 *   items: []             → 菜单为空（运营显式选择了「一个都不显示」）
 *   items 不是数组        → 同「文档不存在」，用内置三项
 *   读库抛错              → 有缓存用缓存；第一次就读不到 → 内置三项
 *   单条格式不对          → 只丢掉那一条（不整份失效），并打一条 warn
 *
 * 为什么本地还要有缓存：导航栏在每个页面都渲染，不能每次请求都查 Mongo。
 * 进程内缓存 ttlMs（默认 60s，环境变量 NAV_PORTAL_MENU_TTL_MS 可调）；
 * 过期后先用旧值渲染、后台异步刷新（stale-while-revalidate），运营保存后
 * 最多 60 秒收敛，不发版、不重启。
 */

const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')

const CONFIG = (Settings.nav && Settings.nav.portalMenu) || {}
const ENABLED = CONFIG.enabled !== false
const COLLECTION_NAME = CONFIG.collection || 'nav_menus'
const DOC_ID = CONFIG.docId || 'portal'
const DEFAULT_TTL_MS = 60 * 1000
const CACHE_TTL_MS =
  Number.isFinite(CONFIG.ttlMs) && CONFIG.ttlMs >= 0
    ? CONFIG.ttlMs
    : DEFAULT_TTL_MS
// 读库失败后的冷却时间：避免 Mongo 挂了以后每个请求都去等一次超时
const FAILURE_BACKOFF_MS = 30 * 1000

const DEFAULT_LNG = (Settings.i18n && Settings.i18n.defaultLng) || 'zh-CN'

/** 支持的 kind；`sperator` / `divider` / `hr` 都是 `separator` 的历史写法 */
const KIND_ITEM = 'item'
const KIND_GROUP = 'group'
const KIND_SEPARATOR = 'separator'
const SEPARATOR_ALIASES = new Set(['separator', 'sperator', 'divider', 'hr'])

/** 可见性：谁登录看得到。默认 any（对所有人显示），三内置项显式写了 logged-in */
const VISIBILITY_ANY = 'any'
const VISIBILITY_LOGGED_IN = 'logged-in'
const VISIBILITY_LOGGED_OUT = 'logged-out'
const VISIBILITIES = new Set([
  VISIBILITY_ANY,
  VISIBILITY_LOGGED_IN,
  VISIBILITY_LOGGED_OUT,
])

const TARGETS = new Set(['_blank', '_self'])

/**
 * 内置菜单：DB 里没配过时的兜底，必须与改造前 navbar-marketing.pug 里写死的
 * 三项**逐字等价**（链接、新开页、只对登录用户显示）。
 */
const BUILTIN_ITEMS = [
  {
    kind: KIND_ITEM,
    label: {
      en: 'Whiteboard',
      'zh-CN': '白板',
      'zh-TW': '白板',
    },
    link: '/whiteboard/index.html',
    target: '_blank',
    visibility: VISIBILITY_LOGGED_IN,
  },
  {
    kind: KIND_ITEM,
    label: {
      en: 'Paper Templates',
      'zh-CN': '论文模板',
      'zh-TW': '论文模板',
    },
    link: '/templates',
    target: '_blank',
    visibility: VISIBILITY_LOGGED_IN,
  },
  {
    kind: KIND_ITEM,
    label: {
      en: 'TikZ templates',
      'zh-CN': 'TikZ 模板',
      'zh-TW': 'TikZ 模板',
    },
    link: '/opentikz/',
    target: '_blank',
    visibility: VISIBILITY_LOGGED_IN,
  },
]

// 单机分支不可能有深到 8 层的菜单，超过就是数据被写坏了 → 截断，避免栈溢出
const MAX_DEPTH = 8

function warn(message) {
  logger.warn({ collection: COLLECTION_NAME, docId: DOC_ID }, message)
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function trimText(value) {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return ''
}

/** link 只接受站内绝对路径或 http(s) 绝对地址，防止 `javascript:` 之类的写法 */
function normalizeLink(value) {
  const link = trimText(value)
  if (!link) {
    return ''
  }
  if (link.startsWith('/')) {
    return link
  }
  if (/^https?:\/\//i.test(link)) {
    return link
  }
  return ''
}

/** 把任意写法的 label 归一成 { lngCode: 文案 } */
function normalizeLabel(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { [DEFAULT_LNG]: text } : null
  }
  if (!isObject(raw)) {
    return null
  }
  const label = {}
  for (const key of Object.keys(raw)) {
    const code = trimText(key)
    const text = trimText(raw[key])
    if (!code || !text) {
      continue
    }
    label[code] = text
  }
  return Object.keys(label).length ? label : null
}

/** 可见性：不写/写错都用 any（对所有人显示），这样漏写不会让入口消失 */
function normalizeVisibility(raw) {
  const visibility = trimText(raw).toLowerCase()
  return VISIBILITIES.has(visibility) ? visibility : VISIBILITY_ANY
}

function normalizeKind(raw, hasChildren) {
  const kind = trimText(raw && (raw.kind || raw.type)).toLowerCase()
  if (SEPARATOR_ALIASES.has(kind)) {
    return KIND_SEPARATOR
  }
  if (kind === KIND_GROUP || (!kind && hasChildren)) {
    return KIND_GROUP
  }
  return KIND_ITEM
}

/**
 * 归一 / 校验单条菜单项。返回 null 表示这条要被丢掉（绝不抛异常）。
 *
 * 未知字段一律不保留：模板只认下面这几个字段，留着只会让运营以为自己
 * 改了什么有用的东西。
 */
function normalizeItem(raw, indexOf, depth) {
  if (!isObject(raw)) {
    warn(`菜单第 ${indexOf} 条不是对象，已忽略`)
    return null
  }

  const kind = normalizeKind(raw, Array.isArray(raw.children))
  if (kind === KIND_SEPARATOR) {
    // 需求：分割线忽略其它所有字段（只保留可见性，否则登录/未登录两份菜单里
    // 都画不出这条分割线；不写 visibility = any = 两边都显示）
    return {
      kind: KIND_SEPARATOR,
      indexOf,
      visibility: normalizeVisibility(raw.visibility),
    }
  }

  const label = normalizeLabel(raw.label)
  if (!label) {
    warn(`菜单第 ${indexOf} 条缺少 label，已忽略`)
    return null
  }

  const item = { kind, label, indexOf }

  // 分组也要带可见性：它同样是摆在导航栏第一层的节点。
  // 不写 = any（登录/未登录两份清单里都出现）；漏填会让整个分组被过滤掉。
  item.visibility = normalizeVisibility(raw.visibility)

  const cssClass = trimText(raw.class)
  if (cssClass) {
    item.class = cssClass
  }
  const event = trimText(raw.event)
  if (event) {
    item.event = event
  }

  if (kind === KIND_GROUP) {
    if (depth >= MAX_DEPTH) {
      warn(`菜单第 ${indexOf} 条嵌套超过 ${MAX_DEPTH} 层，子项已截断`)
      item.children = []
    } else {
      item.children = normalizeItems(raw.children, depth + 1)
    }
  } else {
    const link = normalizeLink(raw.link)
    if (!link) {
      warn(`菜单第 ${indexOf} 条缺少可用的 link，已忽略`)
      return null
    }
    item.link = link

    // target 只认 _blank / _self；不写 = 同一个页签（浏览器默认行为）
    const target = trimText(raw.target).toLowerCase()
    if (TARGETS.has(target)) {
      item.target = target
    }
  }

  return item
}

function normalizeItems(raw, depth = 0) {
  if (!Array.isArray(raw)) {
    return []
  }
  const items = []
  raw.forEach((entry, index) => {
    const item = normalizeItem(entry, index, depth)
    if (item) {
      items.push(item)
    }
  })
  return items
}

function builtinItems() {
  return normalizeItems(BUILTIN_ITEMS)
}

/**
 * 从 Mongo 读原始 items。
 *
 * 区分「文档不存在」与「文档存在但 items 为空」是本模块的关键语义：
 * 前者回退内置三项，后者表示运营显式清空了菜单。
 *
 * @returns {Promise<Array|null>} null = 文档不存在
 */
async function readFromDb() {
  // 惰性 require：单测/静态检查环境里整个 infrastructure/mongodb 可能被 stub 掉，
  // 而它在「跑 unit 测试却连了 Mongo」时会直接 throw（见 mongodb.js 顶部守卫）。
  const { getCollectionInternal } = require('../../infrastructure/mongodb')

  const collection = await getCollectionInternal(COLLECTION_NAME)
  // 集合不存在时 findOne 返回 null，不需要预先建集合（carsi-mgr 首次保存时创建）
  const doc = await collection.findOne({ _id: DOC_ID })
  if (!doc) {
    return null
  }
  return doc.items
}

/** 供测试替换数据源（默认从 Mongo 读） */
let source = readFromDb

/** { at: number, items: Array } | null */
let cache = null
let loading = null
let lastFailureAt = 0
let warnedFailure = false

const isFresh = () => Boolean(cache) && Date.now() - cache.at < CACHE_TTL_MS

function setCache(items) {
  cache = { at: Date.now(), items }
  return cache.items
}

/**
 * 重新加载（去重：同一时刻只有一个请求在飞）。
 * 永不出错：失败时保留旧缓存；一次缓存都没有则回退内置三项。
 */
function refresh() {
  if (loading) {
    return loading
  }
  loading = (async () => {
    try {
      const raw = await source()
      const items =
        raw === null || raw === undefined
          ? builtinItems() // 文档不存在 → 内置兜底
          : Array.isArray(raw)
          ? normalizeItems(raw) // 空数组 = 运营显式清空
          : builtinItems() // 类型写错 → 内置兜底
      if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
        warn('items 不是数组，已回退到内置菜单（请在运营后台检查）')
      }
      lastFailureAt = 0
      warnedFailure = false
      return setCache(items)
    } catch (err) {
      lastFailureAt = Date.now()
      if (!warnedFailure) {
        warnedFailure = true
        logger.warn(
          { err, collection: COLLECTION_NAME, docId: DOC_ID },
          '读取站点功能菜单失败，先用缓存/内置菜单渲染'
        )
      }
      if (cache) {
        return cache.items
      }
      return builtinItems()
    } finally {
      loading = null
    }
  })()
  return loading
}

/**
 * 当前生效的菜单项（未按登录状态过滤）。
 * 缓存新鲜 → 直接返回；过期 → 先用旧值渲染并后台刷新；没有缓存 → 等一次读库。
 */
async function items() {
  if (!ENABLED) {
    return builtinItems()
  }
  if (isFresh()) {
    return cache.items
  }
  if (cache) {
    // stale-while-revalidate：不让导航栏挡住首屏
    refresh().catch(() => {})
    return cache.items
  }
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
    return builtinItems()
  }
  return refresh()
}

/** 按登录状态拆成「访客看得到的」和「登录用户看得到的」两份（顺序保持不变） */
function splitByVisibility(items) {
  const source = Array.isArray(items) ? items : []
  return {
    forGuest: source.filter(
      item =>
        item.visibility === VISIBILITY_ANY ||
        item.visibility === VISIBILITY_LOGGED_OUT
    ),
    forUser: source.filter(
      item =>
        item.visibility === VISIBILITY_ANY ||
        item.visibility === VISIBILITY_LOGGED_IN
    ),
  }
}

function firstNonEmpty(label) {
  for (const key of Object.keys(label)) {
    if (label[key]) {
      return label[key]
    }
  }
  return ''
}

/**
 * 按语言挑文案：精确匹配 → 同基础语言（zh-CN 配 zh）→ 站点默认语言 → en → 第一个非空。
 *
 * label 里存的是**各语言的显示文案**（不是 i18next 的 key）：运营加一条临时
 * 菜单时不该被迫去改 locales/*.json。
 */
function resolveLabel(label, lngCode) {
  if (typeof label === 'string') {
    return label
  }
  if (!isObject(label)) {
    return ''
  }
  const pick = code => {
    const wanted = trimText(code).toLowerCase()
    if (!wanted) {
      return ''
    }
    for (const key of Object.keys(label)) {
      if (key.toLowerCase() === wanted) {
        return label[key]
      }
    }
    return ''
  }

  const code = trimText(lngCode) || DEFAULT_LNG
  const base = code.split(/[-_]/)[0]
  return (
    pick(code) ||
    pick(base) ||
    pick(base === 'zh' ? DEFAULT_LNG : '') ||
    pick(DEFAULT_LNG) ||
    pick('en') ||
    firstNonEmpty(label)
  )
}

/** 测试用：清空缓存/数据源/冷却状态 */
function resetForTests(nextSource) {
  cache = null
  loading = null
  lastFailureAt = 0
  warnedFailure = false
  if (nextSource) {
    source = nextSource
  }
}

/** 运营保存后立刻生效用（多实例靠 TTL 收敛，见文件头说明） */
function reload() {
  cache = null
  lastFailureAt = 0
  return refresh()
}

module.exports = {
  COLLECTION_NAME,
  DOC_ID,
  KIND_ITEM,
  KIND_GROUP,
  KIND_SEPARATOR,
  VISIBILITY_ANY,
  VISIBILITY_LOGGED_IN,
  VISIBILITY_LOGGED_OUT,
  BUILTIN_ITEMS: builtinItems,
  items,
  normalizeItems,
  resolveLabel,
  splitByVisibility,
  reload,
  resetForTests,
}
