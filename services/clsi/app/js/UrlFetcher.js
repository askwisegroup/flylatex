const fs = require('fs')
const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')
const { fetchStream } = require('@overleaf/fetch-utils')
const { URL } = require('url')
const { pipeline } = require('stream/promises')

async function pipeUrlToFileWithRetry(url, filePath) {
  let remainingAttempts = 3
  let lastErr
  while (remainingAttempts-- > 0) {
    try {
      await pipeUrlToFile(url, filePath)
      return
    } catch (err) {
      logger.warn(
        { err, url, filePath, remainingAttempts },
        'error downloading url'
      )
      lastErr = err
    }
  }
  throw lastErr
}

async function pipeUrlToFile(url, filePath) {
  const u = new URL(url)
  // FIXED: 2026-11-03 分离模式（web + clsi 两个容器）
  //   1) 资源 URL 里的 filestore 地址默认是 localhost:3009，拆开后 clsi 容器里的
  //      localhost 是它自己 → 下载 404/ECONNREFUSED。用环境变量把 host 重写成 web 容器名，
  //      不需要改生产 settings，也不影响 web 侧。
  //   2) Settings.apis.clsiPerf 在生产 settings 里可能不存在（原代码在此直接取 .host），
  //      一旦启用 filestoreDomainOveride 就会在每次下载时抛 TypeError → 编译全挂。
  //   环境变量优先，保证容器级覆盖不会被共享 settings 静默覆盖。
  // OLD:
  //   if (Settings.filestoreDomainOveride && u.host !== Settings.apis.clsiPerf.host) {
  //     url = `${Settings.filestoreDomainOveride}${u.pathname}${u.search}`
  //   }
  const filestoreDomainOveride =
    process.env.FILESTORE_DOMAIN_OVERRIDE || Settings.filestoreDomainOveride
  if (filestoreDomainOveride && u.host !== Settings.apis?.clsiPerf?.host) {
    url = `${filestoreDomainOveride}${u.pathname}${u.search}`
  }

  const stream = await fetchStream(url, {
    signal: AbortSignal.timeout(60 * 1000),
  })

  const atomicWrite = filePath + '~'
  try {
    await pipeline(stream, fs.createWriteStream(atomicWrite))
    await fs.promises.rename(atomicWrite, filePath)
  } catch (err) {
    try {
      await fs.promises.unlink(atomicWrite)
    } catch (e) {}
    throw err
  }
}

module.exports.promises = {
  pipeUrlToFileWithRetry,
}
