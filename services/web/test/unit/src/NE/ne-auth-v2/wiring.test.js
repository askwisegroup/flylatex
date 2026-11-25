const { expect } = require('chai')
const fs = require('fs')
const path = require('path')

/**
 * 接线契约一致性测试
 *
 * 前端(pug/前端模块)、后端(路由/控制器)与 SDK 之间靠「约定字符串」连接
 * （字段名、路由路径、模块导入）。这类错误类型检查抓不到、又必须在真实页面上
 * 才能发现，因此这里用静态扫描把契约钉死。
 */

const WEB_ROOT = path.resolve(__dirname, '../../../../..')

function read(relPath) {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), 'utf8')
}

describe('ne-auth-v2/接线契约一致性', function () {
  const LOGIN_PUG = 'app/views/user/login.pug'
  const ROUTER = 'app/src/router.js'
  const CONTROLLER =
    'app/src/Features/Authentication/AuthenticationController.js'
  const MANAGER = 'app/src/Features/Authentication/AuthenticationManager.js'
  const MARKETING = 'frontend/js/marketing.js'
  const FE_MODULE = 'frontend/js/features/ne-login-captcha.js'
  const NE_INDEX = 'commercial/index.js'

  it('登录表单提供 captcha_verify_param 隐藏域与验证码容器', function () {
    const pug = read(LOGIN_PUG)
    expect(pug).to.include("name='captcha_verify_param'")
    // pug 使用 #id 简写
    expect(pug).to.include('#ne-captcha-slot')
    expect(pug).to.include('#ne-captcha-holder')
    expect(pug).to.include('#ne-captcha-status')
    // 表单必须是 POST /login，字段才能被控制器读到
    expect(pug).to.include("action='/login'")
    expect(pug).to.include('method="POST"')
  })

  it('后端读取的字段名与表单字段名一致', function () {
    const pug = read(LOGIN_PUG)
    const ctrl = read(CONTROLLER)
    const fieldMatch = pug.match(
      /input\(name='([a-z_]+)',\s*type='hidden',\s*value='',\s*data-ol-ne-captcha-field\)/
    )
    expect(fieldMatch, '未找到验证码隐藏域').to.not.equal(null)
    const fieldName = fieldMatch[1]
    expect(ctrl).to.include(`req.body.captcha_verify_param`)
    expect(fieldName).to.equal('captcha_verify_param')
  })

  it('控制器把验证码参数放进 authenticate 的 query', function () {
    expect(read(CONTROLLER)).to.include('captchaVerifyParam:')
  })

  it('AuthenticationManager 把它透传给 NELogin（第 3 个位置参数）', function () {
    const mgr = read(MANAGER)
    expect(mgr).to.include(
      'NEService.NELogin(email, password, query.captchaVerifyParam,'
    )
  })

  it('router 挂载 /ne/captcha-config 并加入登录白名单', function () {
    const router = read(ROUTER)
    expect(router).to.include(
      "addEndpointToLoginWhitelist('/ne/captcha-config')"
    )
    expect(router).to.include(
      "webRouter.get('/ne/captcha-config', NEService.GetCaptchaConfig)"
    )
  })

  it('NEService 导出了 GetCaptchaConfig', function () {
    expect(read(NE_INDEX)).to.include('GetCaptchaConfig: getCaptchaConfig')
  })

  it('前端模块请求的路径与后端挂载路径一致', function () {
    const router = read(ROUTER)
    const fe = read(FE_MODULE)
    const route = router.match(/webRouter\.get\('(\/ne\/captcha-config)'/)
    expect(route).to.not.equal(null)
    // FIXED: 2026-11-20 配置请求带时间戳（配置是 per-session 的，不能被中间层缓存）
    expect(fe).to.include(`getJSON('${route[1]}?_=' + Date.now())`)
  })

  // FIXED: 2026-11-20 「登录加密数据已失效或无效」不能再让用户自己清 cookie：
  // 前端要能自己重取配置并重试一次。
  it('前端在加密数据失效时自动重取配置并重提一次', function () {
    const fe = read(FE_MODULE)
    expect(fe).to.include('加密数据已失效')
    expect(fe).to.include('autoRetried')
    expect(fe).to.include("pwForm.dispatchEvent(")
  })

  it('marketing 入口引入了登录页验证码模块', function () {
    expect(read(MARKETING)).to.include("import './features/ne-login-captcha'")
  })

  it('前端模块引用了 SDK 的浏览器端验证码封装', function () {
    const fe = read(FE_MODULE)
    expect(fe).to.include('ne-auth-v2/browser/captcha')
    expect(fe).to.include('NeAuthCaptcha.createController')
  })

  it('前端模块使用的 DOM 元素 id 与 pug 中一致', function () {
    const pug = read(LOGIN_PUG)
    const fe = read(FE_MODULE)
    for (const id of [
      'ne-captcha-holder',
      'ne-captcha-slot',
      'ne-captcha-status',
    ]) {
      expect(pug, `pug 缺少 ${id}`).to.include(id)
      expect(fe, `前端模块未引用 ${id}`).to.include(id)
    }
  })

  it('前端模块不直接使用 console（node/前端均禁用 console 规则）', function () {
    expect(read(FE_MODULE)).to.not.match(/console\.(log|warn|error)/)
  })

  it('后端不回传 NE 的 baseUrl / publicKey 给登录页', function () {
    const ne = read(NE_INDEX)
    const block = ne.slice(ne.indexOf('async function getCaptchaConfig'))
    const body = block.slice(0, block.indexOf('\n}'))
    expect(body).to.not.include('publicKey')
    expect(body).to.not.include('public_key')
    expect(body).to.not.include('baseUrl')
  })
})

describe('ne-auth-v2/接线契约一致性（短信 / CARSI / 文案）', function () {
  const LOGIN_PUG = 'app/views/user/login.pug'
  const ROUTER = 'app/src/router.js'
  const CONTROLLER =
    'app/src/Features/Authentication/AuthenticationController.js'
  const MANAGER = 'app/src/Features/Authentication/AuthenticationManager.js'
  const SERVER = 'app/src/infrastructure/Server.js'
  const FE_MODULE = 'frontend/js/features/ne-login-captcha.js'
  const NE_INDEX = 'commercial/index.js'
  const CARSI = 'commercial/carsi.js'
  const CARSI_V2 = 'commercial/carsi-v2.js'
  const LOCALES = ['locales/en.json', 'locales/zh-CN.json']

  function readJson(relPath) {
    return JSON.parse(read(relPath))
  }

  it('短信表单提交到 /login/sms，字段名与命名策略一致', function () {
    const pug = read(LOGIN_PUG)
    expect(pug).to.include("action='/login/sms'")
    expect(pug).to.include("name='mobile'")
    expect(pug).to.include("name='code'")

    const server = read(SERVER)
    expect(server).to.include("'ne-sms'")
    expect(server).to.include("usernameField: 'mobile'")
    expect(server).to.include("passwordField: 'code'")
    expect(server).to.include('doPassportSmsLogin')
    expect(read(CONTROLLER)).to.include("passport.authenticate('ne-sms'")
  })

  it('短信登录与密码登录共用同一个「查找或创建」解析函数', function () {
    const mgr = read(MANAGER)
    const start = mgr.indexOf('authenticateBySms(mobile, code, callback)')
    expect(start, '未找到 authenticateBySms').to.be.above(-1)
    const block = mgr.slice(start, start + 2000)
    expect(block, '必须复用同一解析函数').to.include(
      '_findOrUpdateByEmailOrCreate('
    )
    expect(block).to.include('NEService.SmsLogin(identifier, code,')
    expect(block, '标识必须是手机号本身').to.include(
      "const identifier = String(mobile || '').trim()"
    )
  })

  it('router 挂载短信端点并加入登录白名单', function () {
    const router = read(ROUTER)
    expect(router).to.include("addEndpointToLoginWhitelist('/ne/sendcode')")
    expect(router).to.include(
      "webRouter.post('/ne/sendcode', NEService.SendLoginSms)"
    )
    expect(router).to.include("addEndpointToLoginWhitelist('/login/sms')")
    expect(router).to.include(
      "webRouter.post('/login/sms', AuthenticationController.smsLogin)"
    )
  })

  it('前端发送短信的路径与后端挂载路径一致', function () {
    const route = read(ROUTER).match(/webRouter\.post\('(\/ne\/sendcode)'/)
    expect(route, '未找到 /ne/sendcode 路由').to.not.equal(null)
    expect(read(FE_MODULE)).to.include(`postJSON('${route[1]}'`)
  })

  it('NEService 导出了短信相关的两个入口', function () {
    const ne = read(NE_INDEX)
    expect(ne).to.include('SendLoginSms: handleSendLoginSms')
    expect(ne).to.include('SmsLogin: smsLoginV2')
  })

  it('CARSI 入口与回调地址固定，且路由已挂载', function () {
    expect(read(LOGIN_PUG)).to.include('href="/carsi"')
    const router = read(ROUTER)
    expect(router).to.include("addEndpointToLoginWhitelist('/carsi')")
    expect(router).to.include(
      "webRouter.get('/carsi', CarsiV2Service.startCarsiLogin)"
    )
    // 回调地址必须与在 NE 登记的 redirect 逐字符一致，改动需同步登记
    expect(router).to.include(
      "addEndpointToLoginWhitelist('/ne-auth-callback')"
    )
    expect(router).to.include(
      "webRouter.get('/ne-auth-callback', CarsiV2Service.handleCarsiCallback)"
    )
  })

  it('CARSI 回调复用既有收尾逻辑（用户匹配与 VIP 处理）', function () {
    expect(read(CARSI)).to.include('sendCarsiAuthForm')
    const v2 = read(CARSI_V2)
    expect(v2).to.include("require('./carsi')")
    expect(v2).to.include('CarsiService.sendCarsiAuthForm(')
    expect(v2).to.include("require('./ne-auth-v2')")
  })

  it('登录页引用的每个 ne_ 文案 key 都已翻译', function () {
    const keys = new Set(
      [...read(LOGIN_PUG).matchAll(/translate\("(ne_[a-z_]+)"\)/g)].map(
        m => m[1]
      )
    )
    expect(keys.size, '未找到任何 ne_ 文案').to.be.above(0)
    for (const rel of LOCALES) {
      const dict = readJson(rel)
      for (const key of keys) {
        expect(dict, `${rel} 缺少 ${key}`).to.have.property(key)
      }
    }
  })

  it('两种语言的 ne_ 文案 key 集合一致', function () {
    const sets = LOCALES.map(rel =>
      Object.keys(readJson(rel))
        .filter(k => k.startsWith('ne_'))
        .sort()
    )
    expect(sets[0].length).to.be.above(0)
    expect(sets[0]).to.deep.equal(sets[1])
  })

  it('前端读取的 data-ne-* 与 pug 定义的严格一一对应', function () {
    const pugAttrs = new Set(
      [...read(LOGIN_PUG).matchAll(/data-ne-[a-z-]+/g)].map(m => m[0])
    )
    const feAttrs = new Set(
      [...read(FE_MODULE).matchAll(/\bd\.(ne[A-Za-z]+)/g)].map(
        m => 'data-' + m[1].replace(/[A-Z]/g, c => '-' + c.toLowerCase())
      )
    )
    expect(feAttrs.size, '未发现前端读取的 data-ne-*').to.be.above(0)
    expect([...feAttrs].sort()).to.deep.equal([...pugAttrs].sort())
  })

  it('短信发送有手动入口（验证码关闭时唯一触发点）', function () {
    expect(read(LOGIN_PUG)).to.include('ne-send-sms-code')
    expect(read(FE_MODULE)).to.include("'ne-send-sms-code'")
  })
})
