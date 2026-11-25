/* eslint-disable
    no-return-assign,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let PermissionsManager

export default PermissionsManager = class PermissionsManager {
  constructor(ide, $scope) {
    this.ide = ide
    this.$scope = $scope
    this.$scope.permissions = {
      read: false,
      write: false,
      admin: false,
      comment: false,
    }
    this.$scope.$watch('permissionsLevel', permissionsLevel => {
      if (permissionsLevel != null) {
        if (permissionsLevel === 'review') {
          // FIXED: 2026-11 评审者：可读 + 可评论，不可编辑
          this.$scope.permissions.read = true
          this.$scope.permissions.write = false
          this.$scope.permissions.admin = false
          this.$scope.permissions.comment = true
        } else if (permissionsLevel === 'readOnly') {
          this.$scope.permissions.read = true
          this.$scope.permissions.write = false
          this.$scope.permissions.admin = false
          // FIXED: 2026-11 只读不再能评论
          // OLD: this.$scope.permissions.comment = true
          // 原因：「只看」和「可评论」以前是同一档，引入 review 后拆开：
          // 想看讨论并在行内批注的人应被授予「可评论」，而不是「只读」。
          // 服务端与之保持一致（AuthorizationMiddleware.ensureUserCanCommentOnProject）。
          this.$scope.permissions.comment = false
        } else if (permissionsLevel === 'readAndWrite') {
          this.$scope.permissions.read = true
          this.$scope.permissions.write = true
          this.$scope.permissions.comment = true
        } else if (permissionsLevel === 'owner') {
          this.$scope.permissions.read = true
          this.$scope.permissions.write = true
          this.$scope.permissions.admin = true
          this.$scope.permissions.comment = true
        }
      }

      if (this.$scope.anonymous) {
        return (this.$scope.permissions.comment = false)
      }
    })
  }
}
