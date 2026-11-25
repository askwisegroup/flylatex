const ProjectGetter = require('../Project/ProjectGetter')
const Errors = require('../Errors/Errors')

function toMillis(date) {
  return date ? new Date(date).getTime() : 0
}

// 项目级时间戳口径：采用 project.lastUpdated（见设计文档第 6 节）。
// 列表 / 下载 / 上传共用此函数，保证口径一致。
async function getProjectLastModified(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    name: true,
    lastUpdated: true,
  })
  if (!project) {
    throw new Errors.NotFoundError('project not found')
  }
  return {
    name: project.name,
    lastModified: toMillis(project.lastUpdated),
  }
}

module.exports = { getProjectLastModified, toMillis }
