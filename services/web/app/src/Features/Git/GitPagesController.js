const Settings = require('@overleaf/settings')

module.exports = {
  // Git 导入页面
  gitImportPage(req, res) {
    res.render('project/git-import', {
      title: 'git_import_from_repository',
    })
  },
}
