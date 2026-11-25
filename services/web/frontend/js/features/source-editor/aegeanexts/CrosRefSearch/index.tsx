// @ts-nocheck
import React, {
  memo,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { detectBibliographySetup as detectBibSetup } from './bib-setup'
// FIXED: 2026-11-17 内存过滤抽到 zotero-filter.ts（可单测），组件里只留一行 useMemo
import { filterZoteroItems } from './zotero-filter'
import { useCodeMirrorViewContext } from '../../components/codemirror-editor'
import { ToolbarButton } from '../../components/toolbar/toolbar-button'
import {
  Modal,
  Button,
  FormGroup,
  FormControl,
  Radio,
  Alert,
  Table,
} from 'react-bootstrap'
import AccessibleModal from '@/shared/components/accessible-modal'
import { getJSON } from '@/infrastructure/fetch-json'
import { useTranslation } from 'react-i18next'

// FIXED: 2026-11-17 Zotero 列表一次拉多少条（服务端上限 500，见 ZoteroApiClient），
//   一条 metadata 只有几百字节，一次拉下来在前端做「输入即过滤」，比每敲一个字一个网络往返干净。
//   过滤逻辑见 ./zotero-filter.ts
const ZOTERO_PAGE_LIMIT = 200

// Helper function to get user email from meta tag
function getUserEmail() {
  const metaElement = document.head?.querySelector(
    'meta[name="ol-usersEmail"]'
  ) as HTMLMetaElement
  return metaElement?.content
}

// Custom fetch function for CrossRef API
async function customPostJSON(path: string, body: any) {
  const userEmail = getUserEmail()

  if (!userEmail) {
    throw new Error('User email not found. Please login first.')
  }

  // 在请求体中包含用户邮箱
  const requestBody = {
    ...body,
    userEmail: userEmail,
  }

  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  return await response.json()
}

interface ReferenceItem {
  hash_id: string
  title: string[]
  title_text: string[]
  authors: string[]
  year: number
  container_title: string[]
  container_title_text: string[]
  abstract: string
  abstract_text: string
  type: string
  url: string
  volume: string
  issue: string
  page: string
}

interface SearchResponse {
  code: number
  message: string
  data: {
    items: ReferenceItem[]
    pagination: {
      current: number
      page_size: number
      total: number
    }
  }
}

const ABSTRACT_PREVIEW_CHAR_LIMIT = 160
const AUTHORS_PREVIEW_CHAR_LIMIT = 80
const JOURNAL_PREVIEW_CHAR_LIMIT = 80
const TABLE_COLUMN_WIDTHS = {
  select: '3.5rem',
  title: '38%',
  authors: '18%',
  year: '8%',
  journal: '22%',
  volume: '14%',
}

const TABLE_CONTAINER_STYLE = {
  // FIXED: 2026-11-17 这里原来死写 maxHeight: '400px' ——
  //   屏幕高时浪费空间，屏幕矮时（笔记本 768px）照样把「关闭」按钮顶出视口。
  //   现在高度由弹窗的 flex 布局分配（见 stylesheets/app/editor/crosref-search.less），
  //   表头 sticky 固定，只有这张表内部滚动；maxHeight 仅作非 flex 排版时的兜底。
  flex: '1 1 auto',
  minHeight: '120px',
  maxHeight: 'calc(100vh - 260px)',
  overflowY: 'auto' as const,
  overflowX: 'hidden' as const,
  border: '1px solid var(--fl-border, #ddd)',
}

const TABLE_STYLE = {
  margin: 0,
  fontSize: '13px',
  tableLayout: 'fixed',
  width: '100%',
}

const COLUMN_HEADER_STYLES = {
  select: {
    width: TABLE_COLUMN_WIDTHS.select,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  title: { width: TABLE_COLUMN_WIDTHS.title, whiteSpace: 'nowrap' },
  authors: { width: TABLE_COLUMN_WIDTHS.authors, whiteSpace: 'nowrap' },
  year: {
    width: TABLE_COLUMN_WIDTHS.year,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  journal: { width: TABLE_COLUMN_WIDTHS.journal, whiteSpace: 'nowrap' },
  volume: {
    width: TABLE_COLUMN_WIDTHS.volume,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
}

const TITLE_CELL_STYLE = {
  fontSize: '12px',
  lineHeight: '1.4',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
  whiteSpace: 'normal',
  verticalAlign: 'top',
}

const TEXT_CELL_STYLE = {
  fontSize: '12px',
  whiteSpace: 'normal',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
  verticalAlign: 'top',
}

const YEAR_CELL_STYLE = {
  textAlign: 'center',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
}

const VOLUME_CELL_STYLE = {
  fontSize: '12px',
  textAlign: 'center',
  whiteSpace: 'normal',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
  verticalAlign: 'top',
}

const ABSTRACT_PREVIEW_STYLE = {
  color: 'var(--fl-text-muted, #666)',
  fontSize: '11px',
  marginTop: '4px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  lineHeight: '1.4',
}

function truncateText(text, limit) {
  if (!text) {
    return ''
  }
  const normalized = `${text}`.trim()
  if (normalized.length <= limit) {
    return normalized
  }
  return `${normalized.slice(0, limit).trimEnd()}…`
}

export const SearchReferences = memo(function SearchReferences() {
  const view = useCodeMirrorViewContext()
  const { t } = useTranslation()

  // 添加设备和浏览器检测调试信息
  useEffect(() => {
    if (typeof window !== 'undefined') {
      console.log('Device and Browser Info:', {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        touchSupport: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
        isMac: /Mac|iPhone|iPod|iPad/i.test(navigator.platform),
        isEdge: /Edg/i.test(navigator.userAgent),
        isWebKit: /WebKit/i.test(navigator.userAgent),
        screenSize: `${screen.width}x${screen.height}`,
        viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      })
    }
  }, [])

  // Listen for custom event to open search references dialog from IDE menu bar
  // FIXED: 2026-11-16 支持带预填词：选区浮条「插入引用」会把选中的文字当成标题关键词
  // 一起带过来（event.detail.query）。不传 detail 的调用方行为完全不变。
  useEffect(() => {
    const handleSearchReferences = (event: Event) => {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query
      if (typeof query === 'string' && query.trim()) {
        setTitleQuery(query.trim().slice(0, 200))
      }
      setShowModal(true)
    }
    window.addEventListener('references:search', handleSearchReferences)
    return () => {
      window.removeEventListener('references:search', handleSearchReferences)
    }
  }, [])

  const [showModal, setShowModal] = useState(false)

  // FIXED: 2026-11-16 打开弹窗时查一次是否绑定了 Zotero（未绑定就不显示这一档）
  useEffect(() => {
    if (!showModal) {
      return
    }
    let cancelled = false
    fetch('/api/zotero/status', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(res => (res.ok ? res.json() : null))
      .then(body => {
        if (cancelled || !body || body.code !== 0) {
          return
        }
        const data = body.data || {}
        setZoteroLinked(Boolean(data.linked))
        setZoteroCollections(
          Array.isArray(data.collections)
            ? data.collections.map((c: any) => ({ key: c.key, name: c.name }))
            : []
        )
      })
      .catch(() => {
        // 连不上就不显示这一档，不打扰用户
      })
    return () => {
      cancelled = true
    }
  }, [showModal])

  const [titleQuery, setTitleQuery] = useState('')
  const [authorQuery, setAuthorQuery] = useState('')
  const [yearFromQuery, setYearFromQuery] = useState('')
  const [yearToQuery, setYearToQuery] = useState('')
  const [searchType, setSearchType] = useState<'exact' | 'fuzzy'>('fuzzy')
  const [isLoading, setIsLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<ReferenceItem[]>([])
  // FIXED: 2026-11（11-02 被一次回滚抹掉的修复，这里重新落一遍）
  //   「未找到结果」原来只要搜索框里有字就显示 —— 用户在标题框里刚敲第一个字，
  //   下面已经是「未找到结果」，看着像坏了。改成「上一次真正搜过的条件快照」：
  //   没快照 = 没搜过 = 什么都不显示；空状态里回显的也是搜的时候的条件。
  const [lastQuery, setLastQuery] = useState<null | {
    title: string
    author: string
    yearFrom: string
    yearTo: string
    searchType: 'exact' | 'fuzzy'
    region: 'global' | 'person' | 'aminer' | 'zotero'
  }>(null)
  /** 切换搜索范围：旧结果属于上一个源，留着只会误导（也避免空状态错乱） */
  const changeRegion = (next: 'global' | 'person' | 'aminer' | 'zotero') => {
    setRegion(next)
    setSearchResults([])
    setSelectedItems(new Set())
    setLastQuery(null)
  }
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
  const [showAlert, setShowAlert] = useState(false)
  const [alertMessage, setAlertMessage] = useState('')
  const [alertVariant, setAlertVariant] = useState('danger')
  // FIXED: 2026-11-02 服务端给出 /ne-relink 时必须真的能点。
  // 原来只是把 URL 拼在文案里，用户只能手动去地址栏敲 —— 实际等于没有出口。
  const [relinkHref, setRelinkHref] = useState<string | null>(null)
  // FIXED: 2026-11 第三档搜索范围：AMiner（互联网学术检索）
  const [region, setRegion] = useState<
    'global' | 'person' | 'aminer' | 'zotero'
  >('global')
  // FIXED: 2026-11-16 Zotero 作为第四个来源：没绑定就不显示这一档
  const [zoteroLinked, setZoteroLinked] = useState(false)
  const [zoteroCollections, setZoteroCollections] = useState<
    Array<{ key: string; name: string }>
  >([])
  const [zoteroCollection, setZoteroCollection] = useState('')
  // FIXED: 2026-11-17 Zotero 改成「一次拉下来 + 本地过滤」：
  //   zoteroServerQuery 记录当前结果是哪一次服务端搜索的（'' = 整库/整分类），
  //   输入框只筛已拉到内存的这些条目，不再每敲一个字就请求一次。
  const [zoteroServerQuery, setZoteroServerQuery] = useState('')
  const [zoteroTotal, setZoteroTotal] = useState<number | null>(null)
  const [zoteroTruncated, setZoteroTruncated] = useState(false)
  const zoteroCacheRef = useRef<Map<string, any>>(new Map())
  // 没配 AMiner Key 就不显示这一档（用户明确要求）：状态来自 /ft-ai/aminer-status，
  // 和「设置 → AI 助手 → AMiner 搜索」用的是同一个接口，浏览器拿不到明文 Key。
  const [aminerAvailable, setAminerAvailable] = useState(false)
  const [keywordQuery, setKeywordQuery] = useState('')

  // FIXED: 2026-11-17 Zotero 档的输入框 = 内存过滤器：只筛已经拉下来的 metadata。
  //   多词按空格拆，每个词都命中才算（标题/作者/年份/期刊/摘要），实现与单测见 zotero-filter.ts
  const visibleResults = useMemo(() => {
    if (region !== 'zotero') {
      return searchResults
    }
    return filterZoteroItems(searchResults, keywordQuery)
  }, [region, keywordQuery, searchResults])

  // 过滤后看不见的条目不能还留在选中集里：否则「插入选中」会插入用户看不见的东西。
  useEffect(() => {
    if (region !== 'zotero') {
      return
    }
    setSelectedItems((prev: any) => {
      const visible = new Set(visibleResults.map((item: any) => item.hash_id))
      const next = new Set(
        Array.from(prev).filter((id: any) => visible.has(id))
      )
      return next.size === prev.size ? prev : next
    })
  }, [region, visibleResults])

  useEffect(() => {
    let alive = true
    getJSON('/ft-ai/aminer-status')
      .then((payload: any) => {
        if (!alive) return
        setAminerAvailable(Boolean(payload?.data?.configured))
      })
      .catch(() => {
        // 拿不到状态就当没配：宁可少一个选项，也不要给用户一个点了就报错的入口
        if (alive) setAminerAvailable(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const showTimedAlert = useCallback(
    (variant, key, vars = {}, duration) => {
      setAlertVariant(variant)
      setAlertMessage(t(key, vars))
      setRelinkHref(null)
      setShowAlert(true)
      const timeout =
        duration != null ? duration : variant === 'success' ? 3000 : 5000
      setTimeout(() => setShowAlert(false), timeout)
    },
    [t]
  )

  /**
   * FIXED: 2026-11-17 把 Zotero 的 metadata 一次拉到本地（默认 200 条，服务端上限 500）。
   *   serverQuery='' 表示整库/整分类（切分类自动走这个）；传词表示让 Zotero 服务器搜（大库用）。
   *   结果进内存 cache，切回同一个分类不再请求。
   */
  const pullZotero = useCallback(
    async (serverQuery: string, opts: { force?: boolean } = {}) => {
      const q = (serverQuery || '').trim()
      const cacheKey = `${zoteroCollection}|${q}`

      const applySnapshot = (snapshot: any) => {
        setSearchResults(
          (snapshot.items || []).map((item: any) => ({
            hash_id: item.key,
            zotero_key: item.key,
            title: [item.title],
            title_text: [item.title],
            authors:
              item.creators && item.creators.length ? item.creators : [''],
            year: item.year || '',
            container_title: [item.publication || ''],
            container_title_text: [item.publication || ''],
            abstract: item.abstractNote || '',
            abstract_text: item.abstractNote || '',
            type: item.itemType || '',
            url: item.url || '',
            volume: '',
            issue: '',
            page: '',
          }))
        )
        setZoteroServerQuery(q)
        setZoteroTotal(
          snapshot.totalResults == null ? null : snapshot.totalResults
        )
        setZoteroTruncated(Boolean(snapshot.truncated))
        setSelectedItems(new Set())
        setLastQuery({
          title: q,
          author: '',
          yearFrom: '',
          yearTo: '',
          searchType: 'fuzzy',
          region: 'zotero',
        })
      }

      // 缓存只用于「自动拉取」；用户显式点搜索/回车时总是取最新的
      const cached = opts.force ? null : zoteroCacheRef.current.get(cacheKey)
      if (cached) {
        applySnapshot(cached)
        return
      }

      setIsLoading(true)
      setRelinkHref(null)
      try {
        const params = new URLSearchParams({ limit: String(ZOTERO_PAGE_LIMIT) })
        if (q) {
          params.set('q', q)
        }
        if (zoteroCollection) {
          params.set('collection', zoteroCollection)
        }
        const response = await fetch(`/api/zotero/items?${params.toString()}`, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        })
        const body = await response.json()
        if (!response.ok || body.code !== 0) {
          setAlertVariant('danger')
          setAlertMessage(
            body.msg || `Zotero 请求失败（HTTP ${response.status}）`
          )
          setShowAlert(true)
          setTimeout(() => setShowAlert(false), 6000)
          setSearchResults([])
          return
        }
        const data = body.data || {}
        const snapshot = {
          items: data.items || [],
          totalResults: data.totalResults == null ? null : data.totalResults,
          truncated: Boolean(data.truncated),
        }
        zoteroCacheRef.current.set(cacheKey, snapshot)
        applySnapshot(snapshot)
      } catch (error: any) {
        setAlertVariant('danger')
        setAlertMessage(`Zotero 请求失败：${error?.message || error}`)
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 6000)
        setSearchResults([])
      } finally {
        setIsLoading(false)
      }
    },
    [zoteroCollection]
  )

  // FIXED: 2026-11-17 切到 Zotero 档 / 换分类 → 自动拉一次（300ms debounce）。
  //   原来必须手动按 Enter 才会出列表，用户只能去点「导入整库到 .bib」。
  useEffect(() => {
    if (region !== 'zotero' || !zoteroLinked) {
      return
    }
    const timer = setTimeout(() => {
      pullZotero('').catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [region, zoteroCollection, zoteroLinked, pullZotero])

  const handleSearch = useCallback(async () => {
    // FIXED: 2026-11-16 Zotero 是「个人文献库」，语义上等价于 person 检索。
    // FIXED: 2026-11-17 手动搜索 = 让 Zotero 服务器按词搜（大库靠这个）；
    //   平时输入框里的字只是本地过滤，不再每次按键都发请求。
    //   OLD: 这里内联 fetch limit:25，且列表根本看不到（搜索按钮在 Zotero 档恒为禁用）。
    if (region === 'zotero') {
      await pullZotero((keywordQuery || titleQuery || authorQuery).trim(), {
        force: true,
      })
      return
    }

    // Person 模式只需要关键词
    if (region === 'person') {
      if (!keywordQuery.trim()) {
        showTimedAlert('danger', 'crossref_error_missing_keyword', {}, 3000)
        return
      }
    } else {
      // Global 模式需要标题或作者
      if (!titleQuery.trim() && !authorQuery.trim()) {
        showTimedAlert(
          'danger',
          'crossref_error_missing_title_author',
          {},
          3000
        )
        return
      }

      // 验证年份输入
      if (yearFromQuery && !/^\d{4}$/.test(yearFromQuery)) {
        showTimedAlert('danger', 'crossref_error_invalid_year_from', {}, 3000)
        return
      }

      if (yearToQuery && !/^\d{4}$/.test(yearToQuery)) {
        showTimedAlert('danger', 'crossref_error_invalid_year_to', {}, 3000)
        return
      }

      if (
        yearFromQuery &&
        yearToQuery &&
        parseInt(yearFromQuery) > parseInt(yearToQuery)
      ) {
        showTimedAlert('danger', 'crossref_error_year_range', {}, 3000)
        return
      }
    }

    setIsLoading(true)
    try {
      console.log(
        'Search triggered with region:',
        region,
        'keyword:',
        keywordQuery,
        'title:',
        titleQuery,
        'author:',
        authorQuery,
        'yearFrom:',
        yearFromQuery,
        'yearTo:',
        yearToQuery,
        'type:',
        searchType
      )

      // 构建符合API要求的请求体
      const requestBody: any = {
        region: region,
        page: 1,
        page_size: 20,
      }

      if (region === 'person') {
        // Person 模式：只使用关键词搜索
        requestBody.keywords = keywordQuery.trim()
      } else if (region === 'aminer') {
        // FIXED: 2026-11 AMiner 只有「关键词」一个入口（没有 title/author 字段级检索），
        // 所以把标题和作者合成一句 query 传下去；年份按区间传。
        requestBody.query = [titleQuery.trim(), authorQuery.trim()]
          .filter(Boolean)
          .join(' ')
        if (yearFromQuery) requestBody.yearFrom = Number(yearFromQuery)
        if (yearToQuery) requestBody.yearTo = Number(yearToQuery)
      } else {
        // Global 模式：使用原有的 CrossRef 搜索逻辑
        requestBody.filters = {}
        requestBody.type = ['Journal Article', 'Conference Paper']

        // 构建年份范围
        let yearRange = ''
        if (yearFromQuery && yearToQuery) {
          yearRange = `${yearFromQuery}-${yearToQuery}`
        } else if (yearFromQuery) {
          yearRange = `${yearFromQuery}-2025`
        } else if (yearToQuery) {
          yearRange = `2000-${yearToQuery}`
        } else {
          yearRange = '2001-2025' // 默认范围
        }
        requestBody.year = yearRange

        // 添加标题过滤条件
        if (titleQuery.trim()) {
          requestBody.filters.title = {
            fuzzy: searchType === 'fuzzy',
            fuzziness: searchType === 'fuzzy' ? 2 : 0,
            operator: 'AND',
            value: titleQuery.trim(),
          }
        }

        // 添加作者过滤条件
        if (authorQuery.trim()) {
          requestBody.filters.author = {
            fuzzy: searchType === 'fuzzy',
            fuzziness: searchType === 'fuzzy' ? 2 : 0,
            operator: 'AND',
            value: authorQuery.trim(),
          }
        }
      }

      const result: SearchResponse = await customPostJSON(
        '/cross-ref-search',
        requestBody
      )

      console.log('CrossRef API full response:', result)

      // 智能探测数据结构并提取实际数据
      let actualData = null
      let detectedStructure = 'unknown'

      if (result.code === 0 && result.data) {
        // 情况1: 标准格式 - result.data.items 直接存在
        if (result.data.items && Array.isArray(result.data.items)) {
          actualData = result.data
          detectedStructure = 'standard'
        }
        // 情况2: 嵌套格式 - result.data.data.items 存在
        else if (
          result.data.data &&
          result.data.data.items &&
          Array.isArray(result.data.data.items)
        ) {
          actualData = result.data.data
          detectedStructure = 'nested'
        }
        // 情况3: 深度嵌套 - result.data.data.data.items 存在（以防万一）
        else if (
          result.data.data &&
          result.data.data.data &&
          result.data.data.data.items &&
          Array.isArray(result.data.data.data.items)
        ) {
          actualData = result.data.data.data
          detectedStructure = 'deep-nested'
        }
      }

      console.log(
        'Data structure detected:',
        detectedStructure,
        'actualData:',
        actualData
      )

      if (result.code === 0 && actualData && actualData.items) {
        // 转换API响应格式为前端期望的格式
        const transformedItems = actualData.items.map((item: any) => {
          // Person 模式的数据格式转换
          if (region === 'person') {
            return {
              hash_id:
                item.articleHashId ||
                item.id ||
                `ref_${Date.now()}_${Math.random()}`,
              title: Array.isArray(item.Title)
                ? item.Title
                : [item.Title || ''],
              title_text: Array.isArray(item.Title)
                ? item.Title
                : [item.Title || ''],
              authors: (item.Authors || '').split(';;').filter(a => a.trim()),
              year: item.Year || new Date().getFullYear(),
              container_title: Array.isArray(item.Source)
                ? item.Source
                : [item.Source || ''],
              container_title_text: Array.isArray(item.Source)
                ? item.Source
                : [item.Source || ''],
              abstract: item.Abstract || '',
              abstract_text: item.Abstract || '',
              type: item.type === 2 ? 'Journal Article' : 'Conference Paper',
              url: item.URLs || '',
              volume: item.Volume || '',
              issue: item.Issue || '',
              page: item.Pages || '',
            }
          }
          // Global 模式的数据格式转换
          return {
            hash_id:
              item.hash_id || item.id || `ref_${Date.now()}_${Math.random()}`,
            title: Array.isArray(item.title) ? item.title : [item.title || ''],
            title_text: Array.isArray(item.title_text)
              ? item.title_text
              : [item.title_text || item.title || ''],
            authors: Array.isArray(item.authors)
              ? item.authors
              : [item.authors || ''],
            year: item.year || new Date().getFullYear(),
            container_title: Array.isArray(item.container_title)
              ? item.container_title
              : [item.container_title || ''],
            container_title_text: Array.isArray(item.container_title_text)
              ? item.container_title_text
              : [item.container_title_text || item.container_title || ''],
            abstract: item.abstract || '',
            abstract_text: item.abstract_text || item.abstract || '',
            type: item.type || 'Journal Article',
            url: item.url || '',
            volume: item.volume || '',
            issue: item.issue || '',
            page: item.page || '',
          }
        })

        console.log('Setting search results:', transformedItems.length, 'items')
        setSearchResults(transformedItems)
        setSelectedItems(new Set())
        setLastQuery({
          title: titleQuery.trim(),
          author: authorQuery.trim(),
          yearFrom: yearFromQuery,
          yearTo: yearToQuery,
          searchType,
          region,
        })

        // FIXED: 2026-11 AMiner 有时返回没有标题的条目（无法生成引用条目），
        // 后端已丢弃并给出数量，这里告诉用户「少了的是被丢弃的」，
        // 否则只会觉得「怎么只找到 N 条」。
        if (region === 'aminer' && actualData.dropped > 0) {
          showTimedAlert(
            'info',
            'crossref_aminer_dropped',
            { n: actualData.dropped },
            6000
          )
        }
      } else {
        // 处理错误响应
        console.error('Search API error:', result)
        setSearchResults([])
        // 失败不显示「未找到结果」（那是“搜过了但没有”的意思），错误已有提示
        setLastQuery(null)

        // FIXED: 2026-11-02 后端按《转发服务API.md §1》会给 relink 出口
        // （ne_session_expired / reauth_required），这里必须渲染成可点的链接。
        const relink =
          result && result.data && (result.data as any).relink
            ? String((result.data as any).relink)
            : null
        const relinkTarget = relink
          ? `${relink}?return=${encodeURIComponent(
              window.location.pathname + window.location.search
            )}`
          : null

        if (result.code === 401) {
          showTimedAlert('danger', 'crossref_error_login_required', {}, 5000)
        } else if (result.code === 400) {
          showTimedAlert('danger', 'crossref_error_invalid_query', {}, 5000)
        } else if (relinkTarget) {
          setAlertVariant('danger')
          setAlertMessage(result.message || '')
          setRelinkHref(relinkTarget)
          setShowAlert(true)
          setTimeout(() => setShowAlert(false), 20000)
        } else if (result.message) {
          showTimedAlert(
            'danger',
            'crossref_error_with_detail',
            { detail: result.message },
            5000
          )
        } else {
          showTimedAlert('danger', 'crossref_error_search_failed', {}, 5000)
        }
      }

      setIsLoading(false)
    } catch (error) {
      console.error('Search failed:', error)
      setIsLoading(false)
      setSearchResults([])

      if (error instanceof Error) {
        if (error.message.includes('User email not found')) {
          showTimedAlert(
            'danger',
            'crossref_error_user_email_missing',
            {},
            5000
          )
        } else if (error.message.includes('Project ID not found')) {
          showTimedAlert(
            'danger',
            'crossref_error_project_id_missing',
            {},
            5000
          )
        } else if (error.message.includes('401')) {
          showTimedAlert('danger', 'crossref_error_login_required', {}, 5000)
        } else if (error.message.includes('403')) {
          showTimedAlert('danger', 'crossref_error_access_denied', {}, 5000)
        } else if (error.message.includes('CSRF token not found')) {
          showTimedAlert('danger', 'crossref_error_csrf', {}, 5000)
        } else {
          showTimedAlert(
            'danger',
            'crossref_error_with_detail',
            { detail: error.message },
            5000
          )
        }
      } else {
        showTimedAlert('danger', 'crossref_error_network', {}, 5000)
      }
    }
  }, [
    titleQuery,
    authorQuery,
    yearFromQuery,
    yearToQuery,
    searchType,
    keywordQuery,
    region,
    // FIXED: 2026-11-16 Zotero 分支用到的状态
    zoteroCollection,
    setRelinkHref,
    // FIXED: 2026-11-17 Zotero 分支改走 pullZotero
    pullZotero,
  ])

  const handleItemSelect = useCallback((itemId: string) => {
    setSelectedItems((prev: any) => {
      const newSet = new Set(prev)
      if (newSet.has(itemId)) {
        newSet.delete(itemId)
      } else {
        newSet.add(itemId)
      }
      return newSet
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    // FIXED: 2026-11-17 「全选」只作用于过滤后看得见的行（Zotero 档尤其重要）
    if (selectedItems.size === visibleResults.length) {
      setSelectedItems(new Set())
    } else {
      setSelectedItems(
        new Set(visibleResults.map((item: any) => item.hash_id))
      )
    }
  }, [selectedItems.size, visibleResults])

  // Helper function to detect bibliography style and existing .bib files
  // FIXED: 2026-11-16 探测逻辑抽到 bib-setup.ts（可单测），这里只做一层稳定引用
  const detectBibliographySetup = useCallback(
    (docText: string) => detectBibSetup(docText),
    []
  )

  // Helper function to check if .bib file exists in project
  const checkBibFileExists = useCallback(async (bibFileName: string) => {
    try {
      // Get project ID from window or context
      const projectId =
        (window as any)?.project_id ||
        (document.querySelector('meta[name="ol-project_id"]') as any)?.content

      if (!projectId) {
        console.warn('Project ID not found, assuming .bib file exists')
        return true // Assume exists if we can't check
      }

      // Make sure the filename has .bib extension
      const fullFileName = bibFileName.endsWith('.bib')
        ? bibFileName
        : `${bibFileName}.bib`

      // Try to check if file exists via a simple HEAD request or file list API
      // For now, we'll use a heuristic: assume it exists if it follows naming convention
      const isValidName = /^[a-zA-Z0-9_-]+(?:\.bib)?$/.test(bibFileName)

      if (!isValidName) {
        console.warn(`Invalid .bib filename: ${bibFileName}`)
        return false
      }

      // TODO: This could be enhanced with a real API call to check file existence
      // For example: GET /project/${projectId}/files or similar
      console.log(
        `Assuming .bib file '${fullFileName}' exists in project ${projectId}`
      )
      return true
    } catch (error) {
      console.log('Could not check bib file existence:', error)
      return false
    }
  }, [])

  // FIXED: 2026-11-16 Zotero 的插入：直接拿 Zotero 导出的 BibTeX（比自己拼 @misc 准），
  // 写进 .bib 之后再插 \cite{}；复用既有的 updateBibFile + bibliography 探测。
  const handleInsertZotero = useCallback(async () => {
    const selectedRefs = searchResults.filter((item: any) =>
      selectedItems.has(item.hash_id)
    )
    const keys = selectedRefs.map((ref: any) => ref.zotero_key).filter(Boolean)
    if (!keys.length) {
      showTimedAlert('danger', 'crossref_error_select_reference', {}, 3000)
      return
    }

    try {
      const response = await fetch('/api/zotero/bibtex', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': (window as any).csrfToken || '',
        },
        body: JSON.stringify({ keys }),
      })
      const body = await response.json()
      if (!response.ok || body.code !== 0) {
        setAlertVariant('danger')
        setAlertMessage(
          body.msg || `Zotero 导出失败（HTTP ${response.status}）`
        )
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 6000)
        return
      }

      const exported = ((body.data && body.data.items) || []).filter(
        (item: any) => item && item.bibtex && item.citationKey
      )
      if (!exported.length) {
        setAlertVariant('danger')
        setAlertMessage(
          'Zotero 没有返回可用的 BibTeX 条目（条目里可能缺少必要字段）'
        )
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 6000)
        return
      }

      // 只支持 BibTeX 模式：没有 \bibliography{...} 时不硬塞 \bibitem（那会生成一堆残缺条目）
      const bibSetup = detectBibliographySetup(view.state.doc.toString())
      if (!bibSetup.bibFiles.length) {
        setAlertVariant('danger')
        setAlertMessage(
          bibSetup.hasBibliography
            ? '文档里有参考文献环境，但找不到 .bib 路径。请在 \\addbibresource{./bib/xxx.bib} 或模板里的 bibResource = {./bib/xxx.bib} 里写明文件名'
            : '没有在文档里找到参考文献数据源。支持 \\bibliography{refs}、\\addbibresource{./bib/refs.bib}、以及模板里的 bibResource = {./bib/refs.bib}'
        )
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 9000)
        return
      }

      const bibFileName = bibSetup.bibFiles[0]
      const bibtexText = exported.map((item: any) => item.bibtex).join('\n\n')
      await updateBibFile(bibFileName, bibtexText)

      const citeKeys = exported.map((item: any) => item.citationKey)
      const citeCommand = `\\cite{${citeKeys.join(', ')}}`
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: citeCommand },
        selection: { anchor: from + citeCommand.length },
      })

      setAlertVariant('success')
      setAlertMessage(
        `已插入 ${citeKeys.length} 条 Zotero 引用，并写入 ${bibFileName}.bib`
      )
      setShowAlert(true)
      setTimeout(() => {
        setShowAlert(false)
        setShowModal(false)
      }, 2000)
    } catch (error: any) {
      setAlertVariant('danger')
      setAlertMessage(`Zotero 插入失败：${error?.message || error}`)
      setShowAlert(true)
      setTimeout(() => setShowAlert(false), 6000)
    }
  }, [
    selectedItems,
    searchResults,
    view,
    detectBibliographySetup,
    updateBibFile,
    showTimedAlert,
  ])

  /** 当前项目 id（与 updateBibFile 用的是同一套取法） */
  const getProjectId = useCallback(
    () =>
      (window as any)?.project_id ||
      (document.querySelector('meta[name="ol-project_id"]') as any)?.content,
    []
  )

  /** FIXED: 2026-11-16 整库 / 本分类一键导入 .bib（用 Zotero 自己的 bibtex 导出） */
  const handleImportZoteroBibtex = useCallback(async () => {
    const bibSetup = detectBibliographySetup(view.state.doc.toString())
    if (!bibSetup.bibFiles.length) {
      setAlertVariant('danger')
      setAlertMessage(
        bibSetup.hasBibliography
          ? '文档里有参考文献环境，但找不到 .bib 路径。请在 \\addbibresource{./bib/xxx.bib} 或模板里的 bibResource = {./bib/xxx.bib} 里写明文件名'
          : '没有在文档里找到参考文献数据源。支持 \\bibliography{refs}、\\addbibresource{./bib/refs.bib}、以及模板里的 bibResource = {./bib/refs.bib}'
      )
      setShowAlert(true)
      setTimeout(() => setShowAlert(false), 9000)
      return
    }
    setIsLoading(true)
    try {
      const response = await fetch('/api/zotero/export-bibtex', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': (window as any).csrfToken || '',
        },
        body: JSON.stringify({
          collectionKey: zoteroCollection || '',
          maxEntries: 500,
        }),
      })
      const body = await response.json()
      if (!response.ok || body.code !== 0) {
        setAlertVariant('danger')
        setAlertMessage(body.msg || `导出失败（HTTP ${response.status}）`)
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 8000)
        return
      }
      const { bibtex, entryCount, truncated } = body.data || {}
      if (!bibtex || !entryCount) {
        setAlertVariant('danger')
        setAlertMessage('Zotero 这个范围里没有可导入的文献条目')
        setShowAlert(true)
        setTimeout(() => setShowAlert(false), 6000)
        return
      }
      const bibFileName = bibSetup.bibFiles[0]
      const updateResult = await updateBibFile(bibFileName, bibtex)
      const added = updateResult?.data?.addedCount
      const duplicates = updateResult?.data?.duplicateCount
      setAlertVariant('success')
      setAlertMessage(
        `已从 Zotero 导入 ${entryCount} 条到 ${bibFileName}.bib` +
          (added != null
            ? `（新增 ${added}，已存在 ${duplicates || 0}）`
            : '') +
          (truncated ? '；条目太多，只导了前 500 条' : '')
      )
      setShowAlert(true)
      setTimeout(() => setShowAlert(false), 6000)
    } catch (error: any) {
      setAlertVariant('danger')
      setAlertMessage(`导入失败：${error?.message || error}`)
      setShowAlert(true)
      setTimeout(() => setShowAlert(false), 8000)
    } finally {
      setIsLoading(false)
    }
  }, [detectBibliographySetup, view, zoteroCollection, updateBibFile])

  /** FIXED: 2026-11-16 把选中条目的 PDF 存进项目（走 Filestore，与「上传」同链路） */
  const handleImportZoteroAttachment = useCallback(async () => {
    const projectId = getProjectId()
    if (!projectId) {
      return
    }
    const selectedRefs = searchResults.filter((item: any) =>
      selectedItems.has(item.hash_id)
    )
    const keys = selectedRefs.map((ref: any) => ref.zotero_key).filter(Boolean)
    if (!keys.length) {
      showTimedAlert('danger', 'crossref_error_select_reference', {}, 3000)
      return
    }

    setIsLoading(true)
    const added: string[] = []
    const failed: string[] = []
    try {
      for (const itemKey of keys) {
        const response = await fetch('/api/zotero/import-attachment', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-Token': (window as any).csrfToken || '',
          },
          body: JSON.stringify({ projectId, itemKey }),
        })
        const body = await response.json()
        if (!response.ok || body.code !== 0) {
          failed.push(body.msg || `HTTP ${response.status}`)
        } else {
          added.push(body.data?.fileName || itemKey)
        }
      }
    } finally {
      setIsLoading(false)
    }

    if (added.length) {
      setAlertVariant(failed.length ? 'warning' : 'success')
      setAlertMessage(
        `已存入项目：${added.join('、')}` +
          (failed.length ? `；${failed.length} 条失败（${failed[0]}）` : '')
      )
    } else {
      setAlertVariant('danger')
      setAlertMessage(
        `没有可存入的 PDF：${failed[0] || '选中的条目在 Zotero 里没有附件'}`
      )
    }
    setShowAlert(true)
    setTimeout(() => setShowAlert(false), 8000)
  }, [searchResults, selectedItems, getProjectId, showTimedAlert])

  const handleInsertReferences = useCallback(async () => {
    // FIXED: 2026-11-16 Zotero 走 BibTeX 直出，不套 Crossref 那套 @misc 生成
    if (region === 'zotero') {
      await handleInsertZotero()
      return
    }
    if (selectedItems.size === 0) {
      showTimedAlert('danger', 'crossref_error_select_reference', {}, 3000)
      return
    }

    const selectedRefs = searchResults.filter((item: any) =>
      selectedItems.has(item.hash_id)
    )
    const citeKeys = selectedRefs.map((ref: any) => ref.hash_id).join(', ')
    const citeCommand = `\\cite{${citeKeys}}`

    // Insert cite command at current cursor position
    const { from, to } = view.state.selection.main
    const docText = view.state.doc.toString()

    // Detect existing bibliography setup
    const bibSetup = detectBibliographySetup(docText)

    console.log('Bibliography detection result:', bibSetup)
    console.log('Document text contains bibliography commands:', {
      hasBibliographyStyle: /\\bibliographystyle\{/.test(docText),
      hasBibliography: /\\bibliography\{/.test(docText),
      bibFiles: bibSetup.bibFiles,
    })

    let insertionMode = 'bibitem' // default mode
    let successMessage = ''

    // 强制检查：如果文档有\bibliography命令，必须使用BibTeX模式
    if (bibSetup.hasBibliography && bibSetup.bibFiles.length > 0) {
      console.log(
        'Detected BibTeX mode - will NOT add bibitem entries to tex file'
      )

      // 如果没有\bibliographystyle，给出警告但仍使用BibTeX模式
      if (!bibSetup.hasBibliographyStyle) {
        console.warn(
          'Warning: Found \\bibliography but no \\bibliographystyle command'
        )
      }
      // 强制BibTeX模式 - 绝不添加bibitem到tex文件
      try {
        const bibFileName = bibSetup.bibFiles[0] // Use first found .bib file
        console.log(`Using BibTeX mode with file: ${bibFileName}`)
        const bibFileExists = await checkBibFileExists(bibFileName)

        if (bibFileExists) {
          // Generate BibTeX entries with smart ID generation
          const bibTexEntries = selectedRefs
            .map((ref: ReferenceItem) => {
              const authors = formatAuthors(ref.authors)
              const title = formatTitle(ref.title)
              const journal = formatJournal(ref.container_title)
              const year = ref.year

              // Generate BibTeX ID: use author+year format or fallback to hash_id
              let bibId = ref.hash_id
              if (authors && year) {
                const firstAuthor = authors.split(',')[0].trim()
                const lastName = firstAuthor.split(' ').pop() || ''
                const cleanLastName = lastName
                  .replace(/[^a-zA-Z]/g, '')
                  .toLowerCase()
                if (cleanLastName) {
                  bibId = `${cleanLastName}${year}`
                  // Handle potential duplicates in current selection
                  const sameNameCount = selectedRefs.filter(r => {
                    const rAuthors = formatAuthors(r.authors)
                    const rFirstAuthor = rAuthors.split(',')[0].trim()
                    const rLastName = rFirstAuthor.split(' ').pop() || ''
                    const rCleanLastName = rLastName
                      .replace(/[^a-zA-Z]/g, '')
                      .toLowerCase()
                    return rCleanLastName === cleanLastName && r.year === year
                  }).length
                  if (sameNameCount > 1) {
                    bibId = `${cleanLastName}${year}_${ref.hash_id.slice(-3)}`
                  }
                }
              }

              // Update the reference hash_id for consistent cite key
              ref.hash_id = bibId

              // Generate BibTeX format entry matching your example
              return `@misc{${bibId},
    author = {${authors}},
    title = {${title}},
    year = {${year}},
    url = {${ref.url || ''}}
}`
            })
            .join('\n\n')

          // Call backend API to update .bib file
          const updateResult = await updateBibFile(bibFileName, bibTexEntries)

          // BibTeX mode successful
          insertionMode = 'bibtex'

          // Handle different response scenarios
          const messageParts = [
            t('crossref_bibtex_insert_success', { citeKeys }),
          ]

          if (updateResult.data) {
            const { addedCount = 0, duplicateCount = 0 } = updateResult.data

            if (addedCount === 0 && duplicateCount > 0) {
              messageParts.push(
                t('crossref_bibtex_duplicates_only', {
                  count: duplicateCount,
                  file: bibFileName,
                })
              )
            } else if (duplicateCount > 0) {
              messageParts.push(
                t('crossref_bibtex_added_and_skipped', {
                  addedCount,
                  duplicateCount,
                  file: bibFileName,
                })
              )
            } else {
              messageParts.push(
                t('crossref_bibtex_added', {
                  count: addedCount,
                  file: bibFileName,
                })
              )
            }
          } else {
            messageParts.push(
              t('crossref_bibtex_updated_file', { file: bibFileName })
            )
          }

          successMessage = messageParts.join(' ')
        } else {
          // BibTeX文件不存在 - 报错而不是降级
          showTimedAlert(
            'danger',
            'crossref_error_missing_bib_file',
            { file: bibFileName },
            5000
          )
          return
        }
      } catch (error) {
        console.error('Error updating .bib file:', error)
        // BibTeX模式失败 - 报错而不是降级
        showTimedAlert(
          'danger',
          'crossref_error_update_bib_failed',
          { error: error.message },
          5000
        )
        return
      }
    }

    // 绝对保护：如果文档中有\bibliography命令，绝不允许执行传统模式
    if (bibSetup.hasBibliography) {
      showTimedAlert('danger', 'crossref_error_bibtex_protection', {}, 5000)
      return
    }

    const changes = []

    // Insert cite command at cursor (same for both modes)
    changes.push({ from, to, insert: citeCommand })

    if (insertionMode === 'bibtex') {
      // BibTeX mode: only insert cite command, bibliography entries are in .bib file
      view.dispatch({ changes })

      setAlertVariant('success')
      setAlertMessage(successMessage)
      setShowAlert(true)
      setTimeout(() => {
        setShowAlert(false)
        setShowModal(false)
      }, 3000)
      return
    }

    // Case 2: Traditional \bibitem mode (仅当完全没有bibliography命令时)
    const bibEntries = selectedRefs
      .map((ref: ReferenceItem) => {
        const authors = formatAuthors(ref.authors)
        const title = formatTitle(ref.title)
        const journal = formatJournal(ref.container_title)
        const year = ref.year
        const volume = ref.volume ? `, ${ref.volume}` : ''
        const issue = ref.issue ? `(${ref.issue})` : ''
        const pages = ref.page ? `: ${ref.page}` : ''

        // Standard LaTeX bibitem format following your example
        return `\\bibitem{${ref.hash_id}}
${authors}. ${title}. \\textit{${journal}}, ${year}${volume}${issue}${pages}.`
      })
      .join('\n\n')

    // Handle bibliography section intelligently
    const bibliographyStartRegex = /\\begin\{thebibliography\}\{\d+\}/
    const bibliographyEndRegex = /\\end\{thebibliography\}/
    const enddocMatch = docText.match(/\\end\{document\}/)

    if (
      bibliographyStartRegex.test(docText) &&
      bibliographyEndRegex.test(docText)
    ) {
      // Find existing thebibliography environment and insert before \end{thebibliography}
      const endPos = docText.lastIndexOf('\\end{thebibliography}')
      // Check if we need to add a newline before the new entries
      const beforeEnd = docText.substring(0, endPos).trim()
      const needsNewline = !beforeEnd.endsWith('\n')

      changes.push({
        from: endPos,
        to: endPos,
        insert: `${needsNewline ? '\n\n' : '\n'}${bibEntries}\n\n`,
      })
    } else {
      // No bibliography environment exists, create one before \end{document}
      let insertPos = docText.length

      if (enddocMatch) {
        // Insert before \end{document}
        insertPos = docText.lastIndexOf('\\end{document}')
      }

      // Check what comes before the insert position to determine spacing
      const beforeInsert = docText.substring(0, insertPos).trim()
      const needsLeadingSpace =
        beforeInsert.length > 0 && !beforeInsert.endsWith('\n\n')

      const bibSection = `${needsLeadingSpace ? '\n\n' : ''}% Bibliography
\\begin{thebibliography}{99}
${bibEntries}
\\end{thebibliography}
${enddocMatch ? '\n' : ''}`

      changes.push({
        from: insertPos,
        to: insertPos,
        insert: bibSection,
      })
    }

    // Apply all changes
    view.dispatch({ changes })

    setAlertVariant('success')
    setAlertMessage(
      t('crossref_traditional_insert_success', {
        citeKeys,
        count: selectedItems.size,
      })
    )
    setShowAlert(true)
    setTimeout(() => {
      setShowAlert(false)
      setShowModal(false)
    }, 2000)
  }, [
    selectedItems,
    searchResults,
    view,
    detectBibliographySetup,
    checkBibFileExists,
    updateBibFile,
    formatAuthors,
    formatTitle,
    formatJournal,
    // FIXED: 2026-11-16 Zotero 分支
    region,
    handleInsertZotero,
    showTimedAlert,
    t,
  ])

  // Function to update .bib file via backend API
  const updateBibFile = useCallback(
    async (bibFileName: string, bibTexEntries: string) => {
      const userEmail = getUserEmail()

      if (!userEmail) {
        throw new Error('User email not found. Please login first.')
      }

      // Get project ID from window or context
      const projectId =
        (window as any)?.project_id ||
        (document.querySelector('meta[name="ol-project_id"]') as any)?.content

      if (!projectId) {
        throw new Error('Project ID not found')
      }

      const requestBody = {
        bibFileName: bibFileName,
        newEntries: bibTexEntries,
        userEmail: userEmail,
      }

      const response = await fetch(`/project/${projectId}/update-bib-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': window.csrfToken || '',
        },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      // FIXED: 2026-11-14 新写入的 .bib 条目要能立刻参与 \cite 补全。
      // 索引端点是 POST /references/indexAll，由 ide 层 ReferencesManager
      // 负责调用（ide.js:385 实例化，监听 references:should-reindex）。
      // 这里复用 file-tree-controller.js:106 的同一条事件，不另建通道。
      // 注意：后端 _indexLocally 会先把 .bib 从 docupdater flush 到 mongo，
      // 所以即使这边是异步的也不会读到旧内容。
      try {
        const ide = (window as any)._ide
        ide?.$scope?.$emit?.('references:should-reindex', {})
      } catch (error) {
        // 索引刷新失败不影响插入结果
      }

      return await response.json()
    },
    []
  )

  // Add a handler to prevent modal from closing accidentally
  const handleModalClick = useCallback((e: any) => {
    // console.log('Modal click event:', e.type, e.target, e.currentTarget)
    // 完全阻止模态框内容的点击事件传播
    e.stopPropagation()
    e.preventDefault()
  }, [])

  const handleBackdropClick = useCallback(
    (e: any) => {
      // console.log('Backdrop click event:', e.type, e.target, e.currentTarget)
      // Only close modal if clicking the backdrop (not the content)
      if (e.target === e.currentTarget) {
        // console.log('Closing modal via backdrop click')
        handleClose()
      }
    },
    [handleClose]
  )

  const handleClose = useCallback(() => {
    if (!isLoading) {
      setShowModal(false)
      setSelectedItems(new Set())
      setTitleQuery('')
      setAuthorQuery('')
      setYearFromQuery('')
      setYearToQuery('')
      setKeywordQuery('')
      setSearchResults([])
      setLastQuery(null)
      setShowAlert(false) // 清除任何显示的警告
    }
  }, [isLoading])

  const formatAuthors = (authors: string[]) => {
    return authors.join(', ')
  }

  const formatTitle = (titleArray: string[]) => {
    return titleArray.length > 0 ? titleArray[0] : ''
  }

  const formatJournal = (journalArray: string[]) => {
    return journalArray.length > 0 ? journalArray[0] : ''
  }

  return (
    <>
      <ToolbarButton
        id="toolbar-search-references"
        label={t('crossref_toolbar_button')}
        command={() => setShowModal(true)}
        icon="search"
      />

      <AccessibleModal
        onHide={handleClose}
        className="search-references-modal"
        show={showModal}
        backdrop="static"
        keyboard={false}
        // FIXED: 2026-11-17 去掉 size="xl"：react-bootstrap 0.33 会生成
        //   class="modal-xl"，而 bootstrap 3 只定义了 modal-lg/modal-sm，
        //   实际宽度一直是 600px。宽度改在 crosref-search.less 里按选择器限定（最宽 1100px）。
        onClick={handleBackdropClick}
        onTouchStart={(e: any) => e.stopPropagation()}
        onTouchEnd={(e: any) => e.stopPropagation()}
        onMouseDown={(e: any) => e.stopPropagation()}
        onMouseUp={(e: any) => e.stopPropagation()}
        style={{
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title>{t('crossref_modal_title')}</Modal.Title>
        </Modal.Header>

        <Modal.Body
          onClick={handleModalClick}
          onTouchStart={(e: any) => e.stopPropagation()}
          onTouchEnd={(e: any) => e.stopPropagation()}
          onMouseDown={(e: any) => e.stopPropagation()}
          onMouseUp={(e: any) => e.stopPropagation()}
        >
          <div
            style={{
              padding: '0',
              pointerEvents: 'auto',
              position: 'relative',
              zIndex: 9999,
            }}
            onClick={(e: any) => e.stopPropagation()}
            onTouchStart={(e: any) => e.stopPropagation()}
            onTouchEnd={(e: any) => e.stopPropagation()}
            onMouseDown={(e: any) => e.stopPropagation()}
            onMouseUp={(e: any) => e.stopPropagation()}
          >
            {showAlert && (
              <Alert
                variant={alertVariant}
                dismissible
                onClose={() => setShowAlert(false)}
              >
                {alertMessage}
                {relinkHref && (
                  <>
                    {' '}
                    <a
                      href={relinkHref}
                      style={{
                        marginLeft: 6,
                        fontWeight: 600,
                        textDecoration: 'underline',
                        color: 'inherit',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t('crossref_ne_relink_button')}
                    </a>
                  </>
                )}
              </Alert>
            )}

            {region === 'person' || region === 'zotero' ? (
              // Person / Zotero 模式：只显示关键词输入框（Zotero 可空 = 按最近修改列）
              <FormGroup
                controlId="keyword-query"
                style={{ marginBottom: '15px' }}
              >
                <label htmlFor="keyword-input">
                  {region === 'zotero'
                    ? '过滤（在已拉取的条目里筛；回车让 Zotero 服务器搜）'
                    : t('crossref_label_keyword')}
                </label>
                <FormControl
                  id="keyword-input"
                  type="text"
                  placeholder={
                    region === 'zotero'
                      ? '输入标题/作者/年份/期刊关键词，边输边筛'
                      : t('crossref_placeholder_keyword')
                  }
                  value={keywordQuery}
                  onChange={(e: any) => setKeywordQuery(e.target.value)}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      handleSearch()
                    }
                  }}
                  onClick={(e: any) => e.stopPropagation()}
                  onFocus={(e: any) => e.stopPropagation()}
                  onTouchStart={(e: any) => e.stopPropagation()}
                  onTouchEnd={(e: any) => e.stopPropagation()}
                  onMouseDown={(e: any) => e.stopPropagation()}
                  onMouseUp={(e: any) => e.stopPropagation()}
                  disabled={isLoading}
                />
                {region === 'zotero' && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: 'var(--fl-text-muted, #666)',
                    }}
                  >
                    {/* FIXED: 2026-11-17 说明白两种搜索的区别，避免用户以为输入没反应 */}
                    切分类会自动拉取（默认 {ZOTERO_PAGE_LIMIT} 条，按最近修改）；
                    输入只在本机过滤，回车/点搜索才去 Zotero 服务器搜。
                    {zoteroTruncated
                      ? ' 当前库条目超过一次拉取上限，用关键词搜能拿到更早的条目。'
                      : ''}
                  </div>
                )}
              </FormGroup>
            ) : (
              // Global 模式：显示原有的标题、作者、年份输入框
              <>
                <div style={{ display: 'flex', gap: '15px' }}>
                  <FormGroup controlId="title-query" style={{ flex: '2' }}>
                    <label htmlFor="title-input">
                      {t('crossref_label_title')}
                    </label>
                    <FormControl
                      id="title-input"
                      type="text"
                      placeholder={t('crossref_placeholder_title')}
                      value={titleQuery}
                      onChange={(e: any) => setTitleQuery(e.target.value)}
                      onKeyDown={(e: any) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          e.stopPropagation()
                          handleSearch()
                        }
                      }}
                      onClick={(e: any) => e.stopPropagation()}
                      onFocus={(e: any) => e.stopPropagation()}
                      onTouchStart={(e: any) => e.stopPropagation()}
                      onTouchEnd={(e: any) => e.stopPropagation()}
                      onMouseDown={(e: any) => e.stopPropagation()}
                      onMouseUp={(e: any) => e.stopPropagation()}
                      disabled={isLoading}
                    />
                  </FormGroup>

                  <FormGroup controlId="author-query" style={{ flex: '2' }}>
                    <label htmlFor="author-input">
                      {t('crossref_label_author')}
                    </label>
                    <FormControl
                      id="author-input"
                      type="text"
                      placeholder={t('crossref_placeholder_author')}
                      value={authorQuery}
                      onChange={(e: any) => setAuthorQuery(e.target.value)}
                      onKeyDown={(e: any) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          e.stopPropagation()
                          handleSearch()
                        }
                      }}
                      onClick={(e: any) => e.stopPropagation()}
                      onFocus={(e: any) => e.stopPropagation()}
                      onTouchStart={(e: any) => e.stopPropagation()}
                      onTouchEnd={(e: any) => e.stopPropagation()}
                      onMouseDown={(e: any) => e.stopPropagation()}
                      onMouseUp={(e: any) => e.stopPropagation()}
                      disabled={isLoading}
                    />
                  </FormGroup>
                </div>

                <div style={{ display: 'flex', gap: '15px' }}>
                  <FormGroup controlId="year-from-query" style={{ flex: '1' }}>
                    <label htmlFor="year-from-input">
                      {t('crossref_label_year_from')}
                    </label>
                    <FormControl
                      id="year-from-input"
                      type="text"
                      placeholder={t('crossref_placeholder_year_from')}
                      value={yearFromQuery}
                      onChange={(e: any) => {
                        const value = e.target.value
                          .replace(/\D/g, '')
                          .slice(0, 4)
                        setYearFromQuery(value)
                      }}
                      onKeyDown={(e: any) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          e.stopPropagation()
                          handleSearch()
                        }
                      }}
                      onClick={(e: any) => e.stopPropagation()}
                      onFocus={(e: any) => e.stopPropagation()}
                      onTouchStart={(e: any) => e.stopPropagation()}
                      onTouchEnd={(e: any) => e.stopPropagation()}
                      onMouseDown={(e: any) => e.stopPropagation()}
                      onMouseUp={(e: any) => e.stopPropagation()}
                      disabled={isLoading}
                      maxLength={4}
                    />
                  </FormGroup>

                  <FormGroup controlId="year-to-query" style={{ flex: '1' }}>
                    <label htmlFor="year-to-input">
                      {t('crossref_label_year_to')}
                    </label>
                    <FormControl
                      id="year-to-input"
                      type="text"
                      placeholder={t('crossref_placeholder_year_to')}
                      value={yearToQuery}
                      onChange={(e: any) => {
                        const value = e.target.value
                          .replace(/\D/g, '')
                          .slice(0, 4)
                        setYearToQuery(value)
                      }}
                      onKeyDown={(e: any) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          e.stopPropagation()
                          handleSearch()
                        }
                      }}
                      onClick={(e: any) => e.stopPropagation()}
                      onFocus={(e: any) => e.stopPropagation()}
                      onTouchStart={(e: any) => e.stopPropagation()}
                      onTouchEnd={(e: any) => e.stopPropagation()}
                      onMouseDown={(e: any) => e.stopPropagation()}
                      onMouseUp={(e: any) => e.stopPropagation()}
                      disabled={isLoading}
                      maxLength={4}
                    />
                  </FormGroup>

                  <div
                    style={{
                      flex: '2',
                      display: 'flex',
                      alignItems: 'flex-end',
                      flexDirection: 'column',
                    }}
                  >
                    <div style={{ marginBottom: '5px' }}>
                      <small
                        style={{
                          color: 'var(--fl-text-muted, #666)',
                          fontSize: '12px',
                          marginRight: '10px',
                        }}
                      >
                        {t('crossref_label_quick_year_ranges')}
                      </small>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--fl-link-bright, #007bff)',
                          fontSize: '12px',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          marginRight: '8px',
                        }}
                        onClick={(e: any) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setYearFromQuery('2020')
                          setYearToQuery('')
                        }}
                        onTouchStart={(e: any) => e.stopPropagation()}
                        onTouchEnd={(e: any) => e.stopPropagation()}
                        onMouseDown={(e: any) => e.stopPropagation()}
                        onMouseUp={(e: any) => e.stopPropagation()}
                        disabled={isLoading}
                      >
                        {t('crossref_quick_range_2020_plus')}
                      </button>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--fl-link-bright, #007bff)',
                          fontSize: '12px',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          marginRight: '8px',
                        }}
                        onClick={(e: any) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setYearFromQuery('2015')
                          setYearToQuery('2024')
                        }}
                        onTouchStart={(e: any) => e.stopPropagation()}
                        onTouchEnd={(e: any) => e.stopPropagation()}
                        onMouseDown={(e: any) => e.stopPropagation()}
                        onMouseUp={(e: any) => e.stopPropagation()}
                        disabled={isLoading}
                      >
                        {t('crossref_quick_range_2015_2024')}
                      </button>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--fl-link-bright, #007bff)',
                          fontSize: '12px',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                        onClick={(e: any) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setYearFromQuery('')
                          setYearToQuery('')
                        }}
                        onTouchStart={(e: any) => e.stopPropagation()}
                        onTouchEnd={(e: any) => e.stopPropagation()}
                        onMouseDown={(e: any) => e.stopPropagation()}
                        onMouseUp={(e: any) => e.stopPropagation()}
                        disabled={isLoading}
                      >
                        {t('crossref_quick_range_clear')}
                      </button>
                    </div>
                    <small
                      style={{
                        color: 'var(--fl-text-muted, #666)',
                        fontSize: '12px',
                        lineHeight: '1.2',
                      }}
                    >
                      {t('crossref_hint_year_range')}
                      <br />
                      {t('crossref_hint_year_digits', {
                        start: '2020',
                        end: '2024',
                      })}
                    </small>
                  </div>
                </div>

                {/* FIXED: 2026-11 AMiner 没有「模糊/精确」的概念：选中这一档时
                    把那一组控件换成一行说明，免得用户以为它生效。 */}
                {region === 'aminer' ? (
                  <small
                    style={{
                      display: 'block',
                      marginBottom: '15px',
                      color: 'var(--fl-text-muted, #666)',
                      fontSize: '12px',
                      lineHeight: '1.4',
                    }}
                  >
                    {t('crossref_hint_aminer')}
                  </small>
                ) : (
                  <FormGroup controlId="search-type">
                    <label>{t('crossref_label_search_type')}</label>
                    <div onClick={(e: any) => e.stopPropagation()}>
                      <Radio
                        name="search-type"
                        value="fuzzy"
                        checked={searchType === 'fuzzy'}
                        onChange={() => setSearchType('fuzzy')}
                        disabled={isLoading}
                        inline
                        onClick={(e: any) => e.stopPropagation()}
                      >
                        {t('crossref_option_fuzzy')}
                      </Radio>
                      <Radio
                        name="search-type"
                        value="exact"
                        checked={searchType === 'exact'}
                        onChange={() => setSearchType('exact')}
                        disabled={isLoading}
                        inline
                        onClick={(e: any) => e.stopPropagation()}
                      >
                        {t('crossref_option_exact')}
                      </Radio>
                    </div>
                  </FormGroup>
                )}
              </>
            )}

            <FormGroup controlId="region-type">
              <label>{t('crossref_label_region')}</label>
              {/* FIXED: 2026-11-16 四个来源改成弹性一排：等间距、换行后左对齐，
                  之前 bootstrap 的 radio-inline 各带左右 margin，Zotero 掉到第二行就错位了 */}
              <div
                className="crossref-region-options"
                onClick={(e: any) => e.stopPropagation()}
              >
                <Radio
                  name="region-type"
                  value="global"
                  checked={region === 'global'}
                  onChange={() => changeRegion('global')}
                  disabled={isLoading}
                  inline
                  onClick={(e: any) => e.stopPropagation()}
                >
                  {t('crossref_option_global')}
                </Radio>
                <Radio
                  name="region-type"
                  value="person"
                  checked={region === 'person'}
                  onChange={() => changeRegion('person')}
                  disabled={isLoading}
                  inline
                  onClick={(e: any) => e.stopPropagation()}
                >
                  {t('crossref_option_person')}
                </Radio>
                {/* FIXED: 2026-11 只有配好 AMiner Key 才显示这一档 */}
                {aminerAvailable && (
                  <Radio
                    name="region-type"
                    value="aminer"
                    checked={region === 'aminer'}
                    onChange={() => changeRegion('aminer')}
                    disabled={isLoading}
                    inline
                    onClick={(e: any) => e.stopPropagation()}
                  >
                    {t('crossref_option_aminer')}
                  </Radio>
                )}
                {/* FIXED: 2026-11-16 第四个来源：自己的 Zotero 库（未绑定则不显示） */}
                {zoteroLinked && (
                  <Radio
                    name="region-type"
                    value="zotero"
                    checked={region === 'zotero'}
                    onChange={() => changeRegion('zotero')}
                    disabled={isLoading}
                    inline
                    onClick={(e: any) => e.stopPropagation()}
                  >
                    Zotero
                  </Radio>
                )}
              </div>
              {region === 'zotero' && (
                <div style={{ marginTop: 8 }}>
                  {zoteroCollections.length > 0 && (
                    <>
                      <label htmlFor="zotero-collection">分类</label>
                      <FormControl
                        id="zotero-collection"
                        componentClass="select"
                        value={zoteroCollection}
                        onChange={(e: any) =>
                          setZoteroCollection(e.target.value)
                        }
                        disabled={isLoading}
                      >
                        <option value="">全部（最近修改优先）</option>
                        {zoteroCollections.map(collection => (
                          <option key={collection.key} value={collection.key}>
                            {collection.name}
                          </option>
                        ))}
                      </FormControl>
                    </>
                  )}
                  {/* FIXED: 2026-11-16 整库/本分类导入 + 把选中条目的 PDF 存进项目 */}
                  <div
                    style={{
                      marginTop: 8,
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <Button
                      bsSize="small"
                      bsStyle="default"
                      disabled={isLoading}
                      onClick={handleImportZoteroBibtex}
                      title="把 Zotero 里的全部（或当前分类）条目写入项目 .bib"
                    >
                      导入{zoteroCollection ? '本分类' : '整库'}到 .bib
                    </Button>
                    <Button
                      bsSize="small"
                      bsStyle="default"
                      disabled={isLoading || selectedItems.size === 0}
                      onClick={handleImportZoteroAttachment}
                      title="把选中文献在 Zotero 里的 PDF 存入本项目（需要 Key 有 files 权限）"
                    >
                      存入项目：选中 PDF
                    </Button>
                  </div>
                </div>
              )}
            </FormGroup>

            <div style={{ marginBottom: '15px' }}>
              <Button
                bsStyle="primary"
                onClick={(e: any) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleSearch()
                }}
                disabled={
                  isLoading ||
                  // FIXED: 2026-11-17 Zotero 档不再因关键词为空而置灰。
                  //   OLD: 非 person 档一律要求标题或作者 → Zotero 档只有关键词框，
                  //   title/author 永远为空 → 按钮恒为禁用，列表根本拉不出来。
                  (region === 'zotero'
                    ? false
                    : region === 'person'
                    ? !keywordQuery.trim()
                    : !titleQuery.trim() && !authorQuery.trim())
                }
              >
                {isLoading
                  ? t('crossref_button_search_loading')
                  : t('crossref_button_search')}
              </Button>
              <span
                style={{
                  marginLeft: '15px',
                  color: 'var(--fl-text-muted, #666)',
                  fontSize: '14px',
                }}
              >
                {region === 'zotero' && searchResults.length > 0 ? (
                  // FIXED: 2026-11-17 Zotero 档显示「共 N 条 · 匹配 M 条」，让用户知道
                  //   输入框是在本地过滤，而不是把库里的东西搜丢了
                  <>
                    {`共 ${searchResults.length} 条`}
                    {visibleResults.length !== searchResults.length
                      ? ` · 匹配 ${visibleResults.length} 条`
                      : ''}
                    {zoteroTotal != null && zoteroTotal > searchResults.length
                      ? `（库里共 ${zoteroTotal} 条，已按最近修改取前 ${searchResults.length} 条）`
                      : ''}
                    {zoteroServerQuery
                      ? `（服务器关键词：${zoteroServerQuery}）`
                      : ''}
                  </>
                ) : searchResults.length > 0 ? (
                  t('crossref_status_results_found', {
                    count: searchResults.length,
                  })
                ) : (
                  t('crossref_status_prompt_search')
                )}
                {(yearFromQuery || yearToQuery) && (
                  <span
                    style={{
                      marginLeft: '10px',
                      color: 'var(--fl-link-bright, #007bff)',
                    }}
                  >
                    {t('crossref_status_year_filter', {
                      from: yearFromQuery || '2000',
                      to: yearToQuery || '2025',
                    })}
                  </span>
                )}
              </span>
            </div>

            {searchResults.length > 0 && (
              <>
                <div
                  style={{
                    marginBottom: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '15px',
                  }}
                >
                  <Button
                    variant={
                      selectedItems.size === visibleResults.length &&
                      visibleResults.length > 0
                        ? 'warning'
                        : 'secondary'
                    }
                    size="sm"
                    onClick={handleSelectAll}
                  >
                    {selectedItems.size === visibleResults.length &&
                    visibleResults.length > 0
                      ? t('crossref_button_deselect_all')
                      : t('crossref_button_select_all')}
                  </Button>
                  <Button
                    bsStyle="success"
                    size="sm"
                    onClick={handleInsertReferences}
                    disabled={selectedItems.size === 0}
                  >
                    {t('crossref_button_insert_selected', {
                      count: selectedItems.size,
                    })}
                  </Button>
                </div>

                <div style={TABLE_CONTAINER_STYLE}>
                  <Table striped bordered hover size="sm" style={TABLE_STYLE}>
                    <thead>
                      <tr
                        style={{
                          backgroundColor: 'var(--fl-surface-raised, #f5f5f5)',
                        }}
                      >
                        <th style={COLUMN_HEADER_STYLES.select}>
                          {t('crossref_table_header_select')}
                        </th>
                        <th style={COLUMN_HEADER_STYLES.title}>
                          {t('crossref_table_header_title')}
                        </th>
                        <th style={COLUMN_HEADER_STYLES.authors}>
                          {t('crossref_table_header_authors')}
                        </th>
                        <th style={COLUMN_HEADER_STYLES.year}>
                          {t('crossref_table_header_year')}
                        </th>
                        <th style={COLUMN_HEADER_STYLES.journal}>
                          {t('crossref_table_header_journal')}
                        </th>
                        <th style={COLUMN_HEADER_STYLES.volume}>
                          {t('crossref_table_header_volume_issue')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleResults.map(item => (
                        <tr
                          key={item.hash_id}
                          style={{ cursor: 'pointer' }}
                          onClick={() => handleItemSelect(item.hash_id)}
                        >
                          <td
                            style={{
                              textAlign: 'center',
                              verticalAlign: 'top',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedItems.has(item.hash_id)}
                              onChange={() => handleItemSelect(item.hash_id)}
                              onClick={e => e.stopPropagation()}
                            />
                          </td>
                          <td style={TITLE_CELL_STYLE}>
                            <div
                              style={{
                                fontWeight: 'bold',
                                marginBottom: '3px',
                              }}
                            >
                              {item.url ? (
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    color: 'var(--fl-link, #337ab7)',
                                    textDecoration: 'none',
                                    borderBottom:
                                      '1px dotted var(--fl-link, #337ab7)',
                                  }}
                                  onClick={e => e.stopPropagation()}
                                  onMouseOver={e =>
                                    (e.currentTarget.style.textDecoration =
                                      'underline')
                                  }
                                  onMouseOut={e =>
                                    (e.currentTarget.style.textDecoration =
                                      'none')
                                  }
                                >
                                  {formatTitle(item.title)}
                                </a>
                              ) : (
                                formatTitle(item.title)
                              )}
                            </div>
                            {item.abstract && (
                              <div
                                style={ABSTRACT_PREVIEW_STYLE}
                                title={item.abstract}
                              >
                                {truncateText(
                                  item.abstract,
                                  ABSTRACT_PREVIEW_CHAR_LIMIT
                                )}
                              </div>
                            )}
                          </td>
                          <td
                            style={TEXT_CELL_STYLE}
                            title={formatAuthors(item.authors)}
                          >
                            {truncateText(
                              formatAuthors(item.authors),
                              AUTHORS_PREVIEW_CHAR_LIMIT
                            )}
                          </td>
                          <td style={YEAR_CELL_STYLE}>{item.year}</td>
                          <td
                            style={TEXT_CELL_STYLE}
                            title={formatJournal(item.container_title)}
                          >
                            {truncateText(
                              formatJournal(item.container_title),
                              JOURNAL_PREVIEW_CHAR_LIMIT
                            )}
                          </td>
                          <td style={VOLUME_CELL_STYLE}>
                            {item.volume &&
                              t('crossref_table_volume', {
                                volume: item.volume,
                              })}
                            {item.volume &&
                              item.issue &&
                              t('crossref_table_volume_issue_separator')}
                            {item.issue &&
                              t('crossref_table_issue', { issue: item.issue })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </>
            )}

            {/* FIXED: 2026-11-17 Zotero 档可能「库里拉到了但本轮过滤没命中」，
                这种情况不走「没有结果」空态，只在上面的状态行显示匹配数 */}
            {!isLoading &&
              lastQuery &&
              visibleResults.length === 0 &&
              (region === 'zotero' ? searchResults.length === 0 : true) &&
              (lastQuery.title || lastQuery.author) && (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '40px',
                    color: 'var(--fl-text-muted, #666)',
                  }}
                >
                  <div style={{ marginBottom: '10px', fontSize: '16px' }}>
                    {t('crossref_empty_title')}
                  </div>
                  <div style={{ fontSize: '14px' }}>
                    {t('crossref_empty_criteria')}
                    {lastQuery.title && (
                      <div>
                        {t('crossref_empty_criteria_title', {
                          value: lastQuery.title,
                        })}
                      </div>
                    )}
                    {lastQuery.author && (
                      <div>
                        {t('crossref_empty_criteria_author', {
                          value: lastQuery.author,
                        })}
                      </div>
                    )}
                    {(lastQuery.yearFrom || lastQuery.yearTo) && (
                      <div>
                        {t('crossref_empty_criteria_year', {
                          from: lastQuery.yearFrom || '2000',
                          to: lastQuery.yearTo || '2025',
                        })}
                      </div>
                    )}
                    {/* AMiner 档没有「模糊/精确」，这一行就别显示了 */}
                    {lastQuery.region !== 'aminer' && (
                      <div>
                        {t('crossref_empty_criteria_search_type', {
                          type:
                            lastQuery.searchType === 'fuzzy'
                              ? t('crossref_option_fuzzy')
                              : t('crossref_option_exact'),
                        })}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      marginTop: '15px',
                      fontSize: '13px',
                      color: 'var(--fl-text-subtle, #999)',
                    }}
                  >
                    {t('crossref_empty_hint')}
                  </div>
                </div>
              )}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button bsStyle="primary" onClick={handleClose} disabled={isLoading}>
            {t('crossref_button_close')}
          </Button>
        </Modal.Footer>
      </AccessibleModal>
    </>
  )
})
