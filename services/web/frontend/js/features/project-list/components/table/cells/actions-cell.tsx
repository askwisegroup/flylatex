import { Project } from '../../../../../../../types/project/dashboard/api'
import { CopyProjectButtonTooltip } from './action-buttons/copy-project-button'
import { ArchiveProjectButtonTooltip } from './action-buttons/archive-project-button'
import { TrashProjectButtonTooltip } from './action-buttons/trash-project-button'
import { UnarchiveProjectButtonTooltip } from './action-buttons/unarchive-project-button'
import { UntrashProjectButtonTooltip } from './action-buttons/untrash-project-button'
import { DownloadProjectButtonTooltip } from './action-buttons/download-project-button'
import { LeaveProjectButtonTooltip } from './action-buttons/leave-project-button'
import { DeleteProjectButtonTooltip } from './action-buttons/delete-project-button'
import { RevokeSharingActionButtonTooltip } from './action-buttons/revoke-sharing-action-button'
import { useProjectListContext } from '../../../context/project-list-context'

type ActionsCellProps = {
  project: Project
}

export default function ActionsCell({ project }: ActionsCellProps) {
  const { filter } = useProjectListContext()

  // FIXED: 2026-11-14 「您共享的」只有一件事要做：取消分享。
  // 复制/下载/归档/删除这些跟「管理分享」无关的动作不再堆在这里。
  if (filter === 'sharedByMe') {
    return <RevokeSharingActionButtonTooltip project={project} />
  }

  return (
    <>
      <CopyProjectButtonTooltip project={project} />
      <DownloadProjectButtonTooltip project={project} />
      <ArchiveProjectButtonTooltip project={project} />
      <TrashProjectButtonTooltip project={project} />
      <UnarchiveProjectButtonTooltip project={project} />
      <UntrashProjectButtonTooltip project={project} />
      <LeaveProjectButtonTooltip project={project} />
      <DeleteProjectButtonTooltip project={project} />
    </>
  )
}
