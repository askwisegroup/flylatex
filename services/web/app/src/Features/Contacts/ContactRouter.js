const SessionManager = require('../Authentication/SessionManager')
const ContactController = require('./ContactController')

// FIXED: 2026-11-14 不再看 Settings.allowAnonymousReadAndWriteSharing。
// 那个值由「环境变量 + 部署档位」决定，线上出现过同一个对象里定义两次、
// 后者覆盖前者导致「明明改了还是 false」的事故；链接分享能不能用不该由它决定。
// OLD: if (!Settings.allowAnonymousReadAndWriteSharing) { return requireLogin() }
// 现在固定走匿名分支：未登录访客返回空联系人即可（可编辑分享链接需要它不弹登录）。
function contactsAuthenticationMiddleware() {
  return (req, res, next) => {
    if (SessionManager.isUserLoggedIn(req.session)) {
      next()
    } else {
      res.json({ contacts: [] })
    }
  }
}

module.exports = {
  apply(webRouter) {
    webRouter.get(
      '/user/contacts',
      contactsAuthenticationMiddleware(),
      ContactController.getContacts
    )
  },
}
