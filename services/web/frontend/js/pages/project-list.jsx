import 'jquery'
import 'bootstrap'
import './../utils/meta'
import './../utils/webpack-public-path'
import './../infrastructure/error-reporter'
import './../i18n'
import '../cdn-load-test'
import '../features/contact-form'
import '../features/event-tracking'
import '../features/cookie-banner'
import '../features/link-helpers/slow-link'
import ReactDOM from 'react-dom'
import ProjectListRoot from '../features/project-list/components/project-list-root'

const element = document.getElementById('project-list-root')
if (element) {
  ReactDOM.render(<ProjectListRoot />, element)
}

// --- fl-mobile-debug start ---
// 临时诊断：只在 URL 带 ?mobiletest=1 时渲染，用来定位移动端项目列表顶部空白由谁造成。
// 定位完直接删掉本段（不影响任何功能）。
;(function () {
  let enabled = false
  try {
    enabled = new URLSearchParams(location.search).get('mobiletest') === '1'
  } catch (e) {
    enabled = false
  }
  if (!enabled) {
    return
  }

  setTimeout(function () {
    const selectors = [
      'nav.navbar',
      '.navbar-header',
      '.navbar-header .navbar-title',
      '#project-list-root',
      '.project-list-wrapper',
      '.project-list-main-react',
      '.project-list-header-row',
      '.project-list-header-row .project-tools',
      '.project-list-sidebar-survey-wrapper',
      '.projects-toolbar',
      '.project-list-card',
    ]
    const lines = ['innerWidth: ' + window.innerWidth + ' scrollY: ' + window.scrollY]
    selectors.forEach(function (sel) {
      const el = document.querySelector(sel)
      if (!el) {
        lines.push(sel + ': (无)')
        return
      }
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      lines.push(
        sel +
          ': top=' +
          Math.round(r.top) +
          ' h=' +
          Math.round(r.height) +
          ' display=' +
          cs.display +
          ' padTop=' +
          cs.paddingTop +
          ' marTop=' +
          cs.marginTop +
          ' marBot=' +
          cs.marginBottom
      )
    })

    const box = document.createElement('pre')
    box.style.cssText =
      'position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;' +
      'max-height:60%;overflow:auto;margin:0;padding:10px;background:#111;' +
      'color:#0f0;font:11px/1.5 monospace;border-radius:8px;' +
      'white-space:pre-wrap;word-break:break-all;'
    box.textContent = lines.join('\n')
    document.body.appendChild(box)
  }, 2000)
})()
// --- fl-mobile-debug end ---
