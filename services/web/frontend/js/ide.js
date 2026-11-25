/* eslint-disable
    camelcase,
    max-len,
    no-cond-assign,
    no-return-assign,
    no-unused-vars,
    no-useless-escape,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS103: Rewrite code to no longer use __guard__
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import App from './base'
import FileTreeManager from './ide/file-tree/FileTreeManager'
import LoadingManager from './ide/LoadingManager'
import ConnectionManager from './ide/connection/ConnectionManager'
import EditorManager from './ide/editor/EditorManager'
import OnlineUsersManager from './ide/online-users/OnlineUsersManager'
import HistoryV2Manager from './ide/history/HistoryV2Manager'
import PermissionsManager from './ide/permissions/PermissionsManager'
import BinaryFilesManager from './ide/binary-files/BinaryFilesManager'
import ReferencesManager from './ide/references/ReferencesManager'
import MetadataManager from './ide/metadata/MetadataManager'
import './ide/review-panel/ReviewPanelManager'
import OutlineManager from './features/outline/outline-manager'
import SafariScrollPatcher from './ide/SafariScrollPatcher'
import './ide/cobranding/CobrandingDataService'
import './ide/chat/index'
import './ide/file-view/index'
import './ide/toolbar/index'
import './ide/directives/layout'
import './ide/directives/validFile'
import './ide/directives/verticalResizablePanes'
import './ide/services/ide'
import './directives/focus'
import './directives/scroll'
import './directives/onEnter'
import './directives/stopPropagation'
import './directives/rightClick'
import './directives/expandableTextArea'
import './directives/videoPlayState'
import './services/queued-http'
import './services/validateCaptcha'
import './services/validateCaptchaV3'
import './services/wait-for'
import './filters/formatDate'
import './main/event'
import './main/account-upgrade-angular'
import './main/system-messages'
import '../../modules/modules-ide'
import './features/source-editor/ide'
import './shared/context/controllers/root-context-controller'
import './features/editor-navigation-toolbar/controllers/editor-navigation-toolbar-controller'
import './features/pdf-preview/controllers/pdf-preview-controller'
import './features/share-project-modal/controllers/react-share-project-modal-controller'
import './features/source-editor/controllers/editor-switch-controller'
import './features/source-editor/controllers/cm6-switch-away-survey-controller'
import './features/source-editor/controllers/legacy-editor-warning-controller'
import './features/history/controllers/history-controller'
import './features/editor-left-menu/controllers/editor-left-menu-controller'
// FIXED: 2026-11-10 移动端四档 Tab 的挂载点（只在编辑器页面渲染，见 main.pug）
import './features/mobile-tabs/controllers/mobile-tabs-controller'
import { cleanupServiceWorker } from './utils/service-worker-cleanup'
import { reportCM6Perf } from './infrastructure/cm6-performance'
import { reportAcePerf } from './ide/editor/ace-performance'
import { debugConsole } from '@/utils/debugging'

// FIXED: 2026-11-10 移动端判定（与 Bootstrap 3 的 xs 断点一致：< 768px）。
// 用 matchMedia 而不是 UA 嗅探：平板横竖屏旋转 / 手机浏览器地址栏收起时都能正确判定。
// 逃生口：手机上确实想用完整桌面布局时，加 ?desktop=1 即可跳过移动端布局。
function shouldUseMobileLayout() {
  if (typeof window.matchMedia !== 'function') {
    return false
  }
  if (!window.matchMedia('(max-width: 767px)').matches) {
    return false
  }
  try {
    if (new URLSearchParams(window.location.search).get('desktop') === '1') {
      return false
    }
  } catch (e) {
    // URLSearchParams 不可用时忽略，按移动端处理
  }
  return true
}

App.controller('IdeController', [
  '$scope',
  '$timeout',
  'ide',
  'localStorage',
  'eventTracking',
  'metadata',
  'CobrandingDataService',
  '$window',
  function (
    $scope,
    $timeout,
    ide,
    localStorage,
    eventTracking,
    metadata,
    CobrandingDataService,
    $window
  ) {
    // Don't freak out if we're already in an apply callback
    let err, pdfLayout, userAgent
    $scope.$originalApply = $scope.$apply
    $scope.$apply = function (fn) {
      if (fn == null) {
        fn = function () {}
      }
      const phase = this.$root.$$phase
      if (phase === '$apply' || phase === '$digest') {
        return fn()
      } else {
        return this.$originalApply(fn)
      }
    }

    $scope.state = {
      loading: true,
      load_progress: 40,
      error: null,
    }
    $scope.ui = {
      leftMenuShown: false,
      view: 'editor',
      chatOpen: false,
      pdfLayout: 'sideBySide',
      // FIXED: 2026-11-10 移动端四档 Tab 的当前档位（files / source / preview / agent）。
      // 只有手机端会用；桌面端恒为 null，applyMobileTab 在 >=768px 时直接返回。
      mobileTab: null,
      pdfHidden: false,
      pdfWidth: 0,
      reviewPanelOpen: localStorage(`ui.reviewPanelOpen.${window.project_id}`),
      miniReviewPanelVisible: false,
      chatResizerSizeOpen: 7,
      chatResizerSizeClosed: 0,
    }
    $scope.user = window.user

    $scope.settings = window.userSettings
    $scope.anonymous = window.anonymous
    $scope.isTokenMember = window.isTokenMember
    $scope.isRestrictedTokenMember = window.isRestrictedTokenMember

    $scope.cobranding = {
      isProjectCobranded: CobrandingDataService.isProjectCobranded(),
      logoImgUrl: CobrandingDataService.getLogoImgUrl(),
      submitBtnHtml: CobrandingDataService.getSubmitBtnHtml(),
      brandVariationName: CobrandingDataService.getBrandVariationName(),
      brandVariationHomeUrl: CobrandingDataService.getBrandVariationHomeUrl(),
    }

    $scope.chat = {}

    ide.toggleReviewPanel = $scope.toggleReviewPanel = function () {
      $scope.$applyAsync(() => {
        if (!$scope.project.features.trackChangesVisible) {
          return
        }
        $scope.ui.reviewPanelOpen = !$scope.ui.reviewPanelOpen
        eventTracking.sendMB('rp-toggle-panel', {
          value: $scope.ui.reviewPanelOpen,
        })
      })
    }

    $scope.$watch('ui.reviewPanelOpen', function (value) {
      if (value != null) {
        return localStorage(`ui.reviewPanelOpen.${window.project_id}`, value)
      }
    })

    $scope.$on('layout:pdf:resize', function (_, layoutState) {
      $scope.ui.pdfHidden = layoutState.east.initClosed
      return ($scope.ui.pdfWidth = layoutState.east.size)
    })

    $scope.$watch('ui.view', function (newView, oldView) {
      if (newView !== oldView) {
        $scope.$broadcast('layout:flat-screen:toggle')
      }
      if (newView != null && newView !== 'editor' && newView !== 'pdf') {
        eventTracking.sendMBOnce(`ide-open-view-${newView}-once`)
      }
    })

    // FIXED: 2026-11-10 移动端布局：四档 Tab（文件 / 源码 / 预览 / AI 助手）。
    //
    // 历史：阶段 1 是「只读 PDF」—— 把布局钉死在 pdfLayout='flat' + view='pdf'。
    // 问题：导入的项目一旦主文件没选对，手机上既改不了文件也改不了主文件，
    // 编译不出来 -> AI 助手也没有产物可用，直接死锁。所以手机端要能进文件树和编辑器。
    //
    // 现在的职责划分：
    //   - 组件 features/mobile-tabs 只负责「选中哪一档」，写 $scope.ui.mobileTab；
    //   - 这里负责把档位翻译成真实布局状态 + body 上的 fl-mobile-tab-* 类，
    //     CSS（stylesheets/app/editor/mobile-pdf-only.less）据此决定哪一栏占满屏。
    //   - 预览 / AI 助手 -> view='pdf'（单栏 PDF 那个容器）；文件 / 源码 -> view='editor'
    //     （文件树和编辑器都在 layout="pdf" 那个容器里，靠 CSS 类区分露哪一栏）。
    //
    // 三条不能丢的旧经验（都是踩过的坑）：
    //  1) 直接改 ui.pdfLayout / ui.view，不调用 switchToFlatLayout ——
    //     那个会把 'flat' 写进 localStorage 的 pdf.layout，把桌面端的布局偏好一起改掉。
    //  2) 不能只靠 $watch('ui.view')（更早的版本就是这么写的，实测一次都没生效）：
    //     首次 digest 时浏览器可能还没按 viewport meta 收敛，matchMedia 仍是 980px
    //     -> 判定为“不是手机”直接返回；之后 EditorManager.openDoc 设的又是 'editor'
    //     （值没变，watcher 不会再触发），于是一次都没改。
    //     现在保留“延时强制执行几次 + 监听关键事件”。
    //  3) 只改 view / pdfLayout，不碰 ui.pdfOpen —— pdfOpen 由已有的
    //     $watch('ui.pdfLayout') 自己同步，否则会和 jquery-layout 的 resetOpenStates 互相抢占。
    //
    // 桌面端（>= 768px）或 ?desktop=1 时整段不注册，行为完全不变。
    const mobileLayout = shouldUseMobileLayout()

    const MOBILE_TABS = ['files', 'source', 'preview', 'agent']
    const MOBILE_TAB_CLASS_PREFIX = 'fl-mobile-tab-'

    const isMobileViewportNow = () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 767px)').matches

    const clearMobileTabClasses = () => {
      MOBILE_TABS.forEach(tab =>
        document.body.classList.remove(`${MOBILE_TAB_CLASS_PREFIX}${tab}`)
      )
    }

    const currentMobileTab = () =>
      MOBILE_TABS.indexOf($scope.ui.mobileTab) !== -1
        ? $scope.ui.mobileTab
        : 'preview'

    // 一个档位属于「PDF 那半边」还是「编辑器那半边」
    const tabWantsPdf = tab => tab === 'preview' || tab === 'agent'
    // 编辑器那半边有三种 view：源码、附件预览（file）、历史（history）
    const EDITOR_SIDE_VIEWS = ['editor', 'file', 'history']
    const isEditorSideView = view => EDITOR_SIDE_VIEWS.indexOf(view) !== -1

    const applyMobileTab = () => {
      if (!mobileLayout) {
        return
      }
      // 在桌面宽度下（旋转 / 放大窗口后）把类摘干净，别把手机布局漏到桌面
      if (!isMobileViewportNow()) {
        clearMobileTabClasses()
        return
      }
      const tab = currentMobileTab()
      if ($scope.ui.mobileTab !== tab) {
        $scope.ui.mobileTab = tab
      }
      // 不碰 ui.pdfOpen（见上面第 3 条）
      if ($scope.ui.pdfLayout !== 'flat') {
        $scope.ui.pdfLayout = 'flat'
      }
      // 只在「站错半边」时才改 view：站对了就别动，
      // 否则会把 file（附件预览）/ history（历史）一并踩掉，等于手机上打不开。
      const wantsPdf = tabWantsPdf(tab)
      const onPdfSide = $scope.ui.view === 'pdf'
      if (wantsPdf && !onPdfSide) {
        $scope.ui.view = 'pdf'
      } else if (!wantsPdf && !isEditorSideView($scope.ui.view)) {
        $scope.ui.view = 'editor'
      }
      clearMobileTabClasses()
      document.body.classList.add(`${MOBILE_TAB_CLASS_PREFIX}${tab}`)
    }

    if (mobileLayout) {
      if ($scope.ui.mobileTab == null) {
        $scope.ui.mobileTab = 'preview'
      }
      // 0/300/1000/2500ms 各强制一次：等 viewport 收敛、等文档打开、等 jquery-layout 初始化
      ;[0, 300, 1000, 2500].forEach(delay => $timeout(applyMobileTab, delay))
      // 离开编辑器页面时把类摘掉，别让 fl-mobile-tab-* 跟着跑到别的页面上去
      $scope.$on('$destroy', clearMobileTabClasses)
      $scope.$on('project:joined', () => $timeout(applyMobileTab, 0))
      $scope.$on('ide:loaded', () => $timeout(applyMobileTab, 0))
      // 在「文件」档点开一个文件 -> 自动跳到「源码」档，
      // 否则用户点了文件却发现屏幕没变化（文件树还占着屏）。
      $scope.$on('doc:opened', () => {
        if (currentMobileTab() === 'files') {
          $scope.ui.mobileTab = 'source'
        }
        $timeout(applyMobileTab, 0)
      })

      // Tab 切换：唯一入口。$timeout 0 是为了避开当前 digest
      $scope.$watch('ui.mobileTab', (newTab, oldTab) => {
        if (newTab !== oldTab) {
          $timeout(applyMobileTab, 0)
        }
      })

      // 后续如果哪里又把视图改了，这里按当前档位校正。
      // 注意放行 ui.view = 'file'（点开图片/PDF 附件走的是它）和 'history'：
      // 老版本把 view 直接钉成 'pdf'，手机上附件和历史等于打不开。
      $scope.$watch('ui.view', function (newView) {
        // 布局被改回桌面形态了（别的入口开了 sideBySide）：整体重钉一次
        if ($scope.ui.pdfLayout !== 'flat') {
          applyMobileTab()
          return
        }
        const tab = currentMobileTab()

        // 附件预览 / 历史都渲染在中间那一栏里：「文件」档把中间那栏藏了，
        // 「预览 / Agent」档整块都不显示 —— 都得换到「源码」档，
        // 否则用户点开一张图，屏幕上什么都没有。
        if (newView === 'file' || newView === 'history') {
          if (tab !== 'source') {
            $scope.ui.mobileTab = 'source'
          }
          return
        }

        // 预览 / Agent 档只接受 pdf 视图
        if (tabWantsPdf(tab)) {
          if (newView !== 'pdf') {
            applyMobileTab()
          }
          return
        }

        // 文件 / 源码档不接受 pdf 视图：那会让编辑器那半边整块消失
        if (newView === 'pdf') {
          applyMobileTab()
        }
      })

      // 横竖屏旋转 / 窗口缩放：CSS 会自己跟着 media query 变，
      // 但 jquery-layout 和 PDF 画布的尺寸是算出来的，得让它们重新量一次。
      if (typeof window.matchMedia === 'function') {
        const mql = window.matchMedia('(max-width: 767px)')
        const onViewportChange = () => {
          applyMobileTab()
          // 让 jquery-layout / ResizeObserver 重新量尺寸
          window.dispatchEvent(new Event('resize'))
        }
        if (mql.addEventListener) {
          mql.addEventListener('change', onViewportChange)
        }
      }
    }

    $scope.$watch('ui.chatOpen', function (isOpen) {
      if (isOpen) {
        eventTracking.sendMBOnce('ide-open-chat-once')
      }
    })

    $scope.$watch('ui.leftMenuShown', function (isOpen) {
      if (isOpen) {
        eventTracking.sendMBOnce('ide-open-left-menu-once')
      }
    })

    $scope.trackHover = feature => {
      eventTracking.sendMBOnce(`ide-hover-${feature}-once`)
    }
    // End of tracking code.

    window._ide = ide

    ide.validFileRegex = '^[^*/]*$' // Don't allow * and /

    const useFallbackWebsocket =
      window.location &&
      window.location.search &&
      window.location.search.match(/ws=fallback/)
    // if we previously failed to load the websocket fall back to null (the siteUrl)
    ide.wsUrl = useFallbackWebsocket ? null : window.sharelatex.wsUrl || null // websocket url (if defined)

    ide.project_id = $scope.project_id = window.project_id
    ide.$scope = $scope

    ide.referencesSearchManager = new ReferencesManager(ide, $scope)
    ide.loadingManager = new LoadingManager($scope)
    ide.connectionManager = new ConnectionManager(ide, $scope)
    ide.fileTreeManager = new FileTreeManager(ide, $scope)
    ide.editorManager = new EditorManager(
      ide,
      $scope,
      localStorage,
      eventTracking
    )
    ide.onlineUsersManager = new OnlineUsersManager(ide, $scope)
    ide.historyManager = new HistoryV2Manager(ide, $scope, localStorage)
    ide.permissionsManager = new PermissionsManager(ide, $scope)
    ide.binaryFilesManager = new BinaryFilesManager(ide, $scope)
    ide.metadataManager = new MetadataManager(ide, $scope, metadata)
    ide.outlineManager = new OutlineManager(ide, $scope)

    let inited = false
    $scope.$on('project:joined', function () {
      if (inited) {
        return
      }
      inited = true
      if (
        __guard__(
          $scope != null ? $scope.project : undefined,
          x => x.deletedByExternalDataSource
        )
      ) {
        ide.showGenericMessageModal(
          'Project Renamed or Deleted',
          `\
This project has either been renamed or deleted by an external data source such as Dropbox.
We don't want to delete your data, so this project still contains your history and collaborators.
If the project has been renamed please look in your project list for a new project under the new name.\
`
        )
      }
      return $timeout(function () {
        if ($scope.permissions.write) {
          let _labelsInitialLoadDone
          ide.metadataManager.loadProjectMetaFromServer()
          return (_labelsInitialLoadDone = true)
        }
      }, 200)
    })

    // Count the first 'doc:opened' as a sign that the ide is loaded
    // and broadcast a message. This is a good event to listen for
    // if you want to wait until the ide is fully loaded and initialized
    let _loaded = false
    $scope.$on('doc:opened', function () {
      if (_loaded) {
        return
      }
      $scope.$broadcast('ide:loaded')
      return (_loaded = true)
    })

    ide.editingSessionHeartbeat = () => {
      eventTracking.editingSessionHeartbeat(() => {
        const editorType = ide.editorManager.getEditorType()

        const segmentation = {
          editorType,
        }

        if (editorType === 'cm6' || editorType === 'cm6-rich-text') {
          const cm6PerfData = reportCM6Perf()

          // Ignore if no typing has happened
          if (cm6PerfData.numberOfEntries > 0) {
            const perfProps = [
              'Max',
              'Mean',
              'Median',
              'NinetyFifthPercentile',
              'DocLength',
              'NumberOfEntries',
              'MaxUserEventsBetweenDomUpdates',
              'Grammarly',
              'SessionLength',
              'Memory',
              'Lags',
              'NonLags',
              'LongestLag',
              'MeanLagsPerMeasure',
              'MeanKeypressesPerMeasure',
              'MeanKeypressPaint',
              'LongTasks',
              'Release',
            ]

            for (const prop of perfProps) {
              const perfValue =
                cm6PerfData[prop.charAt(0).toLowerCase() + prop.slice(1)]
              if (perfValue !== null) {
                segmentation['cm6Perf' + prop] = perfValue
              }
            }
          }
        } else if (editorType === 'ace') {
          const acePerfData = reportAcePerf()

          if (acePerfData.numberOfEntries > 0) {
            const perfProps = [
              'NumberOfEntries',
              'MeanKeypressPaint',
              'Grammarly',
              'SessionLength',
              'Memory',
              'Lags',
              'NonLags',
              'LongestLag',
              'MeanLagsPerMeasure',
              'MeanKeypressesPerMeasure',
              'Release',
            ]

            for (const prop of perfProps) {
              const perfValue =
                acePerfData[prop.charAt(0).toLowerCase() + prop.slice(1)]
              if (perfValue !== null) {
                segmentation['acePerf' + prop] = perfValue
              }
            }
          }
        }

        return segmentation
      })
    }

    $scope.$on('cursor:editor:update', () => {
      ide.editingSessionHeartbeat()
    })
    $scope.$on('scroll:editor:update', () => {
      ide.editingSessionHeartbeat()
    })

    angular.element($window).on('click', ide.editingSessionHeartbeat)

    $scope.$on('$destroy', () =>
      angular.element($window).off('click', ide.editingSessionHeartbeat)
    )

    const DARK_THEMES = [
      'ambiance',
      'chaos',
      'clouds_midnight',
      'cobalt',
      'idle_fingers',
      'merbivore',
      'merbivore_soft',
      'mono_industrial',
      'monokai',
      'pastel_on_dark',
      'solarized_dark',
      'terminal',
      'tomorrow_night',
      'tomorrow_night_blue',
      'tomorrow_night_bright',
      'tomorrow_night_eighties',
      'twilight',
      'vibrant_ink',
    ]
    $scope.darkTheme = false
    $scope.$watch('settings.editorTheme', function (theme) {
      if (Array.from(DARK_THEMES).includes(theme)) {
        return ($scope.darkTheme = true)
      } else {
        return ($scope.darkTheme = false)
      }
    })

    ide.localStorage = localStorage

    ide.browserIsSafari = false

    $scope.switchToFlatLayout = function (view) {
      $scope.ui.pdfLayout = 'flat'
      $scope.ui.view = view
      return ide.localStorage('pdf.layout', 'flat')
    }

    $scope.switchToSideBySideLayout = function (view) {
      $scope.ui.pdfLayout = 'sideBySide'
      $scope.ui.view = view
      return localStorage('pdf.layout', 'split')
    }

    if ((pdfLayout = localStorage('pdf.layout'))) {
      if (pdfLayout === 'split') {
        $scope.switchToSideBySideLayout()
      }
      if (pdfLayout === 'flat') {
        $scope.switchToFlatLayout()
      }
    } else {
      $scope.switchToSideBySideLayout()
    }

    // Update ui.pdfOpen when the layout changes.
    // The east pane should open when the layout changes from "Editor only" or "PDF only" to "Editor & PDF".
    $scope.$watch('ui.pdfLayout', value => {
      $scope.ui.pdfOpen = value === 'sideBySide'
    })

    // Update ui.pdfLayout when the east pane is toggled.
    // The layout should be set to "Editor & PDF" (sideBySide) when the east pane is opened, and "Editor only" (flat) when the east pane is closed.
    $scope.$watch('ui.pdfOpen', value => {
      $scope.ui.pdfLayout = value ? 'sideBySide' : 'flat'
      if (value) {
        window.dispatchEvent(new CustomEvent('ui:pdf-open'))
      }
    })

    $scope.handleKeyDown = () => {
      // unused?
    }

    try {
      ;({ userAgent } = navigator)
      ide.browserIsSafari =
        userAgent &&
        /.*Safari\/.*/.test(userAgent) &&
        !/.*Chrome\/.*/.test(userAgent) &&
        !/.*Chromium\/.*/.test(userAgent)
    } catch (error) {
      err = error
      debugConsole.error(err)
    }

    if (ide.browserIsSafari) {
      ide.safariScrollPatcher = new SafariScrollPatcher($scope)
    }

    // Fix Chrome 61 and 62 text-shadow rendering
    let browserIsChrome61or62 = false
    try {
      const chromeVersion =
        parseFloat(navigator.userAgent.split(' Chrome/')[1]) || null
      browserIsChrome61or62 = chromeVersion != null
      if (browserIsChrome61or62) {
        document.styleSheets[0].insertRule(
          '.ace_editor.ace_autocomplete .ace_completion-highlight { text-shadow: none !important; font-weight: bold; }',
          1
        )
      }
    } catch (error1) {
      err = error1
      debugConsole.error(err)
    }

    // User can append ?ft=somefeature to url to activate a feature toggle
    ide.featureToggle = __guard__(
      __guard__(
        typeof location !== 'undefined' && location !== null
          ? location.search
          : undefined,
        x1 => x1.match(/^\?ft=(\w+)$/)
      ),
      x => x[1]
    )

    // Listen for editor:lint event from CM6 linter
    window.addEventListener('editor:lint', event => {
      $scope.hasLintingError = event.detail.hasLintingError
    })

    ide.socket.on('project:access:revoked', () => {
      ide.showGenericMessageModal(
        'Removed From Project',
        'You have been removed from this project, and will no longer have access to it. You will be redirected to your project dashboard momentarily.'
      )
    })

    return ide.socket.on('project:publicAccessLevel:changed', data => {
      if (data.newAccessLevel != null) {
        ide.$scope.project.publicAccesLevel = data.newAccessLevel
        return $scope.$digest()
      }
    })
  },
])

cleanupServiceWorker()

angular.module('SharelatexApp').config([
  '$provide',
  function ($provide) {
    $provide.decorator('$browser', [
      '$delegate',
      function ($delegate) {
        $delegate.onUrlChange = function () {}
        $delegate.url = function () {
          return ''
        }
        return $delegate
      },
    ])
  },
])

export default angular.bootstrap(document.body, ['SharelatexApp'])

function __guard__(value, transform) {
  return typeof value !== 'undefined' && value !== null
    ? transform(value)
    : undefined
}
