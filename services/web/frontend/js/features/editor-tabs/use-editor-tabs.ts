import { useEffect, useState } from 'react'
import getMeta from '@/utils/meta'
import { useFileTreeData } from '@/shared/context/file-tree-data-context'
import { findDocEntityById } from '@/features/ide-react/util/find-doc-entity-by-id'
import {
  getTabs,
  initEditorTabs,
  openTab,
  pruneTabs,
  subscribeTabs,
} from './editor-tabs-store'
import type { EditorTab } from './editor-tabs-store'

type DisplayTab = EditorTab & { path?: string }

/**
 * FIXED: 2026-11-16 页签的状态源：store（localStorage）+ 文件树（名字/存活校验）。
 *
 * 名字优先取文件树里的实时数据：文档被重命名后页签跟着变，
 * store 里那份只是「文件树还没加载时的兜底」。
 */
export function useEditorTabs(
  openDocId: string | null,
  openDocName: string | null
): DisplayTab[] {
  // FIXED: 2026-11-16 同上：不能用 useIdeReactContext（只有 React IDE 才有），
  // 项目页两种编辑器都有 ol-project_id 这个 meta。
  const projectId = getMeta('ol-project_id')
  const { fileTreeData } = useFileTreeData()
  const [, setVersion] = useState(0)

  useEffect(() => {
    // 先订阅再 init：init 会 emit 一次「从 localStorage 读回来的页签」，
    // 顺序反了这次 emit 没人听得到，首屏就还是空的（要等下一次打开文件才出现）。
    const unsubscribe = subscribeTabs(() => setVersion(version => version + 1))
    initEditorTabs(projectId)
    return unsubscribe
  }, [projectId])

  // 打开任何文档（文件树双击、命令面板跳转、AI 改稿后 reload 都算）都会入列
  useEffect(() => {
    if (openDocId && openDocName) {
      openTab(openDocId, openDocName)
    }
  }, [openDocId, openDocName])

  // 文件树就绪后剔除已删除 / 已无权限的文档；docs 为空说明还没加载，不能当成「全删了」
  useEffect(() => {
    if (!fileTreeData || !fileTreeData.docs?.length) {
      return
    }
    pruneTabs(id => Boolean(findDocEntityById(fileTreeData, id)))
  }, [fileTreeData])

  if (!fileTreeData) {
    return getTabs()
  }

  return getTabs().map(tab => {
    const doc = findDocEntityById(fileTreeData, tab.id)
    return doc ? { id: tab.id, name: doc.name } : tab
  })
}
