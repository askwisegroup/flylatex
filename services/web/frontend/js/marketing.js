import './utils/webpack-public-path'
import './infrastructure/error-reporter'
import 'jquery'
import 'bootstrap'
import './cdn-load-test'
import './features/form-helpers/hydrate-form'
import './features/link-helpers/slow-link'
import './features/bookmarkable-tab'
import './features/contact-form'
import './features/event-tracking'
import './features/fallback-image'
import './features/multi-submit'
import './features/cookie-banner'
// FIXED: 2026-10-11 登录页人机验证（用户中心认证 V2）；非登录页会自动跳过
import './features/ne-login-captcha'
// FIXED: 2026-11-12 Google 登录（海外站主登录方式）；无 #google-login 时自动跳过
import './features/google-login'

$('[data-ol-lang-selector-tooltip]').tooltip({ trigger: 'hover' })
$('[data-toggle="tooltip"]').tooltip()
