/* eslint-disable
    n/handle-callback-err,
    max-len,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let ChatApiHandler
const OError = require('@overleaf/o-error')
const request = require('request')
const settings = require('@overleaf/settings')
const { promisify } = require('util')

function getThreads(projectId, callback) {
  if (callback == null) {
    callback = function () {}
  }
  return ChatApiHandler._apiRequest(
    {
      url: `${settings.apis.chat.internal_url}/project/${projectId}/threads`,
      method: 'GET',
      json: true,
    },
    callback
  )
}

function destroyProject(projectId, callback) {
  if (callback == null) {
    callback = function () {}
  }
  return ChatApiHandler._apiRequest(
    {
      url: `${settings.apis.chat.internal_url}/project/${projectId}`,
      method: 'DELETE',
    },
    callback
  )
}

module.exports = ChatApiHandler = {
  _apiRequest(opts, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return request(opts, function (error, response, data) {
      if (error != null) {
        return callback(error)
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return callback(null, data)
      } else {
        error = new OError(
          `chat api returned non-success code: ${response.statusCode}`,
          opts
        )
        error.statusCode = response.statusCode
        return callback(error)
      }
    })
  },

  sendGlobalMessage(projectId, userId, content, callback) {
    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/messages`,
        method: 'POST',
        json: { user_id: userId, content },
      },
      callback
    )
  },

  getGlobalMessages(projectId, limit, before, callback) {
    const qs = {}
    if (limit != null) {
      qs.limit = limit
    }
    if (before != null) {
      qs.before = before
    }

    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/messages`,
        method: 'GET',
        qs,
        json: true,
      },
      callback
    )
  },

  sendComment(projectId, threadId, userId, content, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/thread/${threadId}/messages`,
        method: 'POST',
        json: { user_id: userId, content },
      },
      callback
    )
  },

  resolveThread(projectId, threadId, userId, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/thread/${threadId}/resolve`,
        method: 'POST',
        json: { user_id: userId },
      },
      callback
    )
  },

  reopenThread(projectId, threadId, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/thread/${threadId}/reopen`,
        method: 'POST',
      },
      callback
    )
  },

  deleteThread(projectId, threadId, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/thread/${threadId}`,
        method: 'DELETE',
      },
      callback
    )
  },

  editMessage(projectId, threadId, messageId, userId, content, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/thread/${threadId}/messages/${messageId}/edit`,
        method: 'POST',
        json: {
          content,
          userId,
        },
      },
      callback
    )
  },

  deleteMessage(projectId, threadId, messageId, callback) {
    if (callback == null) {
      callback = function () {}
    }
    return ChatApiHandler._apiRequest(
      {
        url: `${settings.apis.chat.internal_url}/project/${projectId}/thread/${threadId}/messages/${messageId}`,
        method: 'DELETE',
      },
      callback
    )
  },

  getThreads,
  destroyProject,

  promises: {
    getThreads: promisify(getThreads),
    destroyProject: promisify(destroyProject),
  },
}

// FIXED: 2026-11-13 审阅面板（批注）需要这几个方法的 promise 版本。
// 注意：必须写在这里（对象字面量之后）——上面是 `module.exports = ChatApiHandler = {…}`，
// 在字面量内部引用 ChatApiHandler.xxx 时变量还没赋值，会拿到 undefined。
Object.assign(ChatApiHandler.promises, {
  sendComment: promisify(ChatApiHandler.sendComment),
  editMessage: promisify(ChatApiHandler.editMessage),
  deleteMessage: promisify(ChatApiHandler.deleteMessage),
  resolveThread: promisify(ChatApiHandler.resolveThread),
  reopenThread: promisify(ChatApiHandler.reopenThread),
  deleteThread: promisify(ChatApiHandler.deleteThread),
})
