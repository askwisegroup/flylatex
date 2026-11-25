/* eslint-disable no-console */

/**
 * Google 登录（浏览器端）。
 *
 * FIXED: 2026-11-12 新增。移植自已验证的原型
 * a local prototype repo（sdk/google-auth.browser.js），
 * 但**去掉了它自己的会话层**：本仓库后端用的是 Overleaf 既有的
 * express-session + passport，前端只需要把 Google 给的 credential 递上去，
 * 然后按后端返回的 `{ redir }` 跳转 —— 与 NE 密码 / 短信登录完全同一个契约。
 *
 * 流程：
 *   GET  /auth/google/nonce    拿一次性 nonce（防重放）
 *   GIS 弹窗 → 得到 credential（Google 签名的 JWT，内含该 nonce）
 *   POST /auth/google/verify   { credential, nonce }
 *   ← { redir }                会话 cookie 已由后端下发
 *
 * 安全：页面上的 email/name 一律以后端返回为准，前端解码只用于"校验中"提示。
 * 没有 `#google-login` 元素时（中国站登录页）整个模块直接 no-op。
 */

import { getJSON, postJSON } from '../infrastructure/fetch-json'

const GIS_SRC = 'https://accounts.google.com/gsi/client'

function log(message) {
  // 登录链路的故障必须能在浏览器控制台看到：此时用户还没登录，既没有
  // 用户 ID 也没有服务端会话可以关联，控制台是唯一的现场。
  // 因此本文件整体禁用了 no-console（见文件头）。
  console.warn('[google-login]', message)
}

function setStatus(text) {
  const node = document.getElementById('google-login-status')
  if (node) node.textContent = text
}

function decodePayload(token) {
  const part = String(token || '').split('.')[1]
  if (!part) return null
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  try {
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    return null
  }
}

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.id) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('gis_load_failed')), {
        once: true,
      })
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('gis_load_failed')), {
      once: true,
    })
    document.head.appendChild(script)
  })
}

async function submitCredential(credential, nonce) {
  try {
    const data = await postJSON('/auth/google/verify', {
      body: { credential, nonce },
    })
    if (data && data.redir) {
      window.location.href = data.redir
      return
    }
    // 后端没有给 redir：理论上不该发生（finishLogin 一定带 redir）。
    setStatus('登录成功，请刷新页面')
  } catch (error) {
    const reason =
      (error && error.data && error.data.reason) || error.message || 'verify_failed'
    log(`verify failed: ${reason}`)
    setStatus(
      reason === 'google_account_conflict'
        ? '该邮箱已绑定其他 Google 账号，请联系支持'
        : '登录失败，请重试'
    )
  }
}

async function init() {
  const root = document.getElementById('google-login')
  if (!root) return

  const clientId = (root.dataset.googleClientId || '').trim()
  if (!clientId) {
    log('缺少 data-google-client-id')
    return
  }

  try {
    await loadGis()
  } catch (error) {
    log('Google Identity Services 加载失败（可能是网络或 CSP 拦截）')
    setStatus('Google 登录组件加载失败，请刷新重试')
    return
  }

  let nonce = ''
  try {
    const data = await getJSON('/auth/google/nonce')
    nonce = data && data.nonce ? data.nonce : ''
  } catch (error) {
    log('无法获取 nonce')
    setStatus('登录准备失败，请刷新重试')
    return
  }
  if (!nonce) {
    setStatus('登录准备失败，请刷新重试')
    return
  }

  window.google.accounts.id.initialize({
    client_id: clientId,
    // GIS 会把这个 nonce 原样写进 ID Token 的 nonce claim，后端据此防重放
    nonce,
    ux_mode: 'popup',
    auto_select: false,
    cancel_on_tap_outside: true,
    callback: response => {
      if (!response || !response.credential) {
        log('登录回调未返回 credential')
        return
      }
      const preview = decodePayload(response.credential)
      if (preview && preview.email) {
        setStatus(`正在验证 ${preview.email} …`)
      } else {
        setStatus('正在验证 …')
      }
      submitCredential(response.credential, nonce)
    },
  })

  const slot = document.getElementById('google-login-button')
  window.google.accounts.id.renderButton(slot || root, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'signin_with',
    shape: 'rectangular',
    logo_alignment: 'left',
    width: 320,
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}
