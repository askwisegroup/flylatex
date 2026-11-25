import { memo } from 'react'
import { ButtonGroup, ButtonToolbar } from 'react-bootstrap'
import { useProjectListContext } from '../../../context/project-list-context'
import ArchiveProjectsButton from './buttons/archive-projects-button'
import DownloadProjectsButton from './buttons/download-projects-button'
import ProjectToolsMoreDropdownButton from './buttons/project-tools-more-dropdown-button'
import TagsDropdown from './buttons/tags-dropdown'
import TrashProjectsButton from './buttons/trash-projects-button'
import UnarchiveProjectsButton from './buttons/unarchive-projects-button'
import UntrashProjectsButton from './buttons/untrash-projects-button'
import DeleteLeaveProjectsButton from './buttons/delete-leave-projects-button'
import LeaveProjectsButton from './buttons/leave-projects-button'
import DeleteProjectsButton from './buttons/delete-projects-button'
import RevokeSharingButton from './buttons/revoke-sharing-button'

function ProjectTools() {
  const { filter, selectedProjects } = useProjectListContext()

  // FIXED: 2026-11-14 「您共享的」工具条只放「取消分享」（批量）。
  // 下载/归档/删除/标签这些跟「管理分享」没关系，不搬过来。
  if (filter === 'sharedByMe') {
    return (
      <ButtonToolbar>
        <ButtonGroup>
          <RevokeSharingButton />
        </ButtonGroup>
      </ButtonToolbar>
    )
  }

  return (
    <ButtonToolbar>
      <ButtonGroup>
        <DownloadProjectsButton />
        {filter !== 'archived' && <ArchiveProjectsButton />}
        {filter !== 'trashed' && <TrashProjectsButton />}
      </ButtonGroup>

      <ButtonGroup>
        {filter === 'trashed' && <UntrashProjectsButton />}
        {filter === 'archived' && <UnarchiveProjectsButton />}
      </ButtonGroup>

      <ButtonGroup>
        {filter === 'trashed' && (
          <>
            <LeaveProjectsButton />
            <DeleteProjectsButton />
            <DeleteLeaveProjectsButton />
          </>
        )}
      </ButtonGroup>

      {!['archived', 'trashed'].includes(filter) && <TagsDropdown />}

      {selectedProjects.length === 1 &&
        filter !== 'archived' &&
        filter !== 'trashed' && <ProjectToolsMoreDropdownButton />}
    </ButtonToolbar>
  )
}

export default memo(ProjectTools)
