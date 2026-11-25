#!/usr/bin/env node
'use strict'

/**
 * 校验 `config/internal-values.js` 里的 SSO 客户端注册表
 *
 * FIXED: 2026-11-22 新增。
 *
 * 背景：注册表是手写数据（`sso.clients` 数组），写错的表现是「web 进程起不来」
 * 或「授权页能打开、回调必然 invalid_request」。这两种都不该等到线上才发现。
 *
 * 本脚本**不依赖 web 运行时**（不连 Mongo/Redis、不需要 libraries/settings），
 * 直接 require 私有配置 + `Features/Sso/Clients` 做纯函数校验，可以随手跑：
 *
 *   node scripts/checks/sso-config.check.js
 *   npm run check:sso-config
 *
 * 开源版（`sso.clients` 为空）会打印「未配置」并正常退出 0 ——
 * 空注册表是合法状态，不是错误。
 */

const path = require('path')

const WEB_ROOT = path.join(__dirname, '..', '..')

function main() {
  const INTERNAL = require(path.join(WEB_ROOT, 'config', 'internal-values.js'))
  const sso = INTERNAL.sso || {}
  const raw = sso.clients || []

  // 环境变量优先（与 settings.defaults.js 保持一致）
  const source = process.env.SSO_CLIENTS
    ? '环境变量 SSO_CLIENTS'
    : 'internal-values.js'
  const Clients = require(
    path.join(WEB_ROOT, 'app/src/Features/Sso/Clients.js')
  )
  const Claims = require(path.join(WEB_ROOT, 'app/src/Features/Sso/Claims.js'))

  let list
  try {
    list = Clients.parseClientsConfig(process.env.SSO_CLIENTS || raw)
  } catch (error) {
    console.error(`✗ 注册表解析失败（来源：${source}）`)
    console.error(`  ${error.message}`)
    return 1
  }

  if (list.length === 0) {
    console.log(`○ SSO 未配置（来源：${source}）`)
    console.log(
      '  /sso/authorize|token|userinfo 返回 404；/sso/session 不受影响。'
    )
    return 0
  }

  console.log(`来源：${source}`)
  console.log(`store：${process.env.SSO_STORE || sso.store || 'redis'}`)
  console.log(`客户端：${list.length} 个\n`)

  let registry
  try {
    registry = Clients.createRegistry(list)
  } catch (error) {
    console.error(`✗ 注册表校验失败：${error.message}`)
    return 1
  }

  const problems = []

  for (const client of list) {
    const id = client.clientId || client.client_id || '(缺 client_id)'
    const normalized = registry.get(id)

    // redirect_uris 必须是绝对 URL（相对地址浏览器根本不会跳过去）
    for (const uri of client.redirectUris || client.redirect_uris || []) {
      try {
        const url = new URL(uri)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          problems.push(`${id}: redirect_uri 协议不对 → ${uri}`)
        }
      } catch {
        problems.push(`${id}: redirect_uri 不是绝对 URL → ${uri}`)
      }
    }

    const secret = client.clientSecret || client.client_secret || ''
    if (secret && secret.length < 16) {
      problems.push(`${id}: client_secret 太短（<16），部署时会被暴力猜`)
    }

    const scopes = (client.scopes || ['openid']).filter(
      s => !Claims.SUPPORTED_SCOPES.includes(s)
    )
    // 注：已知 scope 由 normalizeClient 过滤，这里只提示，不阻断
    if (scopes.length > 0) {
      problems.push(`${id}: 含未知 scope（会被丢弃）→ ${scopes.join(',')}`)
    }

    console.log(`· ${id}`)
    console.log(`    name           ${normalized.name || '(未命名)'}`)
    console.log(
      `    secret         ${secret ? '已配置（confidential client）' : '空（public client，强制 PKCE）'}`
    )
    console.log(`    require PKCE   ${normalized.requirePkce}`)
    console.log(
      `    trusted        ${normalized.trusted}${normalized.trusted ? '' : '（M3 之前一律 access_denied）'}`
    )
    console.log(`    scopes         ${normalized.scopes.join(', ')}`)
    console.log(`    allow_loopback ${normalized.allowLoopback}`)
    for (const uri of normalized.redirectUris) {
      console.log(`    redirect_uri   ${uri}`)
    }
    console.log('')
  }

  if (problems.length > 0) {
    console.log('⚠ 提醒（不阻断启动）：')
    for (const p of problems) console.log(`  · ${p}`)
    console.log('')
  }

  console.log(`✓ 注册表可用，共 ${registry.size} 个客户端`)
  return 0
}

process.exit(main())
