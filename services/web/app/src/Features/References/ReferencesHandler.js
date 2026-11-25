/* eslint-disable
    n/handle-callback-err,
    max-len,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS103: Rewrite code to no longer use __guard__
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let ReferencesHandler
const OError = require('@overleaf/o-error')
const logger = require('@overleaf/logger')
const request = require('request')
const settings = require('@overleaf/settings')
const Features = require('../../infrastructure/Features')
const ProjectGetter = require('../Project/ProjectGetter')
const UserGetter = require('../User/UserGetter')
const DocumentUpdaterHandler = require('../DocumentUpdater/DocumentUpdaterHandler')
const _ = require('underscore')
const Async = require('async')
const Errors = require('../Errors/Errors')

if (!Features.hasFeature('references')) {
  logger.debug('references search not enabled')
}

// FIXED: 2026-11-14 本地 .bib 索引（\cite 键补全）。
// 背景：\cite 补全的前端链路是完整的（ide/references/ReferencesManager.js →
// POST /references/indexAll → use-codemirror-scope.ts 的 metadataRef.references →
// languages/latex/complete.ts 的 bibKeyArgumentCompletionSource），但真正抽取
// .bib key 的逻辑在上游是一个独立的 references 微服务里，靠
// Settings.apis.references.url 判断可用性（Features.hasFeature('references')）。
// 我们的部署里没有这个服务，于是 indexAll 恒返回 {keys: []}，用户输入 \cite{
// 一条建议都没有 —— 属于「上游留了接口、下游没接」的半成品。
// 这里补一个本地索引兜底：读 .bib 文本，用正则抽 key。
// 正则与 DesktopSync/DesktopSyncCitations.js 的 extractBibKeys 保持一致，
// 避免同一个项目里出现两套 .bib 解析规则。
const BIB_ENTRY_KEY_RE = /@\w+\s*\{\s*([^,\s}]+)\s*,/g
// 兼容 references.BIB 这种大写后缀（上游只认小写）
const BIB_FILE_NAME_RE = /\.bib$/i

module.exports = ReferencesHandler = {
  _buildDocUrl(projectId, docId) {
    return `${settings.apis.docstore.url}/project/${projectId}/doc/${docId}/raw`
  },

  _buildFileUrl(projectId, fileId) {
    return `${settings.apis.filestore.url}/project/${projectId}/file/${fileId}`
  },

  _findBibFileIds(project) {
    const ids = []
    function _process(folder) {
      _.each(folder.fileRefs || [], function (file) {
        if (
          __guard__(file != null ? file.name : undefined, x1 =>
            x1.match(BIB_FILE_NAME_RE)
          )
        ) {
          return ids.push(file._id)
        }
      })
      return _.each(folder.folders || [], folder => _process(folder))
    }
    _.each(project.rootFolder || [], rootFolder => _process(rootFolder))
    return ids
  },

  _findBibDocIds(project) {
    const ids = []
    function _process(folder) {
      _.each(folder.docs || [], function (doc) {
        if (
          __guard__(doc != null ? doc.name : undefined, x1 =>
            x1.match(BIB_FILE_NAME_RE)
          )
        ) {
          return ids.push(doc._id)
        }
      })
      return _.each(folder.folders || [], folder => _process(folder))
    }
    _.each(project.rootFolder || [], rootFolder => _process(rootFolder))
    return ids
  },

  /**
   * 从一段 .bib 文本里抽条目 key（@article{key, 形式）。
   * 与 DesktopSyncCitations.extractBibKeys 同一套正则。
   */
  _extractKeysFromBibText(text) {
    const keys = []
    if (!text) {
      return keys
    }
    // 正则带 g，复用前必须重置 lastIndex，否则第二次调用会漏前半段
    const re = new RegExp(BIB_ENTRY_KEY_RE.source, 'g')
    let match
    while ((match = re.exec(text)) !== null) {
      const key = (match[1] || '').trim()
      if (key && keys.indexOf(key) === -1) {
        keys.push(key)
      }
    }
    return keys
  },

  /**
   * 取 .bib 文本。docstore/filestore 里的单个文件读失败不应让整个索引 500，
   * 所以出错只记日志并当作空内容处理。
   */
  _fetchBibText(url, callback) {
    return request.get({ url, timeout: 15000 }, function (err, res, body) {
      if (err) {
        logger.warn({ url, err }, 'failed to fetch bib file for local index')
        return callback(null, '')
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        logger.warn(
          { url, statusCode: res.statusCode },
          'non-success status fetching bib file for local index'
        )
        return callback(null, '')
      }
      return callback(null, typeof body === 'string' ? body : '')
    })
  },

  /**
   * 本地索引：把项目里所有 .bib 文件读出来抽 key，替代缺失的 references 微服务。
   * 先把编辑器里的内容 flush 到 mongo/docstore，否则刚编辑完的条目读不到。
   */
  _indexLocally(projectId, docIds, fileIds, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return Async.eachSeries(
      docIds,
      (docId, done) =>
        DocumentUpdaterHandler.flushDocToMongo(projectId, docId, function (
          err
        ) {
          if (err) {
            logger.warn(
              { projectId, docId, err },
              'failed to flush bib doc before local index'
            )
          }
          return done()
        }),
      function () {
        const urls = docIds
          .map(docId => ReferencesHandler._buildDocUrl(projectId, docId))
          .concat(
            fileIds.map(fileId =>
              ReferencesHandler._buildFileUrl(projectId, fileId)
            )
          )
        // 限并发读，避免 bib 文件很多时排队等待（串行 N 个文件 × 超时会把
        // /references/indexAll 拖慢到用户能感知的程度）
        return Async.mapLimit(
          urls,
          5,
          (url, cb) => ReferencesHandler._fetchBibText(url, cb),
          function (err, texts) {
            if (err) {
              OError.tag(err, 'error reading bib files for local index', {
                projectId,
              })
              return callback(err)
            }
            const keys = []
            for (const text of texts || []) {
              for (const key of ReferencesHandler._extractKeysFromBibText(
                text
              )) {
                if (keys.indexOf(key) === -1) {
                  keys.push(key)
                }
              }
            }
            logger.debug(
              { projectId, count: keys.length },
              'indexed bib keys locally'
            )
            return callback(null, { keys })
          }
        )
      }
    )
  },

  _isFullIndex(project, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return UserGetter.getUser(
      project.owner_ref,
      { features: true },
      function (err, owner) {
        if (err != null) {
          return callback(err)
        }
        const features = owner != null ? owner.features : undefined
        return callback(
          null,
          (features != null ? features.references : undefined) === true ||
            (features != null ? features.referencesSearch : undefined) === true
        )
      }
    )
  },

  indexAll(projectId, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return ProjectGetter.getProject(
      projectId,
      { rootFolder: true, owner_ref: 1 },
      function (err, project) {
        if (err) {
          OError.tag(err, 'error finding project', {
            projectId,
          })
          return callback(err)
        }
        if (!project) {
          return callback(
            new Errors.NotFoundError(`project does not exist: ${projectId}`)
          )
        }
        logger.debug({ projectId }, 'indexing all bib files in project')
        const docIds = ReferencesHandler._findBibDocIds(project)
        const fileIds = ReferencesHandler._findBibFileIds(project)
        return ReferencesHandler._doIndexOperation(
          projectId,
          project,
          docIds,
          fileIds,
          callback
        )
      }
    )
  },

  _doIndexOperation(projectId, project, docIds, fileIds, callback) {
    // FIXED: 2026-11-14 没有 references 微服务时走本地索引，而不是直接返回空
    // OLD: if (!Features.hasFeature('references')) { return callback() }
    if (!Features.hasFeature('references')) {
      return ReferencesHandler._indexLocally(
        projectId,
        docIds,
        fileIds,
        callback
      )
    }
    return ReferencesHandler._isFullIndex(project, function (err, isFullIndex) {
      if (err) {
        OError.tag(err, 'error checking whether to do full index', {
          projectId,
        })
        return callback(err)
      }
      logger.debug(
        { projectId, docIds },
        'flushing docs to mongo before calling references service'
      )
      return Async.series(
        docIds.map(
          docId => cb =>
            DocumentUpdaterHandler.flushDocToMongo(projectId, docId, cb)
        ),
        function (err) {
          // continue
          if (err) {
            OError.tag(err, 'error flushing docs to mongo', {
              projectId,
              docIds,
            })
            return callback(err)
          }
          const bibDocUrls = docIds.map(docId =>
            ReferencesHandler._buildDocUrl(projectId, docId)
          )
          const bibFileUrls = fileIds.map(fileId =>
            ReferencesHandler._buildFileUrl(projectId, fileId)
          )
          const allUrls = bibDocUrls.concat(bibFileUrls)
          return request.post(
            {
              url: `${settings.apis.references.url}/project/${projectId}/index`,
              json: {
                docUrls: allUrls,
                fullIndex: isFullIndex,
              },
            },
            function (err, res, data) {
              if (err) {
                OError.tag(err, 'error communicating with references api', {
                  projectId,
                })
                return callback(err)
              }
              if (res.statusCode >= 200 && res.statusCode < 300) {
                logger.debug({ projectId }, 'got keys from references api')
                return callback(null, data)
              } else {
                err = new Error(
                  `references api responded with non-success code: ${res.statusCode}`
                )
                return callback(err)
              }
            }
          )
        }
      )
    })
  },
}

function __guard__(value, transform) {
  return typeof value !== 'undefined' && value !== null
    ? transform(value)
    : undefined
}
