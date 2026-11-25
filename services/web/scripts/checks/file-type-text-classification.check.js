'use strict'

/**
 * 上传归类回归测试：文本扩展名的文件什么时候会被判成「二进制文件」。
 *
 * 背景（2026-11-08）：
 *   同一个 .md，在不同的项目里表现完全不同 ——
 *     · 如果是 doc（文档实体）→ 打开进源码编辑器，有「代码编辑器 / 可视化编辑器」开关
 *     · 如果是 file（二进制实体）→ 打开进 file-view，只能下载 + 看裸文本
 *   差别不是 UI，而是**上传时的归类结果**：FileTypeManager.getType() 决定存成 doc 还是 file。
 *   上游规则里有一条「内容含非 BMP 字符（emoji 等代理对）→ 判成二进制」，
 *   于是一个带 ✅ 的 Markdown 清单上传后就不能编辑了。
 *
 * 现在的口径（本用例钉死）：
 *   - 文本扩展名的判定只看「扩展名 + 体积」，**完全不嗅探内容**
 *   - 带 emoji / CJK 扩展 B / NUL 字节的 .md/.tex → 依然是 doc（可编辑）
 *   - 超过 MAX_TEXT_FILE_SIZE(1MB) → 二进制（体积保护，不是内容判断）
 *   - 非文本扩展名（.png 等）→ 二进制
 *
 * Run: node scripts/checks/file-type-text-classification.check.js
 * 需要 mongo/redis/overleaf 配置吗？不需要（stub 掉 @overleaf/settings 等）。
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const WEB_ROOT = path.join(__dirname, '..', '..')

const stub = exports => ({ loaded: true, exports })
const absorbing = () =>
  new Proxy(function () {}, {
    get: (target, prop) => (prop === 'then' ? undefined : absorbing()),
    apply: () => absorbing(),
  })

const stubbed = new Map([
  [
    '@overleaf/settings',
    stub({
      textExtensions: ['tex', 'latex', 'md', 'markdown', 'txt', 'bib'],
      editableFilenames: ['latexmkrc', '.latexmkrc', 'makefile'],
      fileIgnorePattern: '**/{{__MACOSX,.git}}',
    }),
  ],
  [
    '@overleaf/promise-utils',
    stub({ promisifyAll: () => {}, expressify: f => f }),
  ],
  [
    'utf-8-validate',
    // 真实包是 `isValid(buffer)`：这里用「往返编解码是否一致」等价实现
    stub(
      b =>
        Buffer.isBuffer(b) && Buffer.from(b.toString('utf8'), 'utf8').equals(b)
    ),
  ],
])

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubbed.has(request)) {
    return stubbed.get(request).exports
  }
  if (request.startsWith('../')) {
    return absorbing()
  }
  return originalLoad(request, parent, isMain)
}

const FileTypeManager = require(path.join(
  WEB_ROOT,
  'app/src/Features/Uploads/FileTypeManager.js'
))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftype-'))

function getType(name, content) {
  const fsPath = path.join(tmpDir, `${Date.now()}-${name}`)
  fs.writeFileSync(fsPath, content)
  return new Promise((resolve, reject) => {
    FileTypeManager.getType(name, fsPath, undefined, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

const cases = [
  ['普通 .md', 'plain.md', '# 标题\n', false],
  [
    '带 emoji 的 .md（核心修复点）',
    'emoji.md',
    '# ✅ 已修\n- ⚠️ 注意\n',
    false,
  ],
  ['带 CJK 扩展 B 的 .md', 'rare.md', '𠀋 生僻字\n', false],
  ['带 emoji 的 .tex', 'emoji.tex', '% ✅\n\\section{x}\n', false],
  ['含 NUL 字节的 .md（不再内容嗅探）', 'nul.md', 'abc\u0000def', false],
  ['超过 1MB 的 .md', 'big.md', 'x'.repeat(1024 * 1024 + 10), true],
  ['图片扩展名', 'a.png', 'not-really-png', true],
]

async function main() {
  const failed = []
  for (const [label, name, content, expectBinary] of cases) {
    const result = await getType(name, content)
    const pass = result.binary === expectBinary
    if (!pass) failed.push(label)
    console.log(
      `${pass ? '✓' : '✗'} ${label}: binary=${
        result.binary
      }（期望 ${expectBinary}）`
    )
  }
  assert.deepStrictEqual(failed, [], `这些用例不符合预期: ${failed.join(', ')}`)
  console.log(
    '✓ 上传归类：文本扩展名只看扩展名+体积（emoji/生僻字/NUL 都还是文档），超大/非文本才是二进制'
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

main().catch(err => {
  console.error('✗ 用例失败:', err.message)
  process.exit(1)
})
