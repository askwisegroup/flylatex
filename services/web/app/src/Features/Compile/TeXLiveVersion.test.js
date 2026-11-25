// 独立运行的冒烟测试：node app/src/Features/Compile/TeXLiveVersion.test.js
// 只测纯解析函数，不 spawn 子进程、不连 Mongo/Redis。

const assert = require('assert')
const {
  parseTlmgrVersionOutput,
  sanitizeTlmgrOutput,
  getTeXLiveVersion,
  get,
  clearCache,
} = require('./TeXLiveVersion')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// 现场抓到的真实输出：树是 2023，tlmgr 被 update-tlmgr-latest.sh 换成了 2025 版
const MIXED_STATE_OUTPUT = `tlmgr revision 74695 (2025-03-19 00:12:52 +0100)
tlmgr using installation: /usr/local/texlive/2023
TeX Live (https://tug.org/texlive) version 2025
`

const NORMAL_2026_OUTPUT = `tlmgr revision 77894 (2026-04-02 11:31:07 +0200)
tlmgr using installation: /usr/local/texlive/2026
TeX Live (https://tug.org/texlive) version 2026
`

console.log('parseTlmgrVersionOutput')

check('混搭状态：version 取 tlmgr 自报的 2025，安装树年份单独取 2023', () => {
  const parsed = parseTlmgrVersionOutput(MIXED_STATE_OUTPUT)
  assert.strictEqual(parsed.version, '2025')
  assert.strictEqual(parsed.installationYear, '2023')
  assert.strictEqual(parsed.installationPath, '/usr/local/texlive/2023')
  assert.strictEqual(parsed.revision, '74695')
})

check('正常状态：version 与安装树年份一致', () => {
  const parsed = parseTlmgrVersionOutput(NORMAL_2026_OUTPUT)
  assert.strictEqual(parsed.version, '2026')
  assert.strictEqual(parsed.installationYear, '2026')
  assert.strictEqual(parsed.revision, '77894')
})

check('raw 保留完整原文（仅服务端可见，不外发）', () => {
  const parsed = parseTlmgrVersionOutput(NORMAL_2026_OUTPUT)
  assert.ok(parsed.raw.includes('tlmgr using installation'))
  assert.ok(parsed.raw.includes('version 2026'))
  assert.ok(!parsed.raw.endsWith('\n'))
})

check('只有安装树、没有 version 行时回落到安装树年份', () => {
  const parsed = parseTlmgrVersionOutput(
    'tlmgr using installation: /usr/local/texlive/2023\n'
  )
  assert.strictEqual(parsed.version, null)
  assert.strictEqual(parsed.installationYear, '2023')
})

check('安装路径没有年份（/opt/texlive）时 installationYear 为 null', () => {
  const parsed = parseTlmgrVersionOutput(
    'tlmgr using installation: /opt/texlive\nTeX Live (https://tug.org/texlive) version 2026\n'
  )
  assert.strictEqual(parsed.version, '2026')
  assert.strictEqual(parsed.installationYear, null)
})

check('输出前面多出无关告警行不影响解析', () => {
  const parsed = parseTlmgrVersionOutput(
    `WARNING: some unrelated noise 2026 here
(tlmgr) another line
${NORMAL_2026_OUTPUT}`
  )
  assert.strictEqual(parsed.version, '2026')
})

check('空输出 / undefined 不抛异常，各字段为 null', () => {
  for (const input of ['', undefined, null, 'totally unrelated text']) {
    const parsed = parseTlmgrVersionOutput(input)
    assert.strictEqual(parsed.version, null)
    assert.strictEqual(parsed.installationPath, null)
    assert.strictEqual(parsed.installationYear, null)
    assert.strictEqual(parsed.revision, null)
  }
})

check('install-tl 的 tlmgr 旧格式（TeX Live 2023 无 version 行）', () => {
  const parsed = parseTlmgrVersionOutput(
    'tlmgr revision 63210 (2022-05-12 14:50:03 +0200)\ntlmgr using installation: /usr/local/texlive/2022\n'
  )
  assert.strictEqual(parsed.version, null)
  assert.strictEqual(parsed.installationYear, '2022')
})

console.log('sanitizeTlmgrOutput（外发前脱敏）')

check('去掉 using installation 那一行，保留 revision 与 version 行', () => {
  const parsed = parseTlmgrVersionOutput(MIXED_STATE_OUTPUT)
  const lines = parsed.publicRaw.split('\n')
  assert.strictEqual(lines.length, 2)
  assert.ok(lines[0].startsWith('tlmgr revision 74695'))
  assert.strictEqual(
    lines[1],
    'TeX Live (https://tug.org/texlive) version 2025'
  )
})

check('外发文本里不含安装树路径 / 不含 using installation', () => {
  const parsed = parseTlmgrVersionOutput(MIXED_STATE_OUTPUT)
  assert.ok(!parsed.publicRaw.includes('using installation'))
  assert.ok(!parsed.publicRaw.includes('/usr/local/texlive'))
  assert.ok(!parsed.publicRaw.includes('2023'))
  // 完整原文仍然保留在服务端内部字段里（打日志用）
  assert.ok(parsed.raw.includes('/usr/local/texlive/2023'))
})

check('异常行里夹带安装路径也会被整行丢掉', () => {
  const out = sanitizeTlmgrOutput(
    'tlmgr revision 1 (x)\nnote: /usr/local/texlive/2023 is here\nTeX Live (https://tug.org/texlive) version 2025\n',
    '/usr/local/texlive/2023'
  )
  assert.strictEqual(out.split('\n').length, 2)
  assert.ok(!out.includes('/usr/local/texlive'))
})

check('空行被过滤', () => {
  const out = sanitizeTlmgrOutput('\n\ntlmgr revision 1\n\n', null)
  assert.strictEqual(out, 'tlmgr revision 1')
})

console.log('getTeXLiveVersion（本机真实调用，可能不可用）')

async function runAsync() {
  // 响应体形状：只有 available / version / raw，且 raw 必须已脱敏
  const responseBody = await new Promise(resolve => {
    clearCache()
    const res = { json: body => resolve(body) }
    get({}, res)
  })
  assert.deepStrictEqual(
    Object.keys(responseBody).sort(),
    ['available', 'raw', 'version'],
    'HTTP 响应体只应有 available / version / raw'
  )
  if (responseBody.raw) {
    assert.ok(!responseBody.raw.includes('using installation'))
    assert.ok(!responseBody.raw.includes('/usr/local/texlive'))
  }
  passed++
  console.log('  ✓ HTTP 响应体只有 available / version / raw，且已脱敏')

  clearCache()
  const result = await new Promise(resolve => {
    getTeXLiveVersion((error, info) => resolve({ error, info }))
  })
  if (result.error) {
    console.log(
      '  - 本机没有可用的 tlmgr，跳过真实探测断言：' +
        result.error.message.split('\n')[0]
    )
  } else {
    assert.ok(/^\d{4}$/.test(result.info.version), 'version 应为四位年份')
    console.log(
      `  ✓ 真实探测：version=${result.info.version} installationYear=${result.info.installationYear}`
    )
    passed++
  }

  console.log(`\n${passed} passed`)
}

runAsync().catch(error => {
  console.error(error)
  process.exit(1)
})
