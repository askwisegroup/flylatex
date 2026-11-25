'use strict'

/**
 * FlyLaTeX Navigation · 静态 require 检查
 *
 * 起因见 `Features/Sso/requires.test.js` 与 AGENTS.md §2：懒 require（写在函数体
 * 里）在模块解析阶段不报错，单测全绿、线上第一次真的调用才 500。
 * `PortalMenu.readFromDb()` 里就有一行懒 require：
 *
 *   require('../../infrastructure/mongodb')
 *
 * 层级记牢：`app/src/Features/Navigation/` 下 `../` = `Features/`，
 * `../../` = `app/src/`。写错成 `../infrastructure/...` 时，导航栏会在
 * 「第一次真的读配置」那一刻炸掉（有缓存兜底的话更晚暴露），所以这里只检查
 * 「每一行相对 require 都指向真实文件」，不执行任何代码。
 *
 * Run: node --test app/src/Features/Navigation/requires.test.js
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const DIR = __dirname

const FILES = fs
  .readdirSync(DIR)
  .filter(name => name.endsWith('.js') && !name.endsWith('.test.js'))

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

test('Navigation 目录里每个相对 require 都指向真实文件', () => {
  const broken = []

  for (const file of FILES) {
    const source = fs.readFileSync(path.join(DIR, file), 'utf8')
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
    `以下懒 require 解析不到真实文件：\n${broken.join('\n')}`
  )
})
