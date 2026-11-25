#!/usr/bin/env node
/*
 * 跨库检索必须用「NE 账号」这一口径解析令牌。
 *
 * 依据 documents/projects/flylatex/文献检索.md：
 *   认证信息: Bearer NE:<NE-Account-Return-Token>
 * 令牌属于 NE 账号，登录时按「那次登录用的标识」做 cacheKey；本站的
 * email / carsiEmail 未必等于它。所以检索侧必须走统一入口
 * （tokenCache.getActiveTokenForUser，会先查 ne:v2:account:<account_id>），
 * 而不是自己拿邮箱逐个猜。
 *
 * 这条断言存在的理由：2026-11 这块连续坏过五次，每次都是「换个地方猜标识」。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ✗ ${name}\n    ${error.message}`)
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message)
}

const src = read('commercial/crosrefsearch.js')
const code = src
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

check('检索侧走统一入口解析令牌', () => {
  assert(
    /tokenCache\.getActiveTokenForUser\s*\(/.test(src),
    'crossRefSearch 没有用 getActiveTokenForUser —— 又回到拿本站邮箱猜 NE 账号了'
  )
})

check('统一入口取到令牌后不再被逐标识循环覆盖', () => {
  const loop = src.slice(src.indexOf('for (const identifier of identifiers)'))
  assert(
    /if \(token\) break;/.test(loop.slice(0, 200)),
    '循环开头没有 `if (token) break;` —— 会把统一入口取到的令牌置空'
  )
})

check('统一入口抛错时仍保留逐标识回退', () => {
  assert(
    /catch \(e\) \{[\s\S]{0,400}?tokenError = e;/.test(src),
    '统一入口抛错后既没记录失败类型、也没继续回退'
  )
  assert(
    src.indexOf('for (const identifier of identifiers)') >
      src.indexOf('tokenError = e;'),
    '逐标识回退被删掉了 —— 今天能用的场景会一起坏'
  )
})

check('失败按《转发服务API.md §1》分 reason，而不是一句「没登录」', () => {
  for (const reason of [
    'token_store_unavailable',
    'ne_session_expired',
    'reauth_required',
    'ne_not_linked',
  ]) {
    assert(
      src.includes(`'${reason}'`),
      `缺少 reason=${reason}（文档 §1 失败表）`
    )
  }
  assert(
    /code: 502/.test(src),
    'token_store_unavailable 必须是 502 —— 服务端存储故障不是让用户重登'
  )
  assert(
    /relink: '\/ne-relink'/.test(src),
    '需要重新授权时没给 /ne-relink 出口（文档 §2.1）'
  )
  assert(
    /identifiers: identifiers\.map\(maskIdentifier\)/.test(src),
    'diagnostics 里的标识没脱敏'
  )
})

check('刷新失败分三类：限流/会话到期/凭据被拒', () => {
  for (const kind of ['slow_down', 'session_expired', 'invalid_grant']) {
    assert(src.includes(`'${kind}'`), `describeRefreshFailure 里没有 ${kind}`)
  }
  assert(
    /code: 503/.test(src),
    'slow_down 必须回 503「稍后重试」，不能回 401 让人重新登录'
  )
  // 注释里允许出现这句（说明历史），真正的响应体不行
  assert(
    !/message:\s*'Authentication failed\. Please login again\.'/.test(code),
    '上游拒收还在冒充「请先登录」'
  )
})

check('NE 会话过期不做刷新（刷新白费还要撞 60 秒窗口）', () => {
  assert(
    /function isSessionExpiredBody/.test(src),
    '没有 isSessionExpiredBody —— 会话过期仍会去刷新'
  )
  const idx = src.indexOf('isSessionExpiredBody(apiResponse.data)')
  assert(
    idx !== -1 && src.indexOf('forceRefresh', idx) > idx,
    '会话过期的判断没排在强制刷新之前'
  )
})

check('个人库刷新前先复用已存的最新令牌（避免撞 60 秒限流）', () => {
  assert(
    /getByEmailFromRedis\(tokenIdentifier\);/.test(src),
    '没有先取「已存最新令牌」，每次失败都硬刷新 → 撞 NE 60 秒限制'
  )
})

check('401 不再说「请先登录」', () => {
  assert(
    !/Authentication required\. Please login first\./.test(src),
    '用户是用 NE 账号登录的，这句话在事实层面就是错的'
  )
})

check('令牌解析仍只在 tokenCache 里碰 Redis 键', () => {
  assert(
    !/ne:v2:account:/.test(code),
    'crossrefsearch.js 直接读 ne:v2:account: —— Redis 键只允许 tokenCache 碰'
  )
})

// ---------------- AMiner Key 的身份口径 ----------------
// FIXED: 2026-11-03 这一批断言是补的：11-02 16:27 有一次 `git checkout 9a1a0d4 --
// services/web` 的回滚，把「AMiner 已配 Key 却说没启用」和「输入时就弹未找到结果」
// 两个修复连同它们的回归测试一起抹掉了，之后两天没人发现，用户又踩了一遍。
// 这类「身份口径 / 空状态由谁把关」的约定，光靠测试文件守着不行 ——
// 回滚会连测试一起删。所以在这里也钉一遍（纯源码断言，不连库，可以随时跑）。
const aminerSrc = read('commercial/aminer-search.js')
const crosRefSrc = read('commercial/crosrefsearch.js')
const crosRefUi = read(
  'frontend/js/features/source-editor/aegeanexts/CrosRefSearch/index.tsx'
)

check('AMiner 读 Key 支持「按登录标识」这条路', () => {
  assert(
    /async function getUserAminerKeyByIdentifiers/.test(aminerSrc),
    'aminer-search.js 少了 getUserAminerKeyByIdentifiers'
  )
  assert(
    /getUserAminerKeyByIdentifiers,/.test(aminerSrc),
    'getUserAminerKeyByIdentifiers 没有导出'
  )
  assert(
    /for \(const field of \['email', 'carsiEmail'\]\)/.test(aminerSrc),
    '按标识查 Key 没有同时查 email / carsiEmail'
  )
})

check('AMiner 检索确实会用标识回退（否则配了也说没配）', () => {
  assert(
    /getUserAminerKeyByIdentifiers\(identifiers\)/.test(crosRefSrc),
    'searchAminer 没有调用 getUserAminerKeyByIdentifiers —— ' +
      '/cross-ref-search 在 publicApiRouter 上，request.session 恒为空，' +
      '只按 userId 查必然拿不到 Key'
  )
  assert(
    /const identifiers = \[\]/.test(crosRefSrc) &&
      /pushIdentifier\(params\.userEmail\)/.test(crosRefSrc),
    'searchAminer 没有把 body.userEmail 当标识兜底'
  )
})

check('AMiner 分发真的把 userEmail 传给 searchAminer', () => {
  const idx = crosRefSrc.indexOf('return await searchAminer(')
  assert(idx !== -1, '找不到 region === aminer 的分发')
  const dispatch = crosRefSrc.slice(idx, idx + 600)
  assert(/userEmail/.test(dispatch), '分发里没传 userEmail → 标识回退永远空')
})

check('有会话时不用 body 里的 userEmail 读 Key（public 路由防越权）', () => {
  const idx = crosRefSrc.indexOf('if (sessionUser) {')
  assert(idx !== -1, '没有「有会话」分支')
  const elseIdx = crosRefSrc.indexOf('pushIdentifier(params.userEmail)')
  assert(
    elseIdx > idx,
    '会话优先的分支没了 —— body 邮箱可以拿去花别人的 AMiner 额度'
  )
})

check('「未找到结果」由 lastQuery 把关，输入期间不显示', () => {
  assert(
    /lastQuery &&\s*\n\s*searchResults\.length === 0/.test(crosRefUi),
    '空状态又把「搜索框有字」当条件了 —— 敲第一个字就会显示「未找到结果」'
  )
  assert(
    /\{lastQuery\.title &&/.test(crosRefUi),
    '空状态回显的还是输入框的当前值，不是搜的时候的条件'
  )
  assert(
    /setLastQuery\(null\)/.test(crosRefUi),
    '失败/关窗时没清 lastQuery，会拿上一次的条件吓人'
  )
})

if (failures) {
  console.error(`\ncrossref token source: ${failures} 项失败`)
  process.exit(1)
}
console.log('\ncrossref token source: OK')
