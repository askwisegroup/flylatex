import { isMainFile } from './editor-files'
import getMeta from '../../../utils/meta'
import i18n from '../../../i18n'
import { showToast } from '../../../shared/utils/toast'
import { deleteJSON, postJSON } from '../../../infrastructure/fetch-json'
import { debounce } from 'lodash'
import { trackPdfDownload } from './metrics'
import { enablePdfCaching } from './pdf-caching-flags'
import { debugConsole } from '@/utils/debugging'

const AUTO_COMPILE_MAX_WAIT = 5000
// We add a 2 second debounce to sending user changes to server if they aren't
// collaborating with anyone. This needs to be higher than SINGLE_USER_FLUSH_DELAY, and allow for
// client to server latency, otherwise we compile before the op reaches the server
// and then again on ack.
const AUTO_COMPILE_DEBOUNCE = 2500

const searchParams = new URLSearchParams(window.location.search)

export default class DocumentCompiler {
  constructor({
    compilingRef,
    projectId,
    rootDocId,
    setChangedAt,
    setSavedAt,
    setCompiling,
    setData,
    setFirstRenderDone,
    setDeliveryLatencies,
    setError,
    cleanupCompileResult,
    signal,
  }) {
    this.compilingRef = compilingRef
    this.projectId = projectId
    this.rootDocId = rootDocId
    this.setChangedAt = setChangedAt
    this.setSavedAt = setSavedAt
    this.setCompiling = setCompiling
    this.setData = setData
    this.setFirstRenderDone = setFirstRenderDone
    this.setDeliveryLatencies = setDeliveryLatencies
    this.setError = setError
    this.cleanupCompileResult = cleanupCompileResult
    this.signal = signal

    this.clsiServerId = null
    this.currentDoc = null
    this.error = undefined
    this.timer = 0
    this.defaultOptions = {
      draft: false,
      stopOnFirstError: false,
    }

    this.debouncedAutoCompile = debounce(
      () => {
        this.compile({ isAutoCompileOnChange: true })
      },
      AUTO_COMPILE_DEBOUNCE,
      {
        maxWait: AUTO_COMPILE_MAX_WAIT,
      }
    )
  }

  /**
   * FIXED: 2026-11-08 阶段③：打开项目时的“能省就省”编译。
   *
   * 旧行为：打开项目后无条件发一次 compile（本文件下方那句注释“always compile
   * the PDF once after opening the project”），而 CLSI 编译前会删掉 output.pdf、
   * 重写所有打开的 doc，latexmk 于是必须真跑 2~3 遍——什么都没改也照样烧 CPU。
   *
   * 新行为（仅在服务端开关 COMPILE_FRESHNESS_ENABLED=true 时生效）：
   *   1. 先问 GET /project/:id/compile/fresh：“内容跟上次成功编译一样吗？”
   *   2. 一样 → 再 HEAD 一下上次的 output.pdf 还在不在
   *   3. 都在 → 不发编译请求，直接挂上上次的 PDF
   *   4. 任何一步不满足（未开启 / 不新鲜 / 产物没了 / 报错）→ 走原来的编译
   */
  async compileOnLoad(options = {}) {
    if (getMeta('ol-preventCompileOnLoad')) {
      return
    }
    try {
      const data = await this.canReuseLastPdf()
      if (data) {
        debugConsole.log(
          '[compile] 内容与上次成功编译一致，跳过编译，复用上次的 PDF'
        )
        this.setChangedAt(0)
        this.setSavedAt(0)
        this.setError(undefined)
        // FIXED: 2026-11-03 不能传 true
        //
        // firstRenderDone 这个状态值必须是**函数**：正常编译时 compiler.js 下面用
        // setFirstRenderDone(() => firstRenderDone) 装的是 metrics 那边的回调，
        // pdf-js-viewer.jsx 在 pagesinit / pagerendered 时会直接 firstRenderDone({...})。
        // 传 true 的话那一下就是 TypeError: firstRenderDone is not a function，
        // 而它是在 pdfjs 的 eventBus 回调里抛的，只会留下一条没人看的异常。
        // 不设就行：默认值本来就是可调用的 noop，真正的首帧由 pdfjs 上报。
        this.setCompiling(false)
        this.setData(data)
        return
      }
    } catch (error) {
      // 任何异常都当成“不可复用”，宁可多编一次
      debugConsole.error('[compile] freshness check failed, compiling', error)
    }
    return await this.compile({ ...options, isAutoCompileOnLoad: true })
  }

  // 能复用上次产物时返回一份“和编译成功同形状”的结果，否则返回 null
  async canReuseLastPdf() {
    const params = new URLSearchParams({ check: 'silent' })
    params.set('draft', String(Boolean(this.defaultOptions.draft)))
    params.set(
      'stop_on_first_error',
      String(Boolean(this.defaultOptions.stopOnFirstError))
    )
    const rootDocId = this.getRootDocOverrideId()
    if (rootDocId) {
      params.set('root_doc_id', rootDocId)
    }

    const response = await window.fetch(
      `/project/${this.projectId}/compile/fresh?${params}`,
      { credentials: 'same-origin' }
    )
    if (!response.ok) {
      // 刻意不用 debugConsole：这条是排障用的“一行结论”，只有打开项目时出现一次，
      // 不是逐帧日志。控制台连这一行都没有，就说明前端 bundle 没更新。
      // eslint-disable-next-line no-console
      console.info('[编译复用] 新鲜度接口不可用', response.status)
      return null
    }
    const freshness = await response.json()
    // eslint-disable-next-line no-console
    console.info('[编译复用]', {
      skipEnabled: freshness && freshness.skipEnabled,
      fresh: freshness && freshness.fresh,
      reason: freshness && freshness.reason,
    })
    if (!freshness || !freshness.skipEnabled || !freshness.fresh) {
      return null
    }

    // 指纹说内容没变，但产物可能已经被清理（编译目录 / 输出缓存有 TTL），
    // 所以再确认一下 PDF 真的还在，否则还是老实编译。
    const pdfPath = this.getReusablePdfPath()
    if (!pdfPath) return null
    const head = await window.fetch(pdfPath, {
      method: 'HEAD',
      credentials: 'same-origin',
    })
    if (!head.ok) {
      // eslint-disable-next-line no-console
      console.info('[编译复用] 上次的 PDF 已不存在，改为正常编译', head.status)
      return null
    }
    // eslint-disable-next-line no-console
    console.info('[编译复用] 命中：跳过编译，直接复用上次的 PDF')

    return {
      status: 'success',
      compileGroup: undefined,
      clsiServerId: this.clsiServerId || undefined,
      // 编译目录里的上一次产物（不是 build 缓存，所以不受 1 小时 TTL 限制）
      outputFiles: [
        {
          path: 'output.pdf',
          url: pdfPath,
          type: 'pdf',
          build: null,
          createdAt: new Date(),
        },
      ],
      options: { isAutoCompileOnLoad: true, reusedLastPdf: true },
      stats: {},
      timings: {},
    }
  }

  getReusablePdfPath() {
    // FIXED: 2026-11-08 之前这里拼的是 /project/:id/user/:uid/output/output.pdf，
    // 那是 **CLSI 内部** 的路径（由 web 端 proxyToClsi 转发才行），浏览器直接访问会 404，
    // 于是 HEAD 永远失败 → 每次刷新还是老老实实编译。
    // 改用浏览器真能打开的那条路由：CompileController.downloadPdf（PDF 下载按钮同款，
    // 内部会转发到 clsi 的最新 build），只要上次编译成功过就一定拿得到。
    return `/project/${this.projectId}/output/output.pdf`
  }

  // The main "compile" function.
  // Call this directly to run a compile now, otherwise call debouncedAutoCompile.
  async compile(options = {}) {
    options = { ...this.defaultOptions, ...options }

    if (options.isAutoCompileOnLoad && getMeta('ol-preventCompileOnLoad')) {
      return
    }

    // set "compiling" to true (in the React component's state), and return if it was already true
    const wasCompiling = this.compilingRef.current
    this.setCompiling(true)

    if (wasCompiling) {
      if (options.isAutoCompileOnChange) {
        this.debouncedAutoCompile()
      }
      return
    }

    try {
      // reset values
      this.setChangedAt(0) // TODO: wait for doc:saved?
      this.setSavedAt(0)
      this.validationIssues = undefined

      window.dispatchEvent(new CustomEvent('flush-changes')) // TODO: wait for this?

      const params = this.buildCompileParams(options)

      const t0 = performance.now()

      const body = {
        rootDoc_id: this.getRootDocOverrideId(),
        draft: options.draft,
        check: 'silent', // NOTE: 'error' and 'validate' are possible, but unused
        // use incremental compile for all users but revert to a full compile
        // if there was previously a server error
        incrementalCompilesEnabled: !this.error,
        stopOnFirstError: options.stopOnFirstError,
      }

      const data = await postJSON(
        `/project/${this.projectId}/compile?${params}`,
        { body, signal: this.signal }
      )

      // FIXED: 2026-11-08 服务端复用了上次结果时，这里不会有任何编译耗时。
      // 打一行，方便一眼区分「服务端跳过」和「真的在编译」。
      if (data.skippedCompile) {
        // eslint-disable-next-line no-console
        console.info('[编译复用] 服务端已跳过编译，直接复用上次结果')
      }

      // FIXED: 2026-11-02 后端按编译日志自动切换了编译器（
      // 设置 → 编译与项目 → 自动探测编译器）—— 轻提示一下，不打断输入：
      // 用户需要知道“编译器变了”，否则会以为下一份文档也变回去了。
      if (data.autoSwitchedCompiler) {
        showToast(
          i18n.t('compiler_auto_switched', {
            compiler: data.autoSwitchedCompiler,
          }),
          { fadeOut: true, duration: 2600 }
        )
      }

      const compileTimeClientE2E = Math.ceil(performance.now() - t0)
      const { deliveryLatencies, firstRenderDone } = trackPdfDownload(
        data,
        compileTimeClientE2E,
        t0
      )
      this.setDeliveryLatencies(() => deliveryLatencies)
      this.setFirstRenderDone(() => firstRenderDone)

      // unset the error before it's set again later, so that components are recreated and events are tracked
      this.setError(undefined)

      data.options = options
      if (data.clsiServerId) {
        this.clsiServerId = data.clsiServerId
      }
      this.setData(data)
    } catch (error) {
      debugConsole.error(error)
      this.cleanupCompileResult()
      this.setError(error.info?.statusCode === 429 ? 'rate-limited' : 'error')
    } finally {
      this.setCompiling(false)
    }
  }

  // parse the text of the current doc in the editor
  // if it contains "\documentclass" then use this as the root doc
  getRootDocOverrideId() {
    // only override when not in the root doc itself
    if (this.currentDoc.doc_id !== this.rootDocId) {
      const snapshot = this.currentDoc.getSnapshot()

      if (snapshot && isMainFile(snapshot)) {
        return this.currentDoc.doc_id
      }
    }

    return null
  }

  // build the query parameters added to post-compile requests
  buildPostCompileParams() {
    const params = new URLSearchParams()

    // the id of the CLSI server that processed the previous compile request
    if (this.clsiServerId) {
      params.set('clsiserverid', this.clsiServerId)
    }

    return params
  }

  // build the query parameters for the compile request
  buildCompileParams(options) {
    const params = new URLSearchParams()

    // note: no clsiserverid query param is set on "compile" requests,
    // as this is added in the backend by the web api

    // tell the server whether this is an automatic or manual compile request
    if (options.isAutoCompileOnLoad || options.isAutoCompileOnChange) {
      params.set('auto_compile', 'true')
    }

    // use the feature flag to enable PDF caching
    if (enablePdfCaching) {
      params.set('enable_pdf_caching', 'true')
    }

    // use the feature flag to enable "file line errors"
    if (searchParams.get('file_line_errors') === 'true') {
      params.file_line_errors = 'true'
    }

    // temporary override to force the new compile timeout
    const newCompileTimeoutOverride = new URLSearchParams(
      window.location.search
    ).get('force_new_compile_timeout')
    if (newCompileTimeoutOverride) {
      params.set('force_new_compile_timeout', newCompileTimeoutOverride)
    }

    return params
  }

  // send a request to stop the current compile
  stopCompile() {
    // NOTE: no stoppingCompile state, as this should happen fairly quickly
    // and doesn't matter if it runs twice.

    const params = this.buildPostCompileParams()

    return postJSON(`/project/${this.projectId}/compile/stop?${params}`, {
      signal: this.signal,
    })
      .catch(error => {
        debugConsole.error(error)
        this.setError('error')
      })
      .finally(() => {
        this.setCompiling(false)
      })
  }

  // send a request to clear the cache
  clearCache() {
    const params = this.buildPostCompileParams()

    return deleteJSON(`/project/${this.projectId}/output?${params}`, {
      signal: this.signal,
    }).catch(error => {
      debugConsole.error(error)
      this.setError('clear-cache')
    })
  }

  setOption(option, value) {
    this.defaultOptions[option] = value
  }
}
