import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tag } from '../../../../../app/src/Features/Tags/types'
import {
  deleteJSON,
  getJSON,
  postJSON,
} from '../../../infrastructure/fetch-json'
import { getTagColor } from '../../project-list/util/tag'
import { debugConsole } from '@/utils/debugging'
import getMeta from '../../../utils/meta'

/**
 * 编辑器里的「本项目的标签」状态。
 *
 * FIXED: 2026-11 需求：进了项目就想看到 / 改标签，不想每次都回项目列表。
 *
 * 为什么要一个 hook 而不是直接用 project-list 的 context：
 *   project-list 的 project-list-context 绑在列表页（选中态、排序、多选…），
 *   编辑器里没有那一套；这里只做「这个项目的标签 + 增删」四件事，
 *   接口沿用 /tag 系列（和列表页完全同一套后端）。
 *
 * 端点是精简的，不需要新路由：
 *   GET    /tag                        该用户的全部标签（含 project_ids）
 *   POST   /tag                        {name} 新建
 *   POST   /tag/:tagId/projects        {projectIds:[pid]} 打标签
 *   DELETE /tag/:tagId/project/:pid    去标签
 * 走 infrastructure/fetch-json，所以 CSRF token / cookie 自动带上。
 */

export type ProjectTagsState = {
  /** 全部标签（用户维度） */
  allTags: Tag[]
  /** 只属于当前项目的标签 */
  projectTags: Tag[]
  loading: boolean
  error: string | null
  /** 有登录用户才有标签（匿名只读分享链接下没有） */
  canEdit: boolean
  /** 判断某个标签是否已打在当前项目上 */
  hasTag: (tagId: string) => boolean
  addTag: (tagId: string) => Promise<void>
  removeTag: (tagId: string) => Promise<void>
  createAndAddTag: (name: string) => Promise<void>
  reload: () => Promise<void>
  getTagColor: (tag: Tag) => string | undefined
}

export function useProjectTags(projectId?: string): ProjectTagsState {
  // 匿名（只读分享链接）没有自己的标签，别去打一个必然被踢到登录页的请求
  const userId = getMeta('ol-user_id')
  const canEdit = Boolean(userId)
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 组件卸载后不再 setState（切换项目时请求可能还在路上）
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const tags = (await getJSON('/tag')) as Tag[]
      if (mountedRef.current) {
        setAllTags(Array.isArray(tags) ? tags : [])
      }
    } catch (err: any) {
      debugConsole.error('加载标签失败', err)
      if (mountedRef.current) {
        setError(err?.message || 'load_failed')
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (projectId && canEdit) {
      reload()
    }
  }, [projectId, canEdit, reload])

  const projectTags = useMemo(
    () =>
      (allTags || []).filter(tag =>
        Array.isArray(tag.project_ids)
          ? tag.project_ids.includes(projectId || '')
          : false
      ),
    [allTags, projectId]
  )

  const hasTag = useCallback(
    (tagId: string) => projectTags.some(tag => tag._id === tagId),
    [projectTags]
  )

  /** 本地乐观更新一个 tag 的 project_ids，避免整表重拉 */
  const patchTag = useCallback(
    (tagId: string, add: boolean) => {
      setAllTags(prev =>
        prev.map(tag => {
          if (tag._id !== tagId) return tag
          const ids = new Set(tag.project_ids || [])
          if (add) ids.add(projectId || '')
          else ids.delete(projectId || '')
          return { ...tag, project_ids: Array.from(ids) }
        })
      )
    },
    [projectId]
  )

  const addTag = useCallback(
    async (tagId: string) => {
      if (!projectId) return
      patchTag(tagId, true)
      try {
        await postJSON(`/tag/${tagId}/projects`, {
          body: { projectIds: [projectId] },
        })
      } catch (err: any) {
        // 失败回滚，别让界面和服务端说法不一致
        patchTag(tagId, false)
        setError(err?.message || 'add_failed')
        throw err
      }
    },
    [projectId, patchTag]
  )

  const removeTag = useCallback(
    async (tagId: string) => {
      if (!projectId) return
      patchTag(tagId, false)
      try {
        await deleteJSON(`/tag/${tagId}/project/${projectId}`)
      } catch (err: any) {
        patchTag(tagId, true)
        setError(err?.message || 'remove_failed')
        throw err
      }
    },
    [projectId, patchTag]
  )

  const createAndAddTag = useCallback(
    async (name: string) => {
      const trimmed = (name || '').trim()
      if (!trimmed) return
      const tag = (await postJSON('/tag', {
        body: { name: trimmed },
      })) as Tag
      if (mountedRef.current) {
        setAllTags(prev => [...prev, { ...tag, project_ids: [] }])
      }
      await addTag(tag._id)
    },
    [addTag]
  )

  return {
    allTags,
    projectTags,
    loading,
    error,
    canEdit,
    hasTag,
    addTag,
    removeTag,
    createAndAddTag,
    reload,
    getTagColor,
  }
}
