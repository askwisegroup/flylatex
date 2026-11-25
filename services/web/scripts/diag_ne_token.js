/**
 * Answer one question about one account, from the server, without a browser:
 *
 *   does this FlyLaTeX user hold an NE token, and can that token see the model
 *   the AI features are configured to use?
 *
 * This exists because "the settings page shows no quota" has four different
 * causes — no token, an unreadable token store, a token the gateway rejects,
 * or a token that cannot see the configured model — and guessing between them
 * produced a wrong answer in production.
 *
 * Usage (inside the web container, from /overleaf):
 *   node scripts/diag_ne_token.js --email user@example.com
 *   node scripts/diag_ne_token.js --account 10001
 *   node scripts/diag_ne_token.js --redis-only        # no Mongo, no gateway
 *
 * Read-only: never writes a token, never mints one, never calls /chat.
 * Never prints a token or a refresh token — only lengths.
 */

const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = name => argv.includes(`--${name}`)

const email = flag('email')
const accountArg = flag('account')
const modelFlag = flag('model')
const redisOnly = has('redis-only')

/** The model the AI features will actually ask for. */
function configuredModel() {
  if (modelFlag) return { model: modelFlag, source: '--model' }
  if (process.env.OPENAI_MODEL) {
    return { model: process.env.OPENAI_MODEL, source: 'env OPENAI_MODEL' }
  }
  // ai-config.js falls back to this; there is no reason to think a given
  // gateway serves it, which is exactly why we print the source.
  return { model: 'gpt-4o', source: 'code default (ai-config.js)' }
}

async function scanKeys(redis, pattern) {
  if (!redis) return null
  try {
    return await redis.keys(pattern)
  } catch (error) {
    return { error: error.message }
  }
}

// FIXED: 2026-10-27 逐条把「这个 identifier 到底有没有令牌、NE 说会话到什么时候」
// 拆开看。上一个版本的结论靠猜（“标记在但记录没了”被当成“NE 拒绝凭据”），
// 而「昨天登录今天就过期」这类投诉恰恰需要**两个键的原始状态**才能定案。
// 只输出时间与布尔值，不输出任何令牌。
const crypto = require('crypto')
const cacheKeyOf = identifier =>
  crypto.createHash('sha256').update(identifier).digest('hex')
const parseJson = raw => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    return null
  }
}
const isoSeconds = value =>
  Number.isFinite(value) ? new Date(value * 1000).toISOString() : null
const isoMs = value => (Number.isFinite(value) ? new Date(value).toISOString() : null)

async function inspectIdentifier(redis, identifier) {
  if (!redis) return { identifier, redis: 'unavailable' }
  const key = cacheKeyOf(identifier)
  const markerKey = `ne-auth-v2:managed:${key}`
  const recordKey = `ne-auth-v2:tokens:${key}`
  const marker = parseJson(await redis.get(markerKey))
  const record = parseJson(await redis.get(recordKey))
  const ttlMs =
    typeof redis.pttl === 'function' ? await redis.pttl(recordKey) : null
  return {
    identifier,
    keyPrefix: key.slice(0, 12),
    // 登记标记：说明这个 identifier 走过 NE 登录；新版还带着会话截止时间
    marker: marker
      ? {
          managed: marker.managed,
          sessionExpiresAt: isoSeconds(marker.sessionExpiresAt),
          writtenAt: isoMs(marker.at),
        }
      : null,
    // 令牌对记录：按会话截止时间设 TTL，过期即被 Redis 删除
    record: record
      ? {
          hasAccessToken: Boolean(record.accessToken),
          hasRefreshToken: Boolean(record.refreshToken),
          accessTokenExpiresAt: isoSeconds(record.expiresAt),
          sessionExpiresAt: isoSeconds(record.sessionExpiresAt),
          sessionHoursLeft: Number.isFinite(record.sessionExpiresAt)
            ? Math.round(
                ((record.sessionExpiresAt * 1000 - Date.now()) / 3600000) * 10
              ) / 10
            : null,
          refreshExpiresIn: Number.isFinite(record.refreshExpiresIn)
            ? record.refreshExpiresIn
            : null,
          refreshPending: Boolean(record.refreshPending),
          refreshNotBefore: isoMs(record.refreshNotBefore),
          redisTtlMs: ttlMs === -2 ? 'key missing' : ttlMs,
        }
      : null,
  }
}

async function main() {
  const report = {
    configured: configuredModel(),
    redisOnly,
  }

  let redis = null
  try {
    redis = require('../app/src/infrastructure/RedisWrapper').client(
      'ne_token_cache'
    )
  } catch (error) {
    report.redis = { connected: false, error: error.message }
  }

  if (redis) {
    const v2 = await scanKeys(redis, 'ne-auth-v2:managed:*')
    const legacy = await scanKeys(redis, 'ne:token:*')
    const accounts = await scanKeys(redis, 'ne:v2:account:*')
    report.redis = {
      connected: true,
      // one managed marker per account that ever signed in through NE
      managedSessions: Array.isArray(v2) ? v2.length : null,
      accountIndex: Array.isArray(accounts) ? accounts.length : null,
      legacyEmailTokens: Array.isArray(legacy) ? legacy.length : null,
      scanError: [v2, legacy, accounts].find(x => x && x.error) || null,
    }
  }

  if (redisOnly) {
    const any = (report.redis.managedSessions || 0) > 0
    report.verdict = any
      ? 'redis_has_sessions: some account has an NE token; re-run without --redis-only and pass --email or --account'
      : 'redis_has_no_sessions: no NE V2 session was ever stored on this deployment — the login→token path never completed, which is a login problem, not an LLM problem'
    console.log(JSON.stringify(report, null, 2))
    return
  }

  // --- identify the user ----------------------------------------------------
  let user = null
  let mongoError = null
  let db = null
  try {
    const mongo = require('../app/src/infrastructure/mongodb')
    await mongo.waitForDb()
    db = mongo.db
    if (accountArg) {
      user = await db.users.findOne(
        { account_id: Number(accountArg) },
        { projection: { email: 1, carsiEmail: 1, account_id: 1, first_name: 1 } }
      )
    } else if (email) {
      const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      user = await db.users.findOne(
        { email: new RegExp(`^${escaped}$`, 'i') },
        { projection: { email: 1, carsiEmail: 1, account_id: 1, first_name: 1 } }
      )
    } else {
      console.error(
        'usage: node scripts/diag_ne_token.js --email <addr> | --account <id> | --redis-only'
      )
      process.exit(2)
    }
  } catch (error) {
    mongoError = error.message
  }

  if (mongoError) {
    report.mongo = { connected: false, error: mongoError }
    report.verdict = 'mongo_unavailable: pass --redis-only for the storage check'
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (!user) {
    report.user = null
    report.verdict = 'user_not_found: no account matches that email/account_id'
    console.log(JSON.stringify(report, null, 2))
    return
  }

  report.user = {
    id: String(user._id),
    email: user.email || null,
    carsiEmail: user.carsiEmail || null,
    accountId: user.account_id ?? null,
  }
  const tokenCache = require('../commercial/tokenCache')

  // FIXED: 2026-10-27 --trace 列出**所有**匹配这个邮箱的账号。
  // 同一邮箱/手机号历史上可能留下两个 Mongo 用户（一个只有 email，一个带
  // carsiEmail），登录写进 A 而当前会话读 B 时，一切现象都像“令牌丢了”。
  if (has('trace') && email) {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rx = new RegExp(`^${escaped}$`, 'i')
    const users = await db.users
      .find(
        { $or: [{ email: rx }, { carsiEmail: rx }] },
        {
          projection: {
            _id: 1,
            email: 1,
            carsiEmail: 1,
            account_id: 1,
            first_name: 1,
          },
        }
      )
      .limit(10)
      .toArray()
    report.matchingUsers = []
    for (const candidate of users) {
      const identifiers = await tokenCache.candidateIdentifiers(candidate)
      report.matchingUsers.push({
        id: String(candidate._id),
        email: candidate.email || null,
        carsiEmail: candidate.carsiEmail || null,
        accountId: candidate.account_id ?? null,
        identifiers,
        candidates: await Promise.all(
          identifiers.map(identifier => inspectIdentifier(redis, identifier))
        ),
      })
    }
  }
  // --- token ---------------------------------------------------------------
  report.lookupOrder = await tokenCache.candidateIdentifiers(user)
  // FIXED: 2026-10-27 也要报告「NE 授权还剩多久」：会话到期是一个必然会发生、
  // 但可以提前看到的状态，排障时先看这个字段比看错误码快。
  report.link = (await tokenCache.getLinkInfoForUser(user)) || null
  // 每个候选 identifier 的原始存储状态（标记 + 记录 + Redis 剩余 TTL）
  report.candidates = []
  for (const identifier of report.lookupOrder) {
    report.candidates.push(await inspectIdentifier(redis, identifier))
  }

  let active = null
  let lookupError = null
  try {
    active = await tokenCache.getActiveTokenForUser(user)
  } catch (error) {
    lookupError = (error && (error.kind || error.message)) || 'unknown'
  }
  report.token = active
    ? { found: true, identifier: active.identifier, length: active.token.length }
    : { found: false, error: lookupError }

  if (!active) {
    report.verdict =
      lookupError === 'session_expired'
        ? 'ne_session_expired: the NE session deadline (max 30 days, not extended by refresh) has passed. The account must re-link once via /ne-relink; this is expected, not a bug'
        : lookupError === 'invalid_grant'
          ? 'ne_credential_rejected: NE actively refused the stored credential (revoked, password changed, logged out elsewhere) — re-link via /ne-relink'
          : lookupError
            ? `token_store_error (${lookupError}): the store answered with a failure, this is NOT "never signed in"`
            : 'no_ne_token: no stored token for this account. If redis.managedSessions > 0, the login used a different identifier — check lookupOrder above'
    console.log(JSON.stringify(report, null, 2))
    return
  }

  // --- can the token see the configured model? ------------------------------
  const LlmModels = require('../commercial/llm-models')
  const authorization = `Bearer ${require('../commercial/llm-credential').APP_SOURCE}##${active.token}`
  const ids = await LlmModels.idsFor(
    authorization,
    LlmModels.cacheKeyForUser(user)
  )
  report.models = ids
    ? {
        count: ids.length,
        includesConfigured: report.configured.model
          ? ids.includes(report.configured.model)
          : null,
        ids: ids.slice(0, 40),
      }
    : null

  if (!ids) {
    report.verdict =
      'token_ok_but_model_list_unavailable: the gateway /models call failed — check AI_GATEWAY_BASE_URL and egress'
  } else if (!report.configured.model || !ids.includes(report.configured.model)) {
    report.verdict = `token_ok_but_model_not_visible: ${report.configured.model} (${report.configured.source}) is not in this account's list — set OPENAI_MODEL to one of models.ids, or AI_FT_AI_USER_QUOTA=never`
  } else {
    report.verdict = 'ok: this account can use the AI features with its own quota'
  }
  console.log(JSON.stringify(report, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
