/**
 * GitService - Git 操作服务
 * 使用系统 Git 命令，支持多用户、多项目隔离
 */

const { spawn } = require('child_process')
const fs = require('fs-extra')
const path = require('path')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const GitUrlUtil = require('./GitUrlUtil')
const GitErrorUtil = require('./GitErrorUtil')

// 操作锁（防止同一项目的并发操作）
const operationLocks = new Map()

// FIXED: 2026-11-03 git 命令超时不再一律 60 秒
//
// 原来 _execGit 对所有命令都硬编码 60 秒：本地命令（status/diff/config）够用，
// 但网络命令（clone/fetch/pull/push）在国内直连 github.com 时 60 秒必然超时，
// 用户看到的就是「操作超时：克隆时间过长」——而 clone 已经是 --depth 1 --single-branch，
// 不是仓库太大，是跨境网络太慢。
//
// 现在按命令类型区分，且两个值都可以用环境变量覆盖（不用改代码）：
//   GIT_LOCAL_TIMEOUT_MS    默认 60000
//   GIT_NETWORK_TIMEOUT_MS  默认 120000（2 分钟）
const DEFAULT_LOCAL_TIMEOUT_MS = 60 * 1000
const DEFAULT_NETWORK_TIMEOUT_MS = 2 * 60 * 1000

// 这些子命令会走网络（remote -v 本身不走，但给长一点也不亏）
const NETWORK_GIT_COMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'remote',
  'submodule',
])

function getGitTimeoutMs(args) {
  const isNetwork = NETWORK_GIT_COMMANDS.has(args[0])
  const fallback = isNetwork
    ? DEFAULT_NETWORK_TIMEOUT_MS
    : DEFAULT_LOCAL_TIMEOUT_MS
  const configured = parseInt(
    process.env[isNetwork ? 'GIT_NETWORK_TIMEOUT_MS' : 'GIT_LOCAL_TIMEOUT_MS'],
    10
  )
  return Number.isFinite(configured) && configured > 0 ? configured : fallback
}

class GitService {
  /**
   * 获取项目的 Git 工作目录
   * 每个项目有独立的目录，完全隔离
   */
  _getProjectWorkDir(projectId) {
    return path.join(Settings.path.gitCacheDir, projectId.toString())
  }

  /**
   * 获取项目的实际工作目录（可能在 /tmp/git-cache）
   * 检查两个可能的位置并返回存在的那个
   */
  async _getActualProjectDir(projectId) {
    const defaultDir = this._getProjectWorkDir(projectId)
    const fallbackDir = path.join('/tmp', 'git-cache', projectId.toString())

    // 优先返回存在的目录
    if (await fs.pathExists(defaultDir)) {
      return defaultDir
    }
    if (await fs.pathExists(fallbackDir)) {
      return fallbackDir
    }

    // 如果都不存在，返回默认目录（用于创建新目录）
    return defaultDir
  }

  /**
   * 公共方法：获取项目的实际工作目录（可以从外部访问）
   */
  async getActualProjectDir(projectId) {
    return this._getActualProjectDir(projectId)
  }

  /**
   * 公共方法：获取 git 状态（用于调试）
   */
  async getGitStatus(projectId) {
    const workDir = await this._getActualProjectDir(projectId)
    try {
      return await this._execGit(['status', '--porcelain'], workDir)
    } catch (error) {
      return `Error: ${error.message}`
    }
  }

  /**
   * 获取操作锁（防止同一项目的并发操作）
   */
  async _acquireLock(projectId) {
    const lockKey = projectId.toString()

    // 等待现有操作完成（最多等待 30 秒）
    let attempts = 0
    const maxAttempts = 300

    while (operationLocks.has(lockKey) && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 100))
      attempts++
    }

    if (operationLocks.has(lockKey)) {
      throw new Error('Git operation is already in progress for this project')
    }

    // 设置锁
    operationLocks.set(lockKey, true)

    // 返回释放锁的函数
    return () => operationLocks.delete(lockKey)
  }

  /**
   * 执行 Git 命令（安全隔离）
   * @param {string[]} args - Git 命令参数
   * @param {string} cwd - 工作目录
   * @param {Object} env - 环境变量
   * @returns {Promise<string>} stdout
   */
  _execGit(args, cwd, env = {}) {
    return new Promise((resolve, reject) => {
      logger.debug(
        { projectId: path.basename(cwd), command: 'git ' + args.join(' ') },
        'executing git command'
      )

      const git = spawn('git', args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      git.stdout.on('data', data => {
        stdout += data.toString()
      })

      git.stderr.on('data', data => {
        stderr += data.toString()
      })

      // FIXED: 2026-11-03 按命令类型取超时（网络命令 120s，本地命令 60s）
      // OLD: 一律 60 秒，导致国内 clone/push 必超时
      const timeoutMs = getGitTimeoutMs(args)
      const timeout = setTimeout(() => {
        git.kill('SIGTERM')
        // git 可能卡在跨境网络 I/O 上不响应 SIGTERM，5 秒后补 SIGKILL，
        // 否则 git-remote-https 会把连接和句柄一直拖着
        const killer = setTimeout(() => {
          try {
            git.kill('SIGKILL')
          } catch (e) {
            // 已经退出
          }
        }, 5000)
        if (killer.unref) {
          killer.unref()
        }
        logger.err(
          { projectId: path.basename(cwd), command: args, timeoutMs },
          'git command timeout'
        )
        reject(new Error(`Git command timeout after ${timeoutMs / 1000} seconds`))
      }, timeoutMs)

      git.on('close', code => {
        clearTimeout(timeout)
        if (code === 0) {
          logger.debug(
            {
              projectId: path.basename(cwd),
              command: args,
              stdout: stdout.substring(0, 200),
            },
            'git command succeeded'
          )
          resolve(stdout.trim())
        } else {
          // 详细记录失败信息
          const errorMsg = stderr || stdout || 'Unknown error'
          const logObj = {
            projectId: path.basename(cwd),
            command: args.join(' '),
            code,
            stderr: stderr.substring(0, 500),
            stdout: stdout.substring(0, 500),
            stderrLength: stderr.length,
            stdoutLength: stdout.length,
          }

          // 如果是 push 命令，特别记录
          if (args.includes('push')) {
            logger.warn(logObj, '[GIT-PUSH-ERROR] git push command failed')
          } else {
            logger.err(logObj, 'git command failed')
          }

          // FIXED: 2026-11 完整 stderr 挂到错误对象上。
          // 原来 message 里只留 200 字，而「没有推送权限」这类原因往往在
          // 后面的 remote: 行里，截断后就只剩一句 "failed with exit code 128"。
          const error = new Error(
            `Git command failed with exit code ${code}: ${errorMsg.substring(
              0,
              200
            )}`
          )
          error.exitCode = code
          error.stderr = stderr
          error.stdout = stdout
          error.command = args.join(' ')
          reject(error)
        }
      })

      git.on('error', err => {
        clearTimeout(timeout)
        logger.err(
          { projectId: path.basename(cwd), error: err },
          'failed to start git'
        )
        reject(new Error(`Failed to start git process: ${err.message}`))
      })
    })
  }

  /**
   * 构建带认证的 Git URL
   * @param {string} url - 原始 URL
   * @param {string} token - 访问令牌
   * @returns {string} 带 OAuth 认证的 URL
   */
  _buildAuthUrl(url, token) {
    if (!token) {
      return url
    }

    try {
      const urlObj = new URL(url)
      // 使用 OAuth2 token 认证（常见 HTTPS Git 托管均适用）
      urlObj.username = 'oauth2'
      urlObj.password = token
      return urlObj.toString()
    } catch (error) {
      logger.err({ url, error }, 'failed to build auth URL')
      // URL 解析失败，尝试简单的字符串替换
      return url.replace('https://', `https://oauth2:${token}@`)
    }
  }

  /**
   * 克隆仓库到项目工作目录
   * @param {string|null} projectId - 项目 ID（可以为 null，用于新项目克隆）
   * @param {Object} gitConfig - Git 配置
   * @param {string} gitConfig.url - 仓库 URL
   * @param {string} gitConfig.branch - 分支名
   * @param {string} token - 访问令牌（可选）
   * @returns {Promise<string>} 工作目录路径
   */
  async cloneRepository(projectId, gitConfig, token) {
    // 如果没有 projectId，使用临时目录
    const tempId =
      projectId ||
      `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const releaseLock = await this._acquireLock(tempId)

    try {
      // 确定使用的工作目录
      let workDir = this._getProjectWorkDir(tempId)
      let gitCacheDir = Settings.path.gitCacheDir

      // 确保缓存目录存在，处理权限问题
      try {
        await fs.ensureDir(gitCacheDir)
      } catch (error) {
        // 如果默认目录无法创建，使用临时目录
        logger.warn(
          { error: error.message, defaultDir: gitCacheDir },
          'failed to create git cache dir, using temp dir'
        )

        // 使用系统临时目录
        gitCacheDir = path.join('/tmp', 'git-cache')
        await fs.ensureDir(gitCacheDir)

        // 重新计算工作目录
        workDir = path.join(gitCacheDir, tempId.toString())

        logger.info(
          { tempBase: gitCacheDir, workDir },
          'using temporary git cache directory'
        )
      }

      // 清理旧目录（如果存在）
      if (await fs.pathExists(workDir)) {
        logger.debug(
          { projectId: tempId, workDir },
          'removing existing git directory'
        )
        await fs.remove(workDir)
      }

      // 构建带认证的 URL
      const authUrl = this._buildAuthUrl(gitConfig.url, token)

      // 克隆仓库
      logger.debug(
        { projectId, url: gitConfig.url, branch: gitConfig.branch },
        'cloning git repository'
      )

      await this._execGit(
        [
          'clone',
          '--depth',
          '1',
          '--branch',
          gitConfig.branch || 'main',
          '--single-branch',
          authUrl,
          workDir,
        ],
        gitCacheDir
      )

      logger.info({ projectId, workDir }, 'git repository cloned successfully')

      return workDir
    } finally {
      releaseLock()
    }
  }

  /**
   * Pull 更新（项目级别，完全隔离）
   * @param {string} projectId - 项目 ID
   * @param {Object} gitConfig - Git 配置
   * @param {string} token - 访问令牌（可选）
   * @returns {Promise<Object>} 操作结果
   */
  async pullChanges(projectId, gitConfig, token, options = {}) {
    // 同 pushChanges：令牌可从配置里兜底
    token = token || (gitConfig && gitConfig.token) || null
    const strategy = options.strategy || 'default'
    const releaseLock = await this._acquireLock(projectId)

    try {
      const workDir = await this._getActualProjectDir(projectId)

      if (!(await fs.pathExists(workDir))) {
        throw new Error(
          'Project directory not found. Please clone the repository first.'
        )
      }

      logger.debug(
        { projectId, branch: gitConfig.branch },
        'pulling git repository'
      )

      // 检查是否在正确的分支上
      const currentBranch = await this._execGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        workDir
      )
      if (currentBranch !== (gitConfig.branch || 'main')) {
        // 切换分支
        await this._execGit(['checkout', gitConfig.branch || 'main'], workDir)
      }

      // Pull 更新
      // FIXED: 2026-11 私有仓库拉取也要带令牌；分叉时允许指定合并策略：
      //   default / merge → 普通 pull（可能产生合并提交）
      //   rebase          → git pull --rebase（线性历史，冲突时停在半途）
      const branch = gitConfig.branch || 'main'
      const pullArgs = ['pull']
      if (strategy === 'rebase') {
        pullArgs.push('--rebase')
      } else if (strategy === 'merge') {
        pullArgs.push('--no-rebase')
      }
      let pullUrl = 'origin'
      if (token && gitConfig.url) {
        try {
          pullUrl = this._buildAuthUrl(gitConfig.url, token)
        } catch (error) {
          logger.warn({ error }, 'failed to build auth URL for pull')
        }
      }
      pullArgs.push(pullUrl, branch)
      try {
        await this._execGit(pullArgs, workDir)
      } catch (pullErr) {
        // FIXED: 2026-11 rebase / merge 冲突会停在「半途」状态（.git/rebase-merge
        // 或 MERGE_HEAD 存在），之后的 import / push 全都会失败。
        // 这里主动回滚，保证失败后工作目录仍是用户原来的样子，
        // 冲突本身通过 reason=merge_conflict 告诉前端去解决。
        const abortArgs =
          strategy === 'rebase' ? ['rebase', '--abort'] : ['merge', '--abort']
        try {
          await this._execGit(abortArgs, workDir)
          logger.info(
            { projectId, strategy },
            'rolled back unfinished git operation after failed pull'
          )
        } catch (abortErr) {
          logger.debug(
            { projectId, error: abortErr.message },
            'nothing to roll back after failed pull'
          )
        }
        throw pullErr
      }

      // 获取最新提交信息
      const lastCommit = await this._execGit(
        ['log', '-1', '--format=%H'],
        workDir
      )
      const commitMessage = await this._execGit(
        ['log', '-1', '--format=%s'],
        workDir
      )
      const commitAuthor = await this._execGit(
        ['log', '-1', '--format=%an'],
        workDir
      )

      logger.info({ projectId, lastCommit }, 'git pull successful')

      return {
        success: true,
        lastCommit,
        commitMessage,
        commitAuthor,
      }
    } finally {
      releaseLock()
    }
  }

  /**
   * Push 更改（项目级别，完全隔离）
   * @param {string} projectId - 项目 ID
   * @param {Object} gitConfig - Git 配置
   * @param {string} token - 访问令牌（可选）
   * @param {string} commitMessage - 提交消息
   * @returns {Promise<Object>} 操作结果
   */
  async pushChanges(projectId, gitConfig, token, commitMessage) {
    // FIXED: 2026-11 令牌兜底：公开仓库 clone 时不需要令牌，用户往往是在
    // 「要 push 的时候」才第一次填令牌。前端如果没随请求带上，就用配置里
    // 保存过的那份，避免「每次推送都要重填」。
    token = token || (gitConfig && gitConfig.token) || null
    const releaseLock = await this._acquireLock(projectId)

    try {
      const workDir = await this._getActualProjectDir(projectId)

      if (!(await fs.pathExists(workDir))) {
        throw new Error(
          'Project directory not found. Please clone the repository first.'
        )
      }

      logger.debug({ projectId }, 'checking git status in push')

      // 配置 git user（如果还没配置过）
      logger.debug({ projectId }, 'configuring git user')
      try {
        await this._execGit(['config', 'user.email'], workDir)
      } catch (error) {
        // 如果还没配置，就配置默认值
        await this._execGit(['config', 'user.name', 'FlyLaTeX User'], workDir)
        await this._execGit(
          ['config', 'user.email', 'noreply@example.com'],
          workDir
        )
      }

      // 新策略：不再依赖 git status，因为编辑器会话可能导致 Git 的缓存失效
      // 直接尝试执行 git commit -am，让 Git 自己决定是否有改变
      // git commit -am 会独立地检查已跟踪文件的修改
      logger.info(
        { projectId },
        '[SESSION-FIX] skipping git status check, directly attempting git commit -am'
      )

      // 添加所有更改（多种方法）
      logger.debug({ projectId }, 'staging all changes with add -A')
      try {
        await this._execGit(['add', '-A'], workDir)
        logger.debug({ projectId }, 'git add -A succeeded')
      } catch (err) {
        logger.warn(
          { projectId, error: err.message },
          'git add -A failed, trying add .'
        )
        try {
          await this._execGit(['add', '.'], workDir)
        } catch (err2) {
          logger.warn(
            { projectId, error: err2.message },
            'git add . also failed'
          )
        }
      }

      // 直接尝试 commit -am（核心策略）
      logger.debug(
        { projectId, message: commitMessage },
        '[SESSION-FIX] attempting git commit -am'
      )
      let committed = false
      try {
        await this._execGit(
          ['commit', '-am', commitMessage || 'Update from FlyLaTeX'],
          workDir
        )
        committed = true
        logger.info({ projectId }, '[SESSION-FIX] git commit -am succeeded')
      } catch (commitErr) {
        const errMsg = commitErr.message || ''

        // 如果是 "nothing to commit" 错误，检查是否真的没有改变
        if (
          errMsg.includes('nothing to commit') ||
          errMsg.includes('no changes added') ||
          errMsg.includes('working tree clean')
        ) {
          logger.warn(
            { projectId, error: errMsg },
            '[SESSION-FIX] git reports "nothing to commit", verifying with git diff'
          )

          // 尝试用 git diff 检查是否真的有改变
          try {
            const diff = await this._execGit(['diff', 'HEAD'], workDir)
            if (!diff || !diff.trim()) {
              // FIXED: 2026-11 这里原来直接 return「No changes to commit」并带 success:true，
              // 造成两个问题：
              //   1. 上一次「提交成功但推送失败」的项目，之后再也推不上去（永远卡在这条早退路径）；
              //   2. 前端只看到 success:true，于是提示「推送成功」——用户看到的和真实结果不一致。
              // 现在不早退：先算本地是否还有未推送的提交，有就继续 push，
              // 确实没有才返回 reason='no_changes'（前端据此提示「没有需要推送的改动」）。
              logger.info(
                { projectId },
                '[SESSION-FIX] working tree clean, checking unpushed commits'
              )
              committed = false
            } else {
              logger.warn(
                { projectId },
                '[SESSION-FIX] git diff shows changes exist! Attempting to commit with --no-verify'
              )
              // Git 的文件检测失效了，但文件确实改变了
              // 尝试用 --no-verify 强制绕过 Git 的检查
              try {
                await this._execGit(
                  [
                    'commit',
                    '--allow-empty',
                    '-am',
                    commitMessage || 'Update from FlyLaTeX',
                  ],
                  workDir
                )
                committed = true
                logger.info(
                  { projectId },
                  '[SESSION-FIX] git commit --allow-empty succeeded'
                )
              } catch (err2) {
                logger.error(
                  { projectId, error: err2.message },
                  '[SESSION-FIX] even commit --allow-empty failed'
                )
                throw err2
              }
            }
          } catch (diffErr) {
            logger.warn(
              { projectId, error: diffErr.message },
              '[SESSION-FIX] failed to check git diff'
            )
            throw commitErr // 抛出原始的 commit 错误
          }
        } else {
          // 其他类型的错误，直接抛出
          throw commitErr
        }
      }

      // 准备 push 的环境变量和 URL
      const pushEnv = {}
      let pushUrl = gitConfig.url || ''

      // 如果提供了 token，构建认证 URL
      if (token && pushUrl) {
        try {
          pushUrl = this._buildAuthUrl(pushUrl, token)
        } catch (error) {
          logger.warn(
            { error },
            'failed to build auth URL, pushing without token'
          )
        }
      }

      // 推送前的最后检查
      logger.debug(
        {
          projectId,
          branch: gitConfig.branch,
          hasToken: !!token,
          urlSet: !!gitConfig.url,
        },
        '[SESSION-FIX] preparing for push'
      )

      // 验证是否真的有提交了
      try {
        const commitLog = await this._execGit(
          ['log', '-1', '--format=%H %s'],
          workDir
        )
        logger.debug(
          { projectId, lastCommit: commitLog.substring(0, 100) },
          '[SESSION-FIX] verified last commit exists'
        )
      } catch (err) {
        logger.warn(
          { projectId, error: err.message },
          '[SESSION-FIX] failed to verify last commit'
        )
      }

      // 验证仓库状态
      try {
        const gitRemote = await this._execGit(['remote', '-v'], workDir)
        logger.debug(
          { projectId, remotes: gitRemote.substring(0, 200) },
          '[SESSION-FIX] git remotes configured'
        )
      } catch (err) {
        logger.warn(
          { projectId, error: err.message },
          '[SESSION-FIX] failed to list git remotes'
        )
      }

      // 本地领先远端多少个提交（没有 upstream / 空仓库时为 0）
      const ahead = await this._countAhead(workDir)

      // 既没有新提交，也没有历史遗留的未推送提交 —— 这时才真的「无事可做」
      if (!committed && ahead === 0) {
        logger.info({ projectId }, 'nothing to commit and nothing to push')
        return {
          success: true,
          pushed: false,
          hasChanges: false,
          ahead: 0,
          reason: 'no_changes',
          message: 'No local changes to push',
        }
      }

      // 推送
      logger.info(
        { projectId, branch: gitConfig.branch, ahead },
        '[SESSION-FIX] starting git push'
      )
      let pushStdout = ''
      try {
        if (token && pushUrl) {
          // 使用认证 URL 推送
          logger.debug(
            {
              projectId,
              urlType: 'with token',
              url: pushUrl.substring(0, 100),
            },
            '[SESSION-FIX] pushing with auth token'
          )
          pushStdout = await this._execGit(
            ['push', pushUrl, gitConfig.branch || 'main'],
            workDir,
            pushEnv
          )
        } else {
          // 使用默认的 origin 推送（如果已配置了凭证）
          logger.debug(
            { projectId, urlType: 'origin', configUrl: gitConfig.url },
            '[SESSION-FIX] pushing to origin'
          )
          pushStdout = await this._execGit(
            ['push', 'origin', gitConfig.branch || 'main'],
            workDir,
            pushEnv
          )
        }
        logger.info({ projectId }, '[SESSION-FIX] git push succeeded')
      } catch (pushErr) {
        // FIXED: 2026-11 远端拒绝时不再一律当 500 抛出。
        // 最常见的是「开源仓库只读 / 不是协作者」：能拉不能推，这属于预期结果，
        // 应该把原因（permission_denied / auth_failed / branch_protected …）
        // 明确返回给前端，让用户看到「没有推送权限」而不是一句 failed。
        const classified = GitErrorUtil.classifyPushError(
          pushErr.stderr || pushErr.message
        )
        logger.warn(
          {
            projectId,
            reason: classified.reason,
            httpStatus: classified.httpStatus,
            detail: classified.detail,
          },
          'git push rejected'
        )
        return {
          success: false,
          pushed: false,
          hasChanges: committed,
          ahead,
          reason: classified.reason,
          httpStatus: classified.httpStatus,
          error: classified.detail || pushErr.message,
        }
      }

      // 获取最新提交
      const lastCommit = await this._execGit(
        ['log', '-1', '--format=%H'],
        workDir
      )
      const commitLog = await this._execGit(
        ['log', '-1', '--format=%s'],
        workDir
      )
      const pushState = GitErrorUtil.parsePushOutput(pushStdout)

      logger.info(
        {
          projectId,
          lastCommit,
          commitLog,
          pushed: pushState.pushed,
          reason: pushState.reason,
        },
        'git push finished'
      )

      return {
        success: true,
        // pushed=false 只出现在「git 说 Everything up-to-date」时，
        // 前端据此提示「远端已是最新」，不再谎报推送成功
        pushed: pushState.pushed,
        hasChanges: committed,
        ahead: 0,
        reason: pushState.reason,
        lastCommit,
        message: commitLog,
      }
    } finally {
      releaseLock()
    }
  }

  /**
   * 本地领先上游分支多少个提交
   *
   * - 空仓库（还没有任何提交）→ 0
   * - 没有配置上游分支 → 1（当作「有东西要推」，让 push 自己去报真正的错）
   * - 其他 → rev-list 的真实数字
   */
  async _countAhead(workDir) {
    const head = await this._tryGit(['rev-parse', '--verify', 'HEAD'], workDir)
    if (head === null) {
      return 0
    }
    const ahead = await this._tryGit(
      ['rev-list', '--count', '@{upstream}..HEAD'],
      workDir
    )
    if (ahead === null) {
      return 1
    }
    return Number(ahead) || 0
  }

  /**
   * 获取项目状态
   * @param {string} projectId - 项目 ID
   * @param {Object} gitConfig - Git 配置
   * @returns {Promise<Object>} 项目状态
   */
  async getProjectStatus(projectId, gitConfig) {
    const workDir = this._getProjectWorkDir(projectId)

    if (!(await fs.pathExists(workDir))) {
      return {
        synced: false,
        hasChanges: false,
      }
    }

    try {
      const lastCommit = await this._execGit(
        ['log', '-1', '--format=%H'],
        workDir
      )
      const status = await this._execGit(['status', '--porcelain'], workDir)
      const branch = await this._execGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        workDir
      )

      logger.debug(
        {
          projectId,
          workDir,
          statusOutput: status,
          statusLength: status ? status.length : 0,
          branch,
        },
        '[DEBUG] git status check in getProjectStatus'
      )

      return {
        synced: true,
        lastCommit,
        hasChanges: status.length > 0,
        currentBranch: branch,
      }
    } catch (error) {
      logger.err({ projectId, error }, 'failed to get git status')
      return {
        synced: false,
        error: error.message,
      }
    }
  }

  /**
   * 断开项目与 Git 仓库的连接
   * @param {string} projectId - 项目 ID
   * @returns {Promise<Object>} 操作结果
   */
  async disconnectProject(projectId) {
    const releaseLock = await this._acquireLock(projectId)

    try {
      const workDir = await this._getActualProjectDir(projectId)

      if (await fs.pathExists(workDir)) {
        logger.debug({ projectId, workDir }, 'removing git directory')
        await fs.remove(workDir)
      }

      logger.info({ projectId }, 'git project disconnected')

      return {
        success: true,
        message: 'Disconnected from Git repository',
      }
    } finally {
      releaseLock()
    }
  }

  /**
   * 导出项目文件到本地目录（用于 FileSystemImportManager）
   * @param {string} projectId - 项目 ID
   * @returns {Promise<string>} 本地目录路径
   */
  async exportProjectFiles(projectId) {
    const workDir = await this._getActualProjectDir(projectId)

    if (!(await fs.pathExists(workDir))) {
      throw new Error('Git project directory not found')
    }

    return workDir
  }

  /**
   * 获取项目的 Git 状态
   * @param {string} projectId - 项目 ID
   * @param {Object} gitConfig - Git 配置
   * @returns {Promise<Object>} Git 状态信息
   */
  async getProjectStatus(projectId, gitConfig) {
    const workDir = await this._getActualProjectDir(projectId)

    if (!(await fs.pathExists(workDir))) {
      throw new Error('Git project directory not found')
    }

    try {
      // 获取当前分支
      const currentBranch = await this._execGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        workDir
      )

      // 获取最新提交信息
      const lastCommit = await this._execGit(
        ['log', '-1', '--format=%H'],
        workDir
      )
      const commitMessage = await this._execGit(
        ['log', '-1', '--format=%s'],
        workDir
      )
      const commitAuthor = await this._execGit(
        ['log', '-1', '--format=%an'],
        workDir
      )
      const commitDate = await this._execGit(
        ['log', '-1', '--format=%ai'],
        workDir
      )

      // 检查是否有未提交的更改
      const statusOutput = await this._execGit(
        ['status', '--porcelain'],
        workDir
      )
      const hasChanges = statusOutput.length > 0

      // 检查是否可以 push（本地是否有领先远程的提交）
      let canPush = false
      let canPull = false
      try {
        // 获取远程分支的提交
        const remoteBranch = `origin/${gitConfig.branch || 'main'}`
        const aheadBehind = await this._execGit(
          [
            'rev-list',
            '--left-right',
            '--count',
            `${currentBranch}...${remoteBranch}`,
          ],
          workDir
        )

        const [ahead, behind] = aheadBehind.split('\t').map(Number)
        canPush = ahead > 0
        canPull = behind > 0
      } catch (error) {
        // 如果没有远程分支或无法比较，忽略错误
        logger.debug(
          { projectId, error: error.message },
          'could not compare with remote'
        )
      }

      return {
        currentBranch,
        lastCommit,
        commitMessage,
        commitAuthor,
        commitDate: new Date(commitDate),
        hasChanges,
        canPush,
        canPull,
      }
    } catch (error) {
      logger.err({ error, projectId }, 'failed to get git status')
      throw error
    }
  }

  /**
   * 移动临时克隆的仓库到正式项目目录
   * @param {string} tempProjectId - 临时项目 ID
   * @param {string} finalProjectId - 最终项目 ID
   */
  async moveRepository(tempProjectId, finalProjectId) {
    // 尝试从默认目录或 /tmp/git-cache 查找临时目录
    const tempDirDefault = this._getProjectWorkDir(tempProjectId)
    const tempDirFallback = path.join(
      '/tmp',
      'git-cache',
      tempProjectId.toString()
    )

    let tempDir = null
    for (const dir of [tempDirDefault, tempDirFallback]) {
      if (await fs.pathExists(dir)) {
        tempDir = dir
        break
      }
    }

    if (!tempDir) {
      throw new Error('Temporary git directory not found')
    }

    // 确定目标目录 - 尝试使用默认目录，如果权限不足则使用 /tmp/git-cache
    let finalDir = this._getProjectWorkDir(finalProjectId)
    let gitCacheDir = Settings.path.gitCacheDir

    // 尝试创建目标目录
    try {
      await fs.ensureDir(gitCacheDir)
    } catch (error) {
      // 如果默认目录无法创建，使用 /tmp/git-cache
      logger.warn(
        { error: error.message, defaultDir: gitCacheDir },
        'failed to create git cache dir for move, using temp dir'
      )
      gitCacheDir = path.join('/tmp', 'git-cache')
      await fs.ensureDir(gitCacheDir)
      finalDir = path.join(gitCacheDir, finalProjectId.toString())
    }

    // 如果目标目录已存在，先删除
    if (await fs.pathExists(finalDir)) {
      await fs.remove(finalDir)
    }

    // 移动目录
    await fs.move(tempDir, finalDir)
    logger.info(
      { tempProjectId, finalProjectId, finalDir },
      'git repository moved successfully'
    )
  }

  /**
   * 清理临时克隆的仓库
   * @param {string} tempProjectId - 临时项目 ID
   */
  /**
   * 执行 git 命令，失败时返回 null 而不是抛错。
   * 「仓库信息」是只读展示，任何一项取不到都不应该让整个接口 500。
   */
  async _tryGit(args, cwd) {
    try {
      const output = await this._execGit(args, cwd)
      return typeof output === 'string' ? output : ''
    } catch (error) {
      logger.debug(
        { cwd, args, error: error.message },
        'git info: command failed, continue with partial info'
      )
      return null
    }
  }

  /**
   * 汇总一个项目的 Git 仓库信息（供「信息」弹窗展示）
   *
   * 全部字段都是「尽力而为」：仓库目录不存在、仓库是空仓库、远端不可达……
   * 都只让对应字段为空，不抛错。
   *
   * @param {string} projectId
   * @param {Object} gitConfig
   * @param {{fetch?: boolean}} options - fetch: 顺带 git fetch 一下，刷新 ahead/behind
   * @returns {Promise<Object>}
   */
  async getRepositoryInfo(projectId, gitConfig, options = {}) {
    const workDir = await this._getActualProjectDir(projectId)
    const warnings = []
    const repoDirExists = await fs.pathExists(workDir)

    const info = {
      available: repoDirExists,
      remote: {
        // 注意：这里只给脱敏结果，明文地址（可能含 token）不出服务端
        url: '',
        maskedUrl: '',
        webUrl: '',
        host: '',
        path: '',
        protocol: '',
        provider: 'other',
        hasCredentials: false,
        credentialMask: null,
        username: null,
      },
      branch: {
        current: gitConfig.branch || '',
        tracking: '',
        trackingExists: false,
      },
      sync: {
        ahead: 0,
        behind: 0,
        canPush: false,
        canPull: false,
        diverged: false,
      },
      changes: {
        total: 0,
        modified: 0,
        untracked: 0,
        staged: 0,
        deleted: 0,
        files: [],
      },
      head: null,
      commits: [],
      totalCommits: 0,
      lastFetchAt: null,
      checkedAt: new Date().toISOString(),
      fetch: {
        attempted: false,
        ok: false,
        error: null,
      },
      warnings,
    }

    if (!repoDirExists) {
      warnings.push('repository_directory_missing')
      return info
    }

    // ---- 远端地址（脱敏）----
    const remoteUrl = await this._tryGit(
      ['remote', 'get-url', 'origin'],
      workDir
    )
    if (remoteUrl) {
      const parsed = GitUrlUtil.parseGitRemote(remoteUrl)
      info.remote = {
        url: parsed.maskedUrl,
        maskedUrl: parsed.maskedUrl,
        webUrl: parsed.webUrl,
        host: parsed.host,
        path: parsed.path,
        protocol: parsed.protocol,
        provider: parsed.provider,
        hasCredentials: parsed.hasCredentials,
        credentialMask: parsed.credentialMask,
        username: parsed.username,
      }
    } else {
      info.remote.url = gitConfig.url || ''
      info.remote.maskedUrl = GitUrlUtil.maskCredentialsByRegex(
        gitConfig.url || ''
      )
      const parsedConfigUrl = GitUrlUtil.parseGitRemote(gitConfig.url || '')
      info.remote.webUrl = parsedConfigUrl.webUrl
      info.remote.host = parsedConfigUrl.host
      info.remote.path = parsedConfigUrl.path
      info.remote.protocol = parsedConfigUrl.protocol
      info.remote.provider = parsedConfigUrl.provider
      // 本地没有 origin 时也要把「配置里是否带凭据」报出来，
      // 否则弹窗会误显示「没有保存访问令牌」
      info.remote.hasCredentials = parsedConfigUrl.hasCredentials
      info.remote.credentialMask = parsedConfigUrl.credentialMask
      info.remote.username = parsedConfigUrl.username
      // 地址里没有凭据、但配置里保存了令牌时，也要显示成「有授权」，
      // 否则刚保存完令牌，弹窗又说「没有访问令牌」，用户会以为没存上。
      if (!parsedConfigUrl.hasCredentials && gitConfig.token) {
        info.remote.hasCredentials = true
        info.remote.credentialMask = GitUrlUtil.maskSecret(gitConfig.token)
        info.remote.credentialSource = 'stored'
      }
      warnings.push('remote_url_unavailable')
    }

    // ---- 当前分支与跟踪分支 ----
    const currentBranch = await this._tryGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      workDir
    )
    if (currentBranch) {
      info.branch.current = currentBranch
    }

    const tracking = await this._tryGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      workDir
    )
    if (tracking) {
      info.branch.tracking = tracking
      info.branch.trackingExists = true
    } else {
      warnings.push('no_upstream_branch')
    }

    // ---- 可选：真正去远端拿一次引用 ----
    if (options.fetch) {
      info.fetch.attempted = true
      const branchToFetch = info.branch.current || gitConfig.branch || 'main'
      const fetchResult = await this._tryGit(
        ['fetch', '--prune', '--quiet', 'origin', branchToFetch],
        workDir
      )
      if (fetchResult === null) {
        info.fetch.error = 'fetch_failed'
        warnings.push('fetch_failed')
      } else {
        info.fetch.ok = true
        info.lastFetchAt = new Date().toISOString()
      }
    }

    // ---- ahead / behind ----
    const aheadBehind = await this._tryGit(
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      workDir
    )
    if (aheadBehind) {
      const [aheadRaw, behindRaw] = aheadBehind.split(/\s+/)
      info.sync.ahead = Number(aheadRaw) || 0
      info.sync.behind = Number(behindRaw) || 0
    } else if (info.branch.trackingExists) {
      warnings.push('ahead_behind_unavailable')
    }

    // ---- 本地改动 ----
    const porcelain = await this._tryGit(['status', '--porcelain'], workDir)
    if (porcelain !== null) {
      const parsedStatus = GitUrlUtil.parseGitStatus(porcelain)
      info.changes = {
        ...parsedStatus,
        // 只回前 40 个文件，避免大仓库把响应撑爆
        files: parsedStatus.files.slice(0, 40),
      }
    }

    // ---- 提交历史 ----
    const logOutput = await this._tryGit(
      [
        'log',
        '-n',
        '10',
        `--format=${GitUrlUtil.LOG_FORMAT}`,
        '--no-show-signature',
      ],
      workDir
    )
    if (logOutput) {
      info.commits = GitUrlUtil.parseGitLog(logOutput, 10)
      info.head = info.commits[0] || null
    } else {
      warnings.push('empty_repository')
    }

    const totalCommits = await this._tryGit(
      ['rev-list', '--count', 'HEAD'],
      workDir
    )
    info.totalCommits = Number(totalCommits) || info.commits.length

    // ---- 上次检查远端的时间（.git/FETCH_HEAD 的 mtime）----
    try {
      const fetchHeadPath = path.join(workDir, '.git', 'FETCH_HEAD')
      if (await fs.pathExists(fetchHeadPath)) {
        const stat = await fs.stat(fetchHeadPath)
        info.lastFetchAt = stat.mtime.toISOString()
      }
    } catch (error) {
      logger.debug(
        { projectId, error: error.message },
        'git info: could not read FETCH_HEAD'
      )
    }

    // ---- 结论 ----
    info.sync.diverged = info.sync.ahead > 0 && info.sync.behind > 0
    info.sync.canPush = info.sync.ahead > 0
    info.sync.canPull = info.sync.behind > 0
    info.sync.upToDate =
      info.branch.trackingExists &&
      info.sync.ahead === 0 &&
      info.sync.behind === 0

    return info
  }

  async cleanupRepository(tempProjectId) {
    // 尝试清理默认目录
    const tempDir = this._getProjectWorkDir(tempProjectId)

    // 同时尝试清理 /tmp/git-cache 目录（如果使用了备用目录）
    const tempDirFallback = path.join(
      '/tmp',
      'git-cache',
      tempProjectId.toString()
    )

    for (const dir of [tempDir, tempDirFallback]) {
      if (await fs.pathExists(dir)) {
        await fs.remove(dir)
        logger.debug(
          { tempProjectId, dir },
          'temporary git repository cleaned up'
        )
      }
    }
  }
}

module.exports = new GitService()
