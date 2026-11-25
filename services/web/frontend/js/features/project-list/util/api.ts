import { Tag } from '../../../../../app/src/Features/Tags/types'
import {
  GetProjectsResponseBody,
  Sort,
} from '../../../../../types/project/dashboard/api'
import { deleteJSON, postJSON } from '../../../infrastructure/fetch-json'

export function getProjects(sortBy: Sort): Promise<GetProjectsResponseBody> {
  return postJSON('/api/project', { body: { sort: sortBy } })
}

// FIXED: 2026-11-14 取消链接分享（「您共享的」批量操作）。
// FIXED: 2026-11-15 不再走后端新加的批量接口，改为复用已有的项目设置端点 ——
// `publicAccessLevel: 'private'` 与分享弹窗里关闭「链接分享」开关走的是同一条
// 路径（ProjectController.updateProjectAdminSettings → ProjectDetailsHandler
// .setPublicAccessLevel），它会清空 tokens、把状态改回 private 并写审计日志。
// 批量即逐个调用，数量在列表一页之内，不值得为此新增一套后端接口。
export function revokeSharing(projectIds: string[]) {
  return Promise.all(
    projectIds.map(projectId =>
      postJSON(`/project/${projectId}/settings/admin`, {
        body: { publicAccessLevel: 'private' },
      })
    )
  ).then(() => undefined)
}

export function createTag(name: string, color?: string): Promise<Tag> {
  return postJSON(`/tag`, {
    body: { name, color },
  })
}

export function editTag(
  tagId: string,
  newTagName: string,
  newTagColor?: string
) {
  return postJSON(`/tag/${tagId}/edit`, {
    body: { name: newTagName, color: newTagColor },
  })
}

export function deleteTag(tagId: string) {
  return deleteJSON(`/tag/${tagId}`)
}

export function addProjectsToTag(tagId: string, projectIds: string[]) {
  return postJSON(`/tag/${tagId}/projects`, {
    body: {
      projectIds,
    },
  })
}

export function removeProjectFromTag(tagId: string, projectId: string) {
  return deleteJSON(`/tag/${tagId}/project/${projectId}`)
}

export function removeProjectsFromTag(tagId: string, projectIds: string[]) {
  return deleteJSON(`/tag/${tagId}/projects`, {
    body: {
      projectIds,
    },
  })
}

export function archiveProject(projectId: string) {
  return postJSON(`/project/${projectId}/archive`)
}

export function deleteProject(projectId: string) {
  return deleteJSON(`/project/${projectId}`)
}

export function leaveProject(projectId: string) {
  return postJSON(`/project/${projectId}/leave`)
}

export function renameProject(projectId: string, newName: string) {
  return postJSON(`/project/${projectId}/rename`, {
    body: {
      newProjectName: newName,
    },
  })
}

export function trashProject(projectId: string) {
  return postJSON(`/project/${projectId}/trash`)
}

export function unarchiveProject(projectId: string) {
  return deleteJSON(`/project/${projectId}/archive`)
}

export function untrashProject(projectId: string) {
  return deleteJSON(`/project/${projectId}/trash`)
}
