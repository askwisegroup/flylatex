/**
 * CompilerDetector - 从一个项目目录（zip 解压目录 / git 克隆目录）推断编译器
 *
 * 为什么需要它：
 *   DocumentHelper.getCompilerFromTexContent 只看一个文件的内容。
 *   而 LuaLaTeX 项目很常见的情况是——主文档干净的 `\documentclass{article}`，
 *   `\directlua` / `\begin{luacode}` 全在 chapters/*.tex 里。
 *   只看主文档 → 推断不出 → 项目按默认 pdflatex 编译 → 必然失败。
 *
 * 所以这里把目录里所有 .tex 都读一小段，主文档排在最前面，交给
 * DocumentHelper.getCompilerFromTexContents 统一打分。
 *
 * 全程尽力而为：读不到、没有主文档、文件太多，都只是少一些线索，不抛错。
 */

const fs = require('fs-extra')
const Path = require('path')
const logger = require('@overleaf/logger')
const DocumentHelper = require('../Documents/DocumentHelper')
const ProjectRootDocManager = require('../Project/ProjectRootDocManager')

// 最多看多少个 .tex 文件（大项目里没必要全读）
const MAX_TEX_FILES = 80
// 每个文件最多读多少字节（导言区足够了）
const MAX_BYTES_PER_FILE = 200 * 1024
// 跳过的目录
const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'vendor',
  '__pycache__',
])

/**
 * @param {string} dir - 项目根目录
 * @param {string} [rootContent] - 已知的主文档内容（可选，省一次读盘）
 * @returns {Promise<'lualatex'|'xelatex'|'pdflatex'|'latex'|null>}
 */
async function detectCompilerFromDirectory(dir, rootContent) {
  if (!dir) {
    return null
  }

  const contents = []
  const seen = new Set()

  // 1) 主文档优先
  if (rootContent) {
    contents.push(rootContent)
  } else {
    try {
      const { path, content } =
        await ProjectRootDocManager.promises.findRootDocFileFromDirectory(dir)
      if (path) {
        seen.add(Path.resolve(dir, path))
      }
      if (content) {
        contents.push(content)
      }
    } catch (error) {
      logger.debug(
        { dir, error: error.message },
        'compiler detection: no root document found'
      )
    }
  }

  // 2) 其余 .tex 文件（主文档已读过的跳过）
  const texFiles = []
  try {
    await collectTexFiles(dir, texFiles, 0)
  } catch (error) {
    logger.debug(
      { dir, error: error.message },
      'compiler detection: failed to walk directory'
    )
  }

  for (const file of texFiles) {
    if (contents.length >= MAX_TEX_FILES) {
      break
    }
    if (seen.has(Path.resolve(file))) {
      continue
    }
    try {
      const stat = await fs.stat(file)
      if (stat.size === 0) {
        continue
      }
      const content = await fs.readFile(file, 'utf8')
      contents.push(content.slice(0, MAX_BYTES_PER_FILE))
    } catch (error) {
      logger.debug(
        { file, error: error.message },
        'compiler detection: failed to read tex file'
      )
    }
  }

  const compiler = DocumentHelper.getCompilerFromTexContents(contents)
  logger.debug(
    { dir, texFileCount: contents.length, compiler },
    'compiler detection finished'
  )
  return compiler
}

async function collectTexFiles(dir, out, depth) {
  if (out.length >= MAX_TEX_FILES || depth > 8) {
    return
  }
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_TEX_FILES) {
      return
    }
    const name = entry.name
    if (name.startsWith('.') || SKIP_DIRS.has(name)) {
      continue
    }
    const fullPath = Path.join(dir, name)
    if (entry.isDirectory()) {
      await collectTexFiles(fullPath, out, depth + 1)
    } else if (entry.isFile() && /\.tex$/i.test(name)) {
      out.push(fullPath)
    }
  }
}

module.exports = { detectCompilerFromDirectory }
