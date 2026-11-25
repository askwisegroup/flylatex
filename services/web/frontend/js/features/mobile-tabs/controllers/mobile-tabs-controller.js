import App from '../../../base'
import { react2angular } from 'react2angular'
import { rootContext } from '../../../shared/context/root-context'
import MobileTabs from '../components/mobile-tabs'

// FIXED: 2026-11-10 移动端四档 Tab（文件 / 源码 / 预览 / AI 助手）
// 只在编辑器页面（app/views/project/editor/main.pug）里挂载，
// /project 列表页和其它页面都不会渲染它。
App.component('mobileTabs', react2angular(rootContext.use(MobileTabs)))
