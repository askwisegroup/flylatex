const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cookie = require('cookie')
const { JSDOM, VirtualConsole } = require('jsdom')

const WEB = path.resolve(__dirname, '../../../..')
const PUG = path.join(WEB, 'app/views/layout-base.pug')

// 语言切换脚本就写在 layout-base.pug 的 script 文本块里，这里把它抽出来直接跑
function inlineLanguageScript() {
  const source = fs.readFileSync(PUG, 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex(line =>
    line.includes('script(type="text/javascript").')
  )
  assert.ok(start > -1, 'inline script block not found')
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) {
      body.push('')
      continue
    }
    if (line.match(/^\t*/)[0].length <= 3) break // 块结束
    body.push(line.replace(/^\t{4}/, ''))
  }
  // pug 插值在这个文本块里是运行期替换的，测试里给一个固定站点域
  return body
    .join('\n')
    .replace(/!\{JSON\.stringify\([^)]*\)\}/g, "'example.com'")
}

const SCRIPT = inlineLanguageScript()
const COOKIE_NAME = SCRIPT.match(/var FLYLATEX_LANG_COOKIE = '([^']+)'/)[1]

function boot(initialCookies) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.example.com/user/settings',
    runScripts: 'outside-only',
    // 页面里会 location.reload()，jsdom 只会报 "not implemented"，静音掉
    virtualConsole: new VirtualConsole(),
  })
  const win = dom.window
  for (const value of initialCookies || []) {
    win.eval(`document.cookie = ${JSON.stringify(value)}`)
  }
  win.eval(SCRIPT)
  return win
}

// 服务端读的是第一条（cookie.parse 保留首次出现的值）
function serverSees(win) {
  return cookie.parse(win.document.cookie)[COOKIE_NAME]
}

describe('layout-base 语言切换脚本', function () {
  it('把语言写进服务端读取的那个 cookie', function () {
    const win = boot()
    win.flylatexSetLanguage('ja')

    assert.equal(serverSees(win), 'ja')
    const values = win.document.cookie
      .split('; ')
      .filter(part => part.startsWith(COOKIE_NAME + '='))
    assert.equal(values.length, 1)
  })

  // 这就是「切换完一刷新又变回去」：门户站写的是 host-only，本站写的是
  // Domain=.example.com，两条同名 cookie 里旧的（排在前面的）赢，服务端只会
  // 读到旧语言。写法改成「先作废两种作用域，再写一条」。
  it('作废同名不同作用域的旧 cookie，剩下的那条才是新语言', function () {
    const win = boot([
      `${COOKIE_NAME}=zh-CN; Path=/`, // 官网首页写下的 host-only 旧值
      `${COOKIE_NAME}=zh-CN; Path=/; Domain=.example.com`, // 本站旧代码写下的
    ])
    assert.equal(serverSees(win), 'zh-CN')

    win.flylatexSetLanguage('ja')

    assert.equal(serverSees(win), 'ja')
    const values = win.document.cookie
      .split('; ')
      .filter(part => part.startsWith(COOKIE_NAME + '='))
    assert.equal(values.length, 1)
  })

  it('同时把五个 localStorage key 都写成同一个语言', function () {
    const win = boot()
    win.flylatexSetLanguage('pt-BR')

    const keys = SCRIPT.match(
      /var FLYLATEX_LANG_STORAGE_KEYS = \[([^\]]*)\]/
    )[1]
    const list = keys.match(/'[^']*'/g).map(item => item.slice(1, -1))
    assert.equal(list.length, 5)
    for (const key of list) {
      assert.equal(win.localStorage.getItem(key), 'pt-BR')
    }
    assert.equal(serverSees(win), 'pt-BR')
  })
})
