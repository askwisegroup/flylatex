/* eslint-disable
    max-len,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const HomeController = require('./HomeController')
const UniversityController = require('./UniversityController')

module.exports = {
  apply(webRouter) {
    webRouter.get('/', HomeController.index)
    webRouter.get('/home', HomeController.home)

    webRouter.get(
      '/planned_maintenance',
      HomeController.externalPage('planned_maintenance', 'Planned Maintenance')
    )

    webRouter.get(
      '/track-changes-and-comments-in-latex',
      HomeController.externalPage('review-features-page', 'Review features')
    )

    webRouter.get(
      '/dropbox',
      HomeController.externalPage('dropbox', 'Dropbox and ShareLaTeX')
    )

    // FIXED: 2026-11-06 新增中文帮助中心。原先编译超时、日志提示里的帮助链接
    //   全部指向 overleaf.com（竞品），翻译整理后落到本站的 /help 页面。
    webRouter.get('/help', (req, res) =>
      res.render('general/help', { title: '帮助中心' })
    )

    webRouter.get('/university', UniversityController.getIndexPage)
    return webRouter.get('/university/*', UniversityController.getPage)
  },
}
