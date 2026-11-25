/* eslint-disable
    max-len,
    no-return-assign,
    no-useless-escape,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import App from '../../base'
import _ from 'lodash'
import '../../vendor/libs/jquery-layout'
import '../../vendor/libs/jquery.ui.touch-punch'

export default App.directive('layout', [
  '$parse',
  '$compile',
  'ide',
  function ($parse, $compile, ide) {
    return {
      compile() {
        return {
          pre(scope, element, attrs) {
            let customTogglerEl, spacingClosed, spacingOpen, state
            const name = attrs.layout

            const { customTogglerPane } = attrs
            const { customTogglerMsgWhenOpen } = attrs
            const { customTogglerMsgWhenClosed } = attrs
            const hasCustomToggler =
              customTogglerPane != null &&
              customTogglerMsgWhenOpen != null &&
              customTogglerMsgWhenClosed != null

            if (attrs.spacingOpen != null) {
              spacingOpen = parseInt(attrs.spacingOpen, 10)
            } else {
              spacingOpen = 7
            }

            if (attrs.spacingClosed != null) {
              spacingClosed = parseInt(attrs.spacingClosed, 10)
            } else {
              spacingClosed = 7
            }

            const options = {
              spacing_open: spacingOpen,
              spacing_closed: spacingClosed,
              slidable: false,
              enableCursorHotkey: false,
              onopen: pane => {
                return onPaneOpen(pane)
              },
              onclose: pane => {
                return onPaneClose(pane)
              },
              onresize: () => {
                return onInternalResize()
              },
              maskIframesOnResize: scope.$eval(
                attrs.maskIframesOnResize || 'false'
              ),
              // FIXED: 2026-10-30 jquery-layout 默认的 stateKeys 只有
              // east.size,west.size,east.isClosed,west.isClosed —— 不含 south，
              // 底部停靠面板的尺寸/开合不会被保存。这里显式列全。
              stateManagement: {
                stateKeys:
                  'east.size,west.size,south.size,east.isClosed,west.isClosed,south.isClosed',
              },
              east: {
                size: scope.$eval(attrs.initialSizeEast),
                initClosed: scope.$eval(attrs.initClosedEast),
              },
              west: {
                size: scope.$eval(attrs.initialSizeWest),
                initClosed: scope.$eval(attrs.initClosedWest),
              },
              // FIXED: 2026-10-30 AI 面板「底部停靠」用 jquery-layout 自带的 south 面板：
              // 拖动条、ns-resize 光标、尺寸持久化都是库提供的，不用自己实现。
              south: {
                size: scope.$eval(attrs.initialSizeSouth),
                initClosed: scope.$eval(attrs.initClosedSouth),
                minSize: 160,
                // 底部停靠只由 AI 面板的开关控制；关掉 slide，
                // 免得鼠标扫过底边时面板自己滑出来
                slidable: false,
              },
            }

            // Restore previously recorded state
            if ((state = ide.localStorage(`layout.${name}`)) != null) {
              if (state.east != null) {
                // FIXED: 2026-10-30 不再要求"上次是打开的"才恢复尺寸。
                // 收起状态下刷新会把宽度退回默认值，用户再展开就不是原来那个宽度了。
                if (
                  attrs.minimumRestoreSizeEast == null ||
                  state.east.size >= attrs.minimumRestoreSizeEast
                ) {
                  options.east = state.east
                }
                options.east.initClosed = state.east.initClosed
              }
              if (state.west != null) {
                // FIXED: 2026-10-30 同上：收起状态也要记住上次的宽度
                if (
                  attrs.minimumRestoreSizeWest == null ||
                  state.west.size >= attrs.minimumRestoreSizeWest
                ) {
                  options.west = state.west
                }
                // FIXED: 2026-10-30 文件树收起后刷新又会自己展开，而且因为下面的
                // 尺寸恢复要求 !initClosed，宽度也会回到默认值。用户要求记住这个状态。
                // OLD: 注释掉，让文件树每次重新打开
                options.west.initClosed = state.west.initClosed
              }
            }

            if (state && state.south != null) {
              // FIXED: 2026-10-30 同上：收起状态也要记住上次的高度
              if (
                attrs.minimumRestoreSizeSouth == null ||
                state.south.size >= attrs.minimumRestoreSizeSouth
              ) {
                options.south = state.south
              }
              options.south.initClosed = state.south.initClosed
            }

            options.east.resizerCursor = 'ew-resize'
            options.west.resizerCursor = 'ew-resize'
            options.south.resizerCursor = 'ns-resize'
            options.south.minSize = 160

            function repositionControls() {
              state = layout.readState()
              if (state.east != null) {
                const controls = element.find('> .ui-layout-resizer-controls')
                if (state.east.initClosed) {
                  return controls.hide()
                } else {
                  controls.show()
                  return controls.css({
                    right: state.east.size,
                  })
                }
              }
            }

            // FIXED: 2026-11-01 底部停靠展开时，折叠把手还按整个区域的一半算竖直位置，
            // 结果那个「>」按钮垂在 AI 面板正中间。这里改成按（总高 − 停靠高度）取中心。
            function repositionCustomTogglerVertically() {
              if (customTogglerEl == null) {
                return
              }
              let southHeight = 0
              if (
                layout.panes != null &&
                layout.panes.south != null &&
                layout.state != null &&
                layout.state.south != null &&
                layout.state.south.isClosed === false
              ) {
                southHeight = $(layout.panes.south).outerHeight() || 0
              }
              if (southHeight > 0) {
                customTogglerEl.css(
                  'top',
                  `calc((100% - ${southHeight}px) / 2)`
                )
              } else {
                // 停靠收起（或这个布局没有 south 面板）：交还给 CSS 的 top: 50%
                customTogglerEl.css('top', '')
              }
            }

            function repositionCustomToggler() {
              if (customTogglerEl == null) {
                return
              }
              repositionCustomTogglerVertically()
              state = layout.readState()
              const positionAnchor =
                customTogglerPane === 'east' ? 'right' : 'left'
              const paneState = state[customTogglerPane]
              if (paneState != null) {
                return customTogglerEl.css(
                  positionAnchor,
                  paneState.initClosed ? 0 : paneState.size
                )
              }
            }

            function resetOpenStates() {
              state = layout.readState()
              if (attrs.openEast != null && state.east != null) {
                const openEast = $parse(attrs.openEast)
                return openEast.assign(scope, !state.east.initClosed)
              }
            }

            // FIXED: 2026-10-29 把"保存面板尺寸"抽出来，拖动时也要存。
            // 原来只在 $(window).unload() 里存，现代浏览器/直接刷新/切页时这个时机
            // 经常不触发，于是每次进来面板宽度都回到默认值（用户每次都要重新拖一次）。
            // 存的是全局 localStorage（ide.localStorage），所以三个项目都通用。
            let saveStateTimer = null
            let layoutReady = false
            function saveState() {
              // FIXED: 2026-10-30 初始化过程中 readState() 不完整，写进去会把好状态覆盖掉
              if (!layoutReady) return
              // Save only the state properties for the current layout, ignoring sublayouts inside it.
              // If we save sublayouts state (`children`), the layout library will use it when
              // initializing. This raises errors when the sublayout elements aren't available (due to
              // being loaded at init or just not existing for the current project/user).
              const stateToSave = _.mapValues(layout.readState(), pane =>
                _.omit(pane, 'children')
              )
              ide.localStorage(`layout.${name}`, stateToSave)
            }

            function saveStateSoon() {
              if (saveStateTimer != null) {
                clearTimeout(saveStateTimer)
              }
              saveStateTimer = setTimeout(() => {
                saveStateTimer = null
                try {
                  saveState()
                } catch (e) {
                  // 保存失败不应影响交互
                }
              }, 300)
            }

            // Someone moved the resizer
            function onInternalResize() {
              state = layout.readState()
              scope.$broadcast(`layout:${name}:resize`, state)
              repositionControls()
              if (hasCustomToggler) {
                repositionCustomToggler()
              }
              saveStateSoon()
              return resetOpenStates()
            }

            let oldWidth = element.width()
            // Something resized our parent element
            const onExternalResize = function () {
              if (
                attrs.resizeProportionally != null &&
                scope.$eval(attrs.resizeProportionally)
              ) {
                const eastState = layout.readState().east
                if (eastState != null) {
                  const currentWidth = element.width()
                  if (currentWidth > 0) {
                    const newInternalWidth =
                      (eastState.size / oldWidth) * currentWidth
                    oldWidth = currentWidth
                    layout.sizePane('east', newInternalWidth)
                  }
                  // FIXED: 2026-10-30 宽度不变、只有高度变（底部停靠开合/拖动）时，
                  // 原来直接 return，导致 PDF / 编辑器面板高度不跟着重排，溢出到停靠区下面。
                  ide.$timeout(() => {
                    layout.resizeAll()
                  })
                  return
                }
              }

              ide.$timeout(() => {
                layout.resizeAll()
              })
            }

            const layout = element.layout(options)
            layout.resizeAll()
            layoutReady = true

            // FIXED: 2026-10-30 AI 面板「底部停靠」的开关。
            // 走原生 DOM 事件是因为调用方是 React（codemirror-ai-chat），拿不到 angular scope。
            if (layout.panes != null && layout.panes.south != null) {
              const onAiDock = function (event) {
                const open = Boolean(event.detail && event.detail.open)
                if (open) {
                  layout.open('south')
                } else {
                  layout.close('south')
                }
                // FIXED: 2026-11-01 open/close 只动 pane，不会重算 east/west 拖动条的高度，
                // 于是拖动条一直拖到停靠区下面、折叠把手也不归位。这里整体重排一次。
                ide.$timeout(() => {
                  layout.resizeAll()
                  repositionCustomToggler()
                })
              }
              document.addEventListener('fl:ai-dock', onAiDock)
              scope.$on('$destroy', () => {
                document.removeEventListener('fl:ai-dock', onAiDock)
              })
            }

            if (attrs.resizeOn != null) {
              for (const event of Array.from(attrs.resizeOn.split(','))) {
                scope.$on(event, () => onExternalResize())
              }
            }

            if (hasCustomToggler) {
              state = layout.readState()
              const customTogglerScope = scope.$new()

              customTogglerScope.isOpen = true
              customTogglerScope.isVisible = true

              if (
                (state[customTogglerPane] != null
                  ? state[customTogglerPane].initClosed
                  : undefined) === true
              ) {
                customTogglerScope.isOpen = false
              }

              customTogglerScope.tooltipMsgWhenOpen = customTogglerMsgWhenOpen
              customTogglerScope.tooltipMsgWhenClosed =
                customTogglerMsgWhenClosed

              customTogglerScope.tooltipPlacement =
                customTogglerPane === 'east' ? 'left' : 'right'
              customTogglerScope.handleClick = function () {
                layout.toggle(customTogglerPane)
                return repositionCustomToggler()
              }
              customTogglerEl = $compile(`\
<a href \
ng-show=\"isVisible\" \
class=\"custom-toggler ${`custom-toggler-${customTogglerPane}`}\" \
ng-class=\"isOpen ? 'custom-toggler-open' : 'custom-toggler-closed'\" \
tooltip=\"{{ isOpen ? tooltipMsgWhenOpen : tooltipMsgWhenClosed }}\" \
tooltip-placement=\"{{ tooltipPlacement }}\" \
ng-click=\"handleClick()\" \
aria-label=\"{{ isOpen ? tooltipMsgWhenOpen : tooltipMsgWhenClosed }}\">\
`)(customTogglerScope)
              element.append(customTogglerEl)
            }

            function onPaneOpen(pane) {
              // FIXED: 2026-10-30 面板开合后立刻落盘（原来只在拖动/卸载时存），
              // 否则"收起文件树"这个状态刷新后就丢了。
              saveStateSoon()
              if (!hasCustomToggler || pane !== customTogglerPane) {
                return
              }
              return customTogglerEl
                .scope()
                .$applyAsync(() => (customTogglerEl.scope().isOpen = true))
            }

            function onPaneClose(pane) {
              // FIXED: 2026-10-30 同上：收起状态要记住
              saveStateSoon()
              if (!hasCustomToggler || pane !== customTogglerPane) {
                return
              }
              return customTogglerEl
                .scope()
                .$applyAsync(() => (customTogglerEl.scope().isOpen = false))
            }

            // Ensure editor resizes after loading. This is to handle the case where
            // the window has been resized while the editor is loading
            scope.$on('editor:loaded', () => {
              ide.$timeout(() => layout.resizeAll())
            })

            // Save state when exiting（保留：拖动时已在 saveStateSoon 里存过了）
            $(window).unload(() => {
              saveState()
            })

            if (attrs.openEast != null) {
              scope.$watch(attrs.openEast, function (value, oldValue) {
                if (value != null && value !== oldValue) {
                  if (value) {
                    layout.open('east')
                  } else {
                    layout.close('east')
                  }
                  if (hasCustomToggler && customTogglerPane === 'east') {
                    repositionCustomToggler()
                    customTogglerEl.scope().$applyAsync(function () {
                      customTogglerEl.scope().isOpen = value
                    })
                  }
                }
                return setTimeout(() => scope.$digest(), 0)
              })
            }

            if (attrs.allowOverflowOn != null) {
              const overflowPane = scope.$eval(attrs.allowOverflowOn)
              const overflowPaneEl = layout.panes[overflowPane]
              // Set the panel as overflowing (gives it higher z-index and sets overflow rules)
              layout.allowOverflow(overflowPane)
              // Read the given z-index value and increment it, so that it's higher than synctex controls.
              const overflowPaneZVal = overflowPaneEl.zIndex()
              overflowPaneEl.css('z-index', overflowPaneZVal + 1)
            }

            resetOpenStates()
            onInternalResize()

            if (attrs.layoutDisabled != null) {
              return scope.$watch(attrs.layoutDisabled, function (value) {
                if (value) {
                  layout.hide('east')
                } else {
                  layout.show('east')
                }
                if (hasCustomToggler) {
                  return customTogglerEl.scope().$applyAsync(function () {
                    customTogglerEl.scope().isOpen = !value
                    return (customTogglerEl.scope().isVisible = !value)
                  })
                }
              })
            }
          },

          post(scope, element, attrs) {
            const name = attrs.layout
            const state = element.layout().readState()
            return scope.$broadcast(`layout:${name}:linked`, state)
          },
        }
      },
    }
  },
])
