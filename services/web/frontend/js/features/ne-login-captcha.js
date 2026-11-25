import { getJSON, postJSON } from '../infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import NeAuthCaptcha from '../../../commercial/ne-auth-v2/browser/captcha'
import NeAuthPassword from '../../../commercial/ne-auth-v2/browser/password'

/**
 * FIXED: 2026-10-11 登录页人机验证 + 短信验证码登录（用户中心认证 V2）
 *
 * 指南要点：
 *   - 字典 captcha.enabled="1"（字符串）时才初始化阿里云验证码 2.0 组件
 *   - **密码登录**：结果随登录请求提交（字段 captcha_verify_param），验证通过前不提交
 *   - **短信登录**：结果随「发送短信」请求提交；短信码登录本身不带该字段
 *   - 结果一次性：提交后/失败后必须重新获取（SDK 的 reset()）
 *
 * 只作用于登录页：页面没有登录表单时本模块不做任何事。
 */

const PW_FORM_ID = 'ne-login-form-pw'
const SMS_FORM_ID = 'ne-login-form-sms'
const HOLDER_ID = 'ne-captcha-holder'
const I18N_ID = 'ne-login-i18n'
const SEND_BTN_ID = 'ne-send-sms-code'
// 用户中心对发送短信有限流，发送成功后短暂禁用避免重复请求
const SEND_COOLDOWN_MS = 60 * 1000

function readStrings() {
  const el = document.getElementById(I18N_ID)
  const d = (el && el.dataset) || {}
  return {
    loading: d.neCaptchaLoading || '',
    pending: d.neCaptchaPending || '',
    passed: d.neCaptchaPassed || '',
    failed: d.neCaptchaFailed || '',
    required: d.neCaptchaRequired || '',
    unavailable: d.neCaptchaUnavailable || '',
    smsCodeSent: d.neSmsCodeSent || '',
    smsLoginFailed: d.neSmsLoginFailed || '',
    mobileInvalid: d.neMobileInvalid || '',
    passwordEncrypting: d.nePasswordEncrypting || '',
    passwordUnavailable: d.nePasswordUnavailable || '',
    passwordRetrying: d.nePasswordRetrying || '',
  }
}

function isMobile(value) {
  return /^1[3-9]\d{9}$/.test(String(value || '').trim())
}

function setup(pwForm, smsForm) {
  const strings = readStrings()
  const holder = document.getElementById(HOLDER_ID)
  if (!holder) return

  const pwField =
    pwForm && pwForm.querySelector('input[name="captcha_verify_param"]')
  const pwStatus = document.getElementById('ne-captcha-status')
  const passwordStatus = document.getElementById('ne-password-status')
  const smsStatus = document.getElementById('ne-captcha-status-sms')
  const smsMobileInput =
    smsForm && smsForm.querySelector('input[name="mobile"]')
  const sendBtn = document.getElementById(SEND_BTN_ID)

  let required = false // 由字典配置决定（enabled === "1"）
  let tab = 'pw'
  let sendCooldownTimer = null
  let smsSending = false
  let cooldownUntil = 0
  let mobileGeneration = 0
  let passwordReady = false
  let encryption = null
  let passwordBinding = null
  // FIXED: 2026-11-20 「登录加密数据已失效或无效」自动恢复（每个页面只做一次）
  let autoRetried = false
  const pwInput = pwForm && pwForm.querySelector('[data-ol-ne-password]')

  const captcha = NeAuthCaptcha.createController({
    holderId: HOLDER_ID,
    onStatus: handleStatus,
  })

  function setStatus(el, text, isError) {
    if (!el) return
    el.textContent = text || ''
    // FIXED: 2026-11-15 用 class 而不是内联色值：写死 #8b95a1 在柔和主题的暖底上发脏，
    // 也绕不过主题变量。样式见 login-register.less 的 .fl-login__status.is-error
    // OLD: el.style.color = isError ? '#b91c1c' : '#8b95a1'
    el.classList.toggle('is-error', Boolean(isError))
  }

  function setSubmitEnabled(form, enabled) {
    if (!form) return
    const btn = form.querySelector('button[type="submit"]')
    if (btn) btn.disabled = !enabled
  }

  function setSendEnabled(enabled) {
    if (sendBtn) sendBtn.disabled = !enabled
  }

  function syncPasswordSubmit() {
    setSubmitEnabled(
      pwForm,
      passwordReady &&
        !encryption?.isSubmitting() &&
        !passwordBinding?.isSubmitting() &&
        (!required || Boolean(captcha.getParam()))
    )
  }

  function handlePasswordStatus(s) {
    passwordReady = s.state === 'ready'
    setStatus(
      passwordStatus,
      passwordReady
        ? ''
        : s.state === 'unavailable'
        ? strings.passwordUnavailable
        : strings.passwordEncrypting,
      s.state === 'unavailable'
    )
    syncPasswordSubmit()
  }

  function activeStatusEl() {
    return tab === 'pw' ? pwStatus : smsStatus
  }

  function handleStatus(s) {
    const el = activeStatusEl()
    switch (s.state) {
      case 'loading':
        setStatus(el, strings.loading)
        break
      case 'disabled':
        setStatus(el, '')
        break
      case 'pending':
        setStatus(el, strings.pending)
        setSubmitEnabled(pwForm, false)
        break
      case 'passed':
        setStatus(el, strings.passed)
        break
      case 'failed':
        setStatus(el, strings.failed, true)
        setSubmitEnabled(pwForm, false)
        break
      case 'unavailable':
        // 配置不可用时**不阻断登录**，只提示；最终结果由用户中心返回
        setStatus(el, strings.unavailable, true)
        if (!required) syncPasswordSubmit()
        break
      default:
        break
    }
  }

  /** 密码登录：验证通过后写入表单字段并放开提交 */
  function onPasswordCaptcha(param) {
    if (pwField) pwField.value = param
    syncPasswordSubmit()
  }

  function requestSmsCode(param) {
    if (smsSending || Date.now() < cooldownUntil) return
    const mobile = smsMobileInput ? smsMobileInput.value.trim() : ''
    if (!isMobile(mobile)) {
      setStatus(smsStatus, strings.mobileInvalid, true)
      return
    }
    setStatus(smsStatus, strings.loading)
    smsSending = true
    const requestGeneration = mobileGeneration
    setSendEnabled(false)
    postJSON('/ne/sendcode', {
      body: { mobile, captcha_verify_param: param },
    })
      .then(result => {
        if (requestGeneration !== mobileGeneration) return
        if (result && result.code === 0) {
          cooldownUntil = Date.now() + SEND_COOLDOWN_MS
          setStatus(smsStatus, strings.smsCodeSent)
          sendCooldownTimer = setTimeout(() => {
            sendCooldownTimer = null
            cooldownUntil = 0
            setSendEnabled(true)
          }, SEND_COOLDOWN_MS)
        } else {
          setStatus(
            smsStatus,
            (result && result.msg) || strings.smsLoginFailed,
            true
          )
          setSendEnabled(true)
        }
      })
      .catch(err => {
        debugConsole.error(err)
        if (requestGeneration !== mobileGeneration) return
        setStatus(smsStatus, strings.smsLoginFailed, true)
        setSendEnabled(true)
      })
      .finally(() => {
        smsSending = false
        setSendEnabled(Date.now() >= cooldownUntil)
      })
  }

  /** 短信 Tab：验证通过即自动发送（验证码结果一次性，读走即作废） */
  function onSmsCaptcha(param) {
    captcha.reset()
    requestSmsCode(param)
  }

  // 人机验证关闭或配置不可用时不会有任何回调，用户只能靠这个按钮主动发送
  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      if (required && !captcha.getParam()) {
        setStatus(smsStatus, strings.pending, true)
        return
      }
      requestSmsCode(captcha.getParam() || '')
      if (required) captcha.reset()
    })
  }

  // 改过手机号后允许立即重发，避免用户被上一轮的冷却挡住
  if (smsMobileInput) {
    smsMobileInput.addEventListener('input', () => {
      mobileGeneration++
      cooldownUntil = 0
      if (sendCooldownTimer) {
        clearTimeout(sendCooldownTimer)
        sendCooldownTimer = null
      }
      setSendEnabled(!smsSending)
      setStatus(smsStatus, '')
    })
  }

  /** 把验证码挂到当前 Tab 对应的容器（SDK 同页只维护一个实例） */
  function mountFor(current) {
    captcha.mount(
      current === 'pw' ? 'ne-captcha-slot' : 'ne-captcha-slot-sms',
      {
        purpose: current,
        onSuccess: current === 'pw' ? onPasswordCaptcha : onSmsCaptcha,
      }
    )
  }

  function activate(next) {
    tab = next
    if (pwForm) pwForm.hidden = next !== 'pw'
    if (smsForm) smsForm.hidden = next !== 'sms'
    document.querySelectorAll('[data-ol-ne-tab]').forEach(btn => {
      const isActive = btn.getAttribute('data-ol-ne-tab') === next
      btn.classList.toggle('btn-primary', isActive)
      // FIXED: 2026-11-15 分段器是 role="tab"，选中态要同步给读屏
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false')
    })
    if (required) mountFor(next)
    syncPasswordSubmit()
    // 已经发过码的号码仍处于冷却中，切 Tab 不应解锁
    setSendEnabled(!smsSending && Date.now() >= cooldownUntil)
    setStatus(next === 'pw' ? pwStatus : smsStatus, '')
  }

  document.querySelectorAll('[data-ol-ne-tab]').forEach(btn => {
    btn.addEventListener('click', () =>
      activate(btn.getAttribute('data-ol-ne-tab'))
    )
  })

  // FIXED: 2026-10-12 Only the SDK's encrypted re-submit reaches the existing
  // captcha binding and generic form helper. No generic form logic is changed.
  encryption =
    pwForm &&
    NeAuthPassword.bindForm(pwForm, {
      onStatus: handlePasswordStatus,
      canSubmit: () =>
        tab === 'pw' && (!required || Boolean(captcha.getParam())),
      onRequired: () => setStatus(pwStatus, strings.required, true),
    })

  // Let the SDK consume the result after the form response.
  passwordBinding =
    pwForm &&
    captcha.bindForm(pwForm, {
      field: pwField,
      onRequired: s =>
        setStatus(
          pwStatus,
          s.state === 'unavailable' ? strings.unavailable : strings.required,
          true
        ),
    })

  if (pwForm) {
    pwForm.addEventListener('sent', syncPasswordSubmit)
    pwForm.addEventListener('idle', syncPasswordSubmit)
  }

  /**
   * FIXED: 2026-11-20 服务端说「加密数据已失效或无效」时，用户以前只能自己清
   * 浏览器 cookie。现在在页面里自动把这件事做完：重新取一份公钥（顺带让服务端
   * 重建 session），再把同一个密码自动重提一次，用户只需要等一秒。
   */
  function recoverStaleKey() {
    if (autoRetried || !encryption) return false
    if (!pwInput || !pwInput.value) return false
    autoRetried = true
    setStatus(passwordStatus, strings.passwordRetrying)
    getJSON('/ne/captcha-config?_=' + Date.now())
      .then(async data => {
        await encryption.applyConfig(data && data.passwordEncryption)
        // 密码还在输入框里，直接重提；拦截、加密、人机验证仍然走原本的链路
        pwForm.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true })
        )
      })
      .catch(err => {
        debugConsole.error(err)
        setStatus(passwordStatus, strings.passwordUnavailable, true)
      })
    return true
  }

  // 服务端的报错会渲染进表单的 messages 区域，盯住它就知道要不要自动重试
  const messagesEl =
    pwForm && pwForm.querySelector('[data-ol-form-messages]')
  if (messagesEl) {
    const observer = new MutationObserver(() => {
      const text = messagesEl.textContent || ''
      if (!/加密数据已失效|加密配置已过期/.test(text)) return
      if (!recoverStaleKey()) return
      messagesEl.textContent = ''
    })
    observer.observe(messagesEl, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  }

  // FIXED: 2026-11-20 带时间戳绕过任何中间层缓存（配置是 per-session 的）
  getJSON('/ne/captcha-config?_=' + Date.now())
    .then(async data => {
      const plan = captcha.applyConfig(data && data.captcha)
      required = plan.action === 'init'
      // FIXED: 2026-11-15 人机验证可在 NE 账号中心关闭（enabled="0"）。
      // 关掉时整块收起，否则会留一个 44px 的空槽位。
      document.querySelectorAll('[data-ol-ne-captcha]').forEach(el => {
        el.hidden = !required
      })
      if (required) {
        mountFor(tab)
      } else {
        // enabled="0"（skip）或配置不可用（unavailable）：不阻断登录
        syncPasswordSubmit()
      }
      if (encryption)
        await encryption.applyConfig(data && data.passwordEncryption)
    })
    .catch(err => {
      debugConsole.error(err)
      setStatus(pwStatus, strings.unavailable, true)
      if (encryption) encryption.applyConfig(null)
    })
}

const pwForm = document.getElementById(PW_FORM_ID)
const smsForm = document.getElementById(SMS_FORM_ID)
if (pwForm || smsForm) {
  try {
    setup(pwForm, smsForm)
  } catch (err) {
    debugConsole.error(err)
  }
}
