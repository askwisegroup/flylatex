const { NotAuthorizedError } = require('./Errors')

let AuthorizationManager
module.exports = AuthorizationManager = {
  assertClientCanViewProject(client, callback) {
    // FIXED: 2026-11 加入 'review'：评审者能进项目（看 + 评论），否则 websocket 直接 NotAuthorized，
    // 用户在界面上会表现为「打开项目就断线」。
    // 注意 edit 名单不包含 review —— 评审者不能直接改稿。
    AuthorizationManager._assertClientHasPrivilegeLevel(
      client,
      ['readOnly', 'review', 'readAndWrite', 'owner'],
      callback
    )
  },

  assertClientCanEditProject(client, callback) {
    AuthorizationManager._assertClientHasPrivilegeLevel(
      client,
      ['readAndWrite', 'owner'],
      callback
    )
  },

  _assertClientHasPrivilegeLevel(client, allowedLevels, callback) {
    if (allowedLevels.includes(client.ol_context.privilege_level)) {
      callback(null)
    } else {
      callback(new NotAuthorizedError())
    }
  },

  assertClientCanViewProjectAndDoc(client, docId, callback) {
    AuthorizationManager.assertClientCanViewProject(client, function (error) {
      if (error) {
        return callback(error)
      }
      AuthorizationManager._assertClientCanAccessDoc(client, docId, callback)
    })
  },

  assertClientCanEditProjectAndDoc(client, docId, callback) {
    AuthorizationManager.assertClientCanEditProject(client, function (error) {
      if (error) {
        return callback(error)
      }
      AuthorizationManager._assertClientCanAccessDoc(client, docId, callback)
    })
  },

  _assertClientCanAccessDoc(client, docId, callback) {
    if (client.ol_context[`doc:${docId}`] === 'allowed') {
      callback(null)
    } else {
      callback(new NotAuthorizedError())
    }
  },

  addAccessToDoc(client, docId, callback) {
    client.ol_context[`doc:${docId}`] = 'allowed'
    callback(null)
  },

  removeAccessToDoc(client, docId, callback) {
    delete client.ol_context[`doc:${docId}`]
    callback(null)
  },
}
