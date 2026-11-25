#!/usr/bin/env node
/**
 * 静态检查 app/src 下"启动即挂、但 node --check 看不出来"的故障。
 *
 *   1) [error]   module.exports 里引用了本文件没有声明的标识符
 *                → require 时 ReferenceError，web 进程起不来，nginx 502。
 *                典型成因：用脚本整段替换代码，把别处的函数一并删掉了。
 *   2) [warn]    require('相对路径') 解析不到
 *                → Cannot find module。有些是未被加载的死代码或未 checkout 的
 *                  子模块，所以这里只警告，不阻断。
 *
 * 用法：node scripts/check_app_require_graph.js [--warn-as-error] [目录...]
 * 退出码：有 error（或 --warn-as-error 下有 warn）时为 1。
 */
const fs = require('fs')
const path = require('path')

const WEB_ROOT = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const warnAsError = args.includes('--warn-as-error')
const dirs = args.filter(a => !a.startsWith('--'))
const TARGETS = dirs.length
  ? dirs.map(d => path.resolve(d))
  : [path.join(WEB_ROOT, 'app', 'src')]

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(full, out)
    } else if (entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++
  return line
}

/** 本文件顶层声明的名字（function/class/const/let/var，含解构） */
function declaredNames(source) {
  const names = new Set()
  const plain = [
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ]
  for (const re of plain) {
    let m
    while ((m = re.exec(source))) names.add(m[1])
  }
  const destructure = /(?:^|\n)\s*(?:const|let|var)\s*\{([^}]*)\}\s*=/g
  let m
  while ((m = destructure.exec(source))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return names
}

const LITERALS = new Set(['true', 'false', 'null', 'undefined'])

/**
 * module.exports = { ... } 的**顶层**条目。
 * 只按 depth===0 的逗号切分，方法简写（含逗号的参数列表）不会被切碎。
 */
function exportedEntries(source) {
  const entries = []
  const re = /module\.exports\s*=\s*\{/g
  let m
  while ((m = re.exec(source))) {
    let i = re.lastIndex
    let depth = 1
    let paren = 0
    let start = i
    const push = end => {
      const entry = source.slice(start, end).trim()
      start = end + 1
      if (!entry) return
      const name = /^([A-Za-z_$][\w$]*)\s*$/.exec(entry)
      const pair = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(
        entry
      )
      const value = name ? name[1] : pair ? pair[2] : null
      if (value && !LITERALS.has(value)) {
        entries.push(value)
      }
    }
    while (i < source.length) {
      const ch = source[i]
      if (ch === '(' || ch === '[') paren++
      else if (ch === ')' || ch === ']') paren--
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          push(i)
          break
        }
      } else if (ch === ',' && depth === 1 && paren === 0) {
        push(i)
      }
      i++
    }
  }
  return entries
}

const errors = []
const warnings = []
let fileCount = 0

for (const dir of TARGETS) {
  for (const file of walk(dir)) {
    fileCount++
    const source = fs.readFileSync(file, 'utf8')
    const rel = path.relative(WEB_ROOT, file)

    const declared = declaredNames(source)
    const exportIndex = source.indexOf('module.exports')
    for (const name of exportedEntries(source)) {
      if (!declared.has(name)) {
        const at = exportIndex >= 0 ? lineOf(source, exportIndex) : 1
        errors.push(
          `${rel}:${at}  module.exports 里的 \`${name}\` 本文件没有声明` +
            '（require 时 ReferenceError，web 起不来）'
        )
      }
    }

    const reqRe = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g
    let m
    while ((m = reqRe.exec(source))) {
      const request = m[1]
      const target = path.resolve(path.dirname(file), request)
      try {
        require.resolve(target)
      } catch (err) {
        warnings.push(
          `${rel}:${lineOf(source, m.index)}  require('${request}') 解析不到`
        )
      }
    }
  }
}

for (const warning of warnings) console.warn('warn  ' + warning)
for (const error of errors) console.error('ERROR ' + error)
console.log(
  `check_app_require_graph: ${fileCount} files, ${errors.length} error(s), ${warnings.length} warning(s)`
)

const failed = errors.length > 0 || (warnAsError && warnings.length > 0)
process.exit(failed ? 1 : 0)
