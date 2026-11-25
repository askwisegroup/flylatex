'use strict'

/**
 * FlyLaTeX SSO · 静态 require 检查
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个文件（2026-11-22 线上 500 事故）
 * ---------------------------------------------------------------------------
 * `Sso/index.js` 里那三个 require 全写在 `wire()` 内部（懒执行：只有真的来
 * 授权请求时才跑），`Session.js` 的两行也是 T0 handler 触发。单元测试全部
 * stub 掉这些依赖，于是 63 个测试全绿，而线上第一次点「使用 FlyLaTeX 登录」
 * 直接 500：
 *
 *   Error: Cannot find module '../infrastructure/RedisWrapper'
 *   Require stack: app/src/Features/Sso/index.js
 *
 * 根因是把 `app/src/Features/Sso/` 当成一级目录写路径（应为 `../../`）。
 * 这类错误**任何 stub 都挡不住** —— 它发生在 Node 的模块解析阶段，连被
 * stub 的机会都没有。所以这里退一步：不执行代码，只检查每一行相对 require
 * 指向的文件真实存在。
 *
 * 这就是本测试存在的理由：懒 require 的代价是「编译期不报错」，那就补一个
 * 编译期检查。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const DIR = __dirname

/** 被测目录下的产品代码（不含测试文件，测试里的 require 是刻意写坏的标本）。 */
const FILES = fs
  .readdirSync(DIR)
  .filter(name => name.endsWith('.js') && !name.endsWith('.test.js'))

/**
 * 判断一个相对路径能否被 Node 解析到真实文件。
 * 覆盖 `require('./x')` → x.js / x/index.js / x 三种落点。
 */
function resolvesToFile(spec) {
  const base = path.resolve(DIR, spec)
  return [base, `${base}.js`, path.join(base, 'index.js')].some(candidate => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

test('Sso 目录里每个相对 require 都指向真实文件', () => {
  const broken = []

  for (const file of FILES) {
    const source = fs.readFileSync(path.join(DIR, file), 'utf8')
    // 只认 require('...') 单/双引号字面量；本目录没有动态拼接的 require。
    for (const match of source.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
      const spec = match[2]
      if (!resolvesToFile(spec)) {
        broken.push(`${file} → require('${spec}')`)
      }
    }
  }

  assert.deepStrictEqual(
    broken,
    [],
    '以下相对 require 解析不到真实文件（多半是少写了一级 ../）：\n' +
      broken.join('\n')
  )
})

test('Redis 客户端只在 buildStore 内部懒建（不在模块顶层）', () => {
  // 反过来的约束：SSO 的 store 必须是懒建的，否则「没配 SSO 的部署」也会连
  // 一次 Redis，单元测试也会被迫依赖完整运行时（见 Store.js 顶部注释）。
  // 顶层语句的特征：行首没有缩进。
  const lines = fs
    .readFileSync(path.join(DIR, 'index.js'), 'utf8')
    .split('\n')
  const hits = lines.filter(
    line =>
      line.includes('RedisWrapper.client(') &&
      !/^\s*(\/\/|\*)/.test(line) // 注释里的说明不算
  )
  assert.strictEqual(hits.length, 1, '应该只有一处建客户端')
  assert.ok(
    /^\s+/.test(hits[0]),
    `RedisWrapper.client() 跑到了模块顶层，会变成加载即连 Redis：${hits[0]}`
  )
})
