// Metrics must be initialized before importing anything else
require('@overleaf/metrics/initialize')

const CompileController = require('./app/js/CompileController')
const ContentController = require('./app/js/ContentController')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
logger.initialize('clsi')
if (Settings.sentry.dsn != null) {
  logger.initializeErrorReporting(Settings.sentry.dsn)
}
const Metrics = require('@overleaf/metrics')

// FIXED: 2026-11-10 拆分部署（web 容器 + clsi 容器）时，web 容器里的这一份 clsi 由配置关掉。
//   放在最前面：既不监听端口，也不初始化缓存/清理器，只保留一个空转进程，
//   免得 runit 看到进程退出后不停重启（日志刷屏 + 反复初始化）。
//   默认行为不变（不配 CLSI_ENABLED 就照常启动）。
const ClsiEnabled = require('./app/js/ClsiEnabled')
if (!ClsiEnabled.isEnabled(process.env, Settings)) {
  logger.info(
    'clsi disabled by configuration (CLSI_ENABLED=false); process kept alive so runit does not restart-loop'
  )
  setInterval(() => {}, 1 << 30)
  return
}

const smokeTest = require('./test/smoke/js/SmokeTests')
const ContentTypeMapper = require('./app/js/ContentTypeMapper')
const Errors = require('./app/js/Errors')

const Path = require('path')

Metrics.open_sockets.monitor(true)
Metrics.memory.monitor(logger)
Metrics.leaked_sockets.monitor(logger)

// FIXED: 2026-11-05 启动清道夫：上一轮 CLSI 异常退出/被 sv restart 时，
//   已 detached 的编译进程组会被 init 收养继续占 CPU，ProcessTable 又只存在内存里，
//   重启后无从得知它们属于哪个项目。必须在开始接受编译请求之前先清掉。
// OLD: 无（残留只能等重启容器）
require('./app/js/StaleCompileReaper').reapStaleCompiles()

// FIXED: 2026-11-10 启动即打一条「编译 CPU 隔离到底生效没」。
//   放在这里而不是等第一个编译，是因为这条日志是"限没限住"的唯一证据：
//   重启完 `sv restart clsi-sharelatex` 应该马上能在 info 里看到 cpus / nice / wrapper，
//   看到 "not applied" 就说明这台机器缺 taskset 或被配置关了（只剩 nice，没有硬限）。
require('./app/js/CpuLimiter').plan()

const ProjectPersistenceManager = require('./app/js/ProjectPersistenceManager')
const OutputCacheManager = require('./app/js/OutputCacheManager')
const ContentCacheManager = require('./app/js/ContentCacheManager')

ProjectPersistenceManager.init()
OutputCacheManager.init()

const express = require('express')
const bodyParser = require('body-parser')
const app = express()

Metrics.injectMetricsRoute(app)
app.use(Metrics.http.monitor(logger))

// Compile requests can take longer than the default two
// minutes (including file download time), so bump up the
// timeout a bit.
// FIXED: 2026-11 队列化之后，一个请求的耗时 = 排队等待（默认上限 90s）
//   + 编译（默认 300s / VIP 600s）+ 文件下载。原来的 10 分钟会被排队的
//   请求撞到，socket 先掉、web 侧只会看到连接中断。
//   现在取 14 分钟（必须大于 web 侧 COMPILE_REQUEST_TIMEOUT_MS 默认 13 分钟，
//   否则服务端先断，客户端拿不到真正的编译结果）。
const TIMEOUT = parseInt(process.env.CLSI_REQUEST_TIMEOUT_MS, 10) || 14 * 60 * 1000
app.use(function (req, res, next) {
  req.setTimeout(TIMEOUT)
  res.setTimeout(TIMEOUT)
  res.removeHeader('X-Powered-By')
  next()
})

app.param('project_id', function (req, res, next, projectId) {
  if (projectId?.match(/^[a-zA-Z0-9_-]+$/)) {
    next()
  } else {
    next(new Error('invalid project id'))
  }
})

app.param('user_id', function (req, res, next, userId) {
  if (userId?.match(/^[0-9a-f]{24}$/)) {
    next()
  } else {
    next(new Error('invalid user id'))
  }
})

app.param('build_id', function (req, res, next, buildId) {
  if (buildId?.match(OutputCacheManager.BUILD_REGEX)) {
    next()
  } else {
    next(new Error(`invalid build id ${buildId}`))
  }
})

app.param('contentId', function (req, res, next, contentId) {
  if (contentId?.match(OutputCacheManager.CONTENT_REGEX)) {
    next()
  } else {
    next(new Error(`invalid content id ${contentId}`))
  }
})

app.param('hash', function (req, res, next, hash) {
  if (hash?.match(ContentCacheManager.HASH_REGEX)) {
    next()
  } else {
    next(new Error(`invalid hash ${hash}`))
  }
})

// FIXED: 2026-11 把 query 里的 compileGroup 补进 body。
//   web 侧（ClsiManager._getCompilerUrl）把 compileGroup 放在查询参数里，
//   而 RequestParser 只读 body.compile.options.*，所以这个值一直是 undefined：
//   DockerRunner 的 compileGroupConfig 覆盖因此从未生效，编译队列也拿不到分组。
//   只在 body 里没给的时候补，body 显式传值时以 body 为准。
function mergeCompileGroupFromQuery(req, res, next) {
  const fromQuery = req.query?.compileGroup
  if (typeof fromQuery === 'string' && fromQuery !== '' && req.body?.compile) {
    req.body.compile.options = req.body.compile.options || {}
    if (req.body.compile.options.compileGroup == null) {
      req.body.compile.options.compileGroup = fromQuery
    }
  }
  next()
}

app.post(
  '/project/:project_id/compile',
  bodyParser.json({ limit: Settings.compileSizeLimit }),
  mergeCompileGroupFromQuery,
  CompileController.compile
)
app.post('/project/:project_id/compile/stop', CompileController.stopCompile)
app.delete('/project/:project_id', CompileController.clearCache)

app.get('/project/:project_id/sync/code', CompileController.syncFromCode)
app.get('/project/:project_id/sync/pdf', CompileController.syncFromPdf)
// FIXED: 2026-11-14 字数统计改为 POST 携带 resources。
// GET 版保留兼容（旧客户端），但没有 resources 时只能依赖「上一次编译留下的
// 目录内容」——目录里缺 \input 的文件时 texcount 只会报
// "!!! File ./chapters/xxx not found"，然后返回 0 字（线上真实故障）。
app.post(
  '/project/:project_id/wordcount',
  bodyParser.json({ limit: Settings.compileSizeLimit }),
  CompileController.wordcount
)
app.get('/project/:project_id/wordcount', CompileController.wordcount)
app.get('/project/:project_id/status', CompileController.status)
app.post('/project/:project_id/status', CompileController.status)

// Per-user containers
app.post(
  '/project/:project_id/user/:user_id/compile',
  bodyParser.json({ limit: Settings.compileSizeLimit }),
  mergeCompileGroupFromQuery,
  CompileController.compile
)
app.post(
  '/project/:project_id/user/:user_id/compile/stop',
  CompileController.stopCompile
)
app.delete('/project/:project_id/user/:user_id', CompileController.clearCache)

app.get(
  '/project/:project_id/user/:user_id/sync/code',
  CompileController.syncFromCode
)
app.get(
  '/project/:project_id/user/:user_id/sync/pdf',
  CompileController.syncFromPdf
)
app.post(
  '/project/:project_id/user/:user_id/wordcount',
  bodyParser.json({ limit: Settings.compileSizeLimit }),
  CompileController.wordcount
)
app.get(
  '/project/:project_id/user/:user_id/wordcount',
  CompileController.wordcount
)

const ForbidSymlinks = require('./app/js/StaticServerForbidSymlinks')

// create a static server which does not allow access to any symlinks
// avoids possible mismatch of root directory between middleware check
// and serving the files
const staticCompileServer = ForbidSymlinks(
  express.static,
  Settings.path.compilesDir,
  {
    setHeaders(res, path, stat) {
      if (Path.basename(path) === 'output.pdf') {
        // Calculate an etag in the same way as nginx
        // https://github.com/tj/send/issues/65
        const etag = (path, stat) =>
          `"${Math.ceil(+stat.mtime / 1000).toString(16)}` +
          '-' +
          Number(stat.size).toString(16) +
          '"'
        res.set('Etag', etag(path, stat))
      }
      res.set('Content-Type', ContentTypeMapper.map(path))
    },
  }
)

const staticOutputServer = ForbidSymlinks(
  express.static,
  Settings.path.outputDir,
  {
    setHeaders(res, path, stat) {
      if (Path.basename(path) === 'output.pdf') {
        // Calculate an etag in the same way as nginx
        // https://github.com/tj/send/issues/65
        const etag = (path, stat) =>
          `"${Math.ceil(+stat.mtime / 1000).toString(16)}` +
          '-' +
          Number(stat.size).toString(16) +
          '"'
        res.set('Etag', etag(path, stat))
      }
      res.set('Content-Type', ContentTypeMapper.map(path))
    },
  }
)

app.get(
  '/project/:project_id/user/:user_id/build/:build_id/output/*',
  function (req, res, next) {
    // for specific build get the path from the OutputCacheManager (e.g. .clsi/buildId)
    req.url =
      `/${req.params.project_id}-${req.params.user_id}/` +
      OutputCacheManager.path(req.params.build_id, `/${req.params[0]}`)
    staticOutputServer(req, res, next)
  }
)

app.get(
  '/project/:projectId/content/:contentId/:hash',
  ContentController.getPdfRange
)
app.get(
  '/project/:projectId/user/:userId/content/:contentId/:hash',
  ContentController.getPdfRange
)

app.get(
  '/project/:project_id/build/:build_id/output/*',
  function (req, res, next) {
    // for specific build get the path from the OutputCacheManager (e.g. .clsi/buildId)
    req.url =
      `/${req.params.project_id}/` +
      OutputCacheManager.path(req.params.build_id, `/${req.params[0]}`)
    staticOutputServer(req, res, next)
  }
)

app.get(
  '/project/:project_id/user/:user_id/output/*',
  function (req, res, next) {
    // for specific user get the path to the top level file
    logger.warn(
      { url: req.url },
      'direct request for file in compile directory'
    )
    req.url = `/${req.params.project_id}-${req.params.user_id}/${req.params[0]}`
    staticCompileServer(req, res, next)
  }
)

app.get('/project/:project_id/output/*', function (req, res, next) {
  logger.warn({ url: req.url }, 'direct request for file in compile directory')
  if (req.query?.build?.match(OutputCacheManager.BUILD_REGEX)) {
    // for specific build get the path from the OutputCacheManager (e.g. .clsi/buildId)
    req.url =
      `/${req.params.project_id}/` +
      OutputCacheManager.path(req.query.build, `/${req.params[0]}`)
  } else {
    req.url = `/${req.params.project_id}/${req.params[0]}`
  }
  staticCompileServer(req, res, next)
})

app.get('/oops', function (req, res, next) {
  logger.error({ err: 'hello' }, 'test error')
  res.send('error\n')
})

app.get('/oops-internal', function (req, res, next) {
  setTimeout(function () {
    throw new Error('Test error')
  }, 1)
})

app.get('/status', (req, res, next) => res.send('CLSI is alive\n'))

Settings.processTooOld = false
if (Settings.processLifespanLimitMs) {
  // Pre-emp instances have a maximum lifespan of 24h after which they will be
  //  shutdown, with a 30s grace period.
  // Spread cycling of VMs by up-to 2.4h _before_ their limit to avoid large
  //  numbers of VMs that are temporarily unavailable (while they reboot).
  Settings.processLifespanLimitMs -=
    Settings.processLifespanLimitMs * (Math.random() / 10)
  logger.info(
    { target: new Date(Date.now() + Settings.processLifespanLimitMs) },
    'Lifespan limited'
  )

  setTimeout(() => {
    logger.info({}, 'shutting down, process is too old')
    Settings.processTooOld = true
  }, Settings.processLifespanLimitMs)
}

function runSmokeTest() {
  if (Settings.processTooOld) return
  const INTERVAL = 30 * 1000
  if (
    smokeTest.lastRunSuccessful() &&
    CompileController.timeSinceLastSuccessfulCompile() < INTERVAL / 2
  ) {
    logger.debug('skipping smoke tests, got recent successful user compile')
    return setTimeout(runSmokeTest, INTERVAL / 2)
  }
  logger.debug('running smoke tests')
  smokeTest.triggerRun(err => {
    if (err) logger.error({ err }, 'smoke tests failed')
    setTimeout(runSmokeTest, INTERVAL)
  })
}
if (Settings.smokeTest) {
  runSmokeTest()
}

app.get('/health_check', function (req, res) {
  if (Settings.processTooOld) {
    return res.status(500).json({ processTooOld: true })
  }
  smokeTest.sendLastResult(res)
})

app.get('/smoke_test_force', (req, res) => smokeTest.sendNewResult(res))

app.use(function (error, req, res, next) {
  if (error instanceof Errors.NotFoundError) {
    logger.debug({ err: error, url: req.url }, 'not found error')
    res.sendStatus(404)
  } else if (error.code === 'EPIPE') {
    // inspect container returns EPIPE when shutting down
    res.sendStatus(503) // send 503 Unavailable response
  } else {
    logger.error({ err: error, url: req.url }, 'server error')
    res.sendStatus(error.statusCode || 500)
  }
})

const net = require('net')
const os = require('os')

let STATE = 'up'

const loadTcpServer = net.createServer(function (socket) {
  socket.on('error', function (err) {
    if (err.code === 'ECONNRESET') {
      // this always comes up, we don't know why
      return
    }
    logger.err({ err }, 'error with socket on load check')
    socket.destroy()
  })

  if (STATE === 'up' && Settings.internal.load_balancer_agent.report_load) {
    let availableWorkingCpus
    const currentLoad = os.loadavg()[0]

    // staging clis's have 1 cpu core only
    if (os.cpus().length === 1) {
      availableWorkingCpus = 1
    } else {
      availableWorkingCpus = os.cpus().length - 1
    }

    const freeLoad = availableWorkingCpus - currentLoad
    const freeLoadPercentage = Math.round(
      (freeLoad / availableWorkingCpus) * 100
    )
    if (freeLoadPercentage <= 0) {
      // When its 0 the server is set to drain implicitly.
      // Drain will move new projects to different servers.
      // Drain will keep existing projects assigned to the same server.
      // Maint will more existing and new projects to different servers.
      socket.write(`maint, 0%\n`, 'ASCII')
    } else {
      // Ready will cancel the maint state.
      socket.write(`up, ready, ${freeLoadPercentage}%\n`, 'ASCII')
    }
    socket.end()
  } else {
    socket.write(`${STATE}\n`, 'ASCII')
    socket.end()
  }
})

const loadHttpServer = express()

loadHttpServer.post('/state/up', function (req, res, next) {
  STATE = 'up'
  logger.debug('getting message to set server to down')
  res.sendStatus(204)
})

loadHttpServer.post('/state/down', function (req, res, next) {
  STATE = 'down'
  logger.debug('getting message to set server to down')
  res.sendStatus(204)
})

loadHttpServer.post('/state/maint', function (req, res, next) {
  STATE = 'maint'
  logger.debug('getting message to set server to maint')
  res.sendStatus(204)
})

const port = Settings.internal?.clsi?.port || 3013
// FIXED: 2026-11-03 分离模式（web + clsi 两个容器）下需要监听 0.0.0.0，
//   但 internal.clsi.host 只在生产 settings 里存在，用环境变量兜一层，
//   避免“clsi 只在 loopback 监听 → web 全部 unavailable”这个必踩坑。
//   环境变量优先：共享 settings 里很可能已经写了 host: 'localhost'，
//   若 settings 优先，容器级的 CLSI_LISTEN_ADDRESS 会静默失效。
// OLD: const host = Settings.internal?.clsi?.host || 'localhost'
const host =
  process.env.CLSI_LISTEN_ADDRESS ||
  Settings.internal?.clsi?.host ||
  'localhost'

const loadTcpPort = Settings.internal.load_balancer_agent.load_port
const loadHttpPort = Settings.internal.load_balancer_agent.local_port

if (!module.parent) {
  // Called directly

  // handle uncaught exceptions when running in production
  if (Settings.catchErrors) {
    process.removeAllListeners('uncaughtException')
    process.on('uncaughtException', error =>
      logger.error({ err: error }, 'uncaughtException')
    )
  }

  app.listen(port, host, error => {
    if (error) {
      logger.fatal({ error }, `Error starting CLSI on ${host}:${port}`)
    } else {
      logger.debug(`CLSI starting up, listening on ${host}:${port}`)
    }
  })

  loadTcpServer.listen(loadTcpPort, host, function (error) {
    if (error != null) {
      throw error
    }
    logger.debug(`Load tcp agent listening on load port ${loadTcpPort}`)
  })

  loadHttpServer.listen(loadHttpPort, host, function (error) {
    if (error != null) {
      throw error
    }
    logger.debug(`Load http agent listening on load port ${loadHttpPort}`)
  })
}

module.exports = app
