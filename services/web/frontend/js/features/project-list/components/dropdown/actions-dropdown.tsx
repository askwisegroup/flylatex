import { useState, useCallback, useMemo } from 'react'
import { Dropdown } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import MenuItemButton from './menu-item-button'
import Icon from '../../../../shared/components/icon'
import CopyProjectButton from '../table/cells/action-buttons/copy-project-button'
import DownloadProjectButton from '../table/cells/action-buttons/download-project-button'
import UnarchiveProjectButton from '../table/cells/action-buttons/unarchive-project-button'
import UntrashProjectButton from '../table/cells/action-buttons/untrash-project-button'
import ArchiveProjectModal from '../modals/archive-project-modal'
import TrashProjectModal from '../modals/trash-project-modal'
import LeaveProjectModal from '../modals/leave-project-modal'
import DeleteProjectModal from '../modals/delete-project-modal'
import useIsMounted from '../../../../shared/hooks/use-is-mounted'
import { useProjectListContext } from '../../context/project-list-context'
import {
  archiveProject,
  trashProject,
  leaveProject,
  deleteProject,
} from '../../util/api'
import { Project } from '../../../../../../types/project/dashboard/api'
import RevokeSharingButton from '../table/cells/action-buttons/revoke-sharing-action-button'

type ActionButtonProps = {
  project: Project
  onClick: () => void // eslint-disable-line react/no-unused-prop-types
}

function CopyProjectButtonMenuItem({ project, onClick }: ActionButtonProps) {
  return (
    <CopyProjectButton project={project}>
      {text => (
        <MenuItemButton onClick={onClick} className="projects-action-menu-item">
          <Icon type="files-o" className="menu-item-button-icon" />{' '}
          <span className="menu-item-button-text">{text}</span>
        </MenuItemButton>
      )}
    </CopyProjectButton>
  )
}

function DownloadProjectButtonMenuItem({
  project,
  onClick,
}: ActionButtonProps) {
  const handleClick = (downloadProject: () => void) => {
    downloadProject()
    onClick()
  }

  return (
    <DownloadProjectButton project={project}>
      {(text, downloadProject) => (
        <MenuItemButton
          onClick={() => handleClick(downloadProject)}
          className="projects-action-menu-item"
        >
          <Icon type="cloud-download" className="menu-item-button-icon" />{' '}
          <span className="menu-item-button-text">{text}</span>
        </MenuItemButton>
      )}
    </DownloadProjectButton>
  )
}

function UnarchiveProjectButtonMenuItem({
  project,
  onClick,
}: ActionButtonProps) {
  const handleClick = (unarchiveProject: () => Promise<void>) => {
    unarchiveProject()
    onClick()
  }

  return (
    <UnarchiveProjectButton project={project}>
      {(text, unarchiveProject) => (
        <MenuItemButton
          onClick={() => handleClick(unarchiveProject)}
          className="projects-action-menu-item"
        >
          <Icon type="reply" className="menu-item-button-icon" />{' '}
          <span className="menu-item-button-text">{text}</span>
        </MenuItemButton>
      )}
    </UnarchiveProjectButton>
  )
}

function UntrashProjectButtonMenuItem({ project, onClick }: ActionButtonProps) {
  const handleClick = (untrashProject: () => Promise<void>) => {
    untrashProject()
    onClick()
  }

  return (
    <UntrashProjectButton project={project}>
      {(text, untrashProject) => (
        <MenuItemButton
          onClick={() => handleClick(untrashProject)}
          className="projects-action-menu-item"
        >
          <Icon type="reply" className="menu-item-button-icon" />{' '}
          <span className="menu-item-button-text">{text}</span>
        </MenuItemButton>
      )}
    </UntrashProjectButton>
  )
}

// FIXED: 2026-11-10 移动端「…」菜单里的归档/回收站/移出/删除点了没反应。
// 原来的实现把 XxxProjectModal 渲染在 <ul.dropdown-menu> 内部：
// 点菜单项后 dropdown 收起（display:none），挂在里面的 Modal 也跟着不可见，
// 所以看起来"点了没任何反应"（PC 端用的是行内按钮 ActionsCell，不受影响）。
// 现在把这几个需要弹窗的动作提升到 Dropdown 外面，由这里的 state 统一控制，
// 弹窗不再受菜单显隐影响。
type ProjectActionModalType = 'archive' | 'trash' | 'leave' | 'delete' | null

function ProjectActionModalMenuItem({
  iconType,
  text,
  onOpen,
}: {
  iconType: string
  text: string
  onOpen: () => void
}) {
  return (
    <MenuItemButton onClick={onOpen} className="projects-action-menu-item">
      <Icon type={iconType} className="menu-item-button-icon" />{' '}
      <span className="menu-item-button-text">{text}</span>
    </MenuItemButton>
  )
}

type ActionDropdownProps = {
  project: Project
}

function ActionsDropdown({ project }: ActionDropdownProps) {
  const { t } = useTranslation()
  const { updateProjectViewData, removeProjectFromView, filter } =
    useProjectListContext()
  const [isOpened, setIsOpened] = useState(false)
  const [actionModal, setActionModal] = useState<ProjectActionModalType>(null)
  const isMounted = useIsMounted()

  const handleClose = useCallback(() => {
    setIsOpened(false)
  }, [setIsOpened])

  const handleOpenModal = useCallback(
    (type: ProjectActionModalType) => {
      // 先收起菜单，再开弹窗（弹窗已不在菜单内部，顺序其实无所谓，但这样视觉更干净）
      setIsOpened(false)
      setActionModal(type)
    },
    [setActionModal]
  )

  const handleCloseModal = useCallback(() => {
    if (isMounted.current) {
      setActionModal(null)
    }
  }, [isMounted])

  const isOwner = useMemo(() => {
    return project.owner && window.user_id === project.owner.id
  }, [project])

  const handleArchiveProject = useCallback(async () => {
    await archiveProject(project.id)
    updateProjectViewData({
      ...project,
      archived: true,
      selected: false,
      trashed: false,
    })
  }, [project, updateProjectViewData])

  const handleTrashProject = useCallback(async () => {
    await trashProject(project.id)
    updateProjectViewData({
      ...project,
      trashed: true,
      archived: false,
      selected: false,
    })
  }, [project, updateProjectViewData])

  const handleLeaveProject = useCallback(async () => {
    await leaveProject(project.id)
    removeProjectFromView(project)
  }, [project, removeProjectFromView])

  const handleDeleteProject = useCallback(async () => {
    await deleteProject(project.id)
    removeProjectFromView(project)
  }, [project, removeProjectFromView])

  // FIXED: 2026-11-14 「您共享的」（窄屏）只有取消分享这一个动作
  if (filter === 'sharedByMe') {
    return (
      <Dropdown
        id={`project-actions-dropdown-${project.id}`}
        pullRight
        open={isOpened}
        onToggle={open => setIsOpened(open)}
      >
        <Dropdown.Toggle noCaret className="btn-transparent">
          <Icon type="ellipsis-h" fw />
        </Dropdown.Toggle>
        <Dropdown.Menu className="projects-dropdown-menu text-left">
          <RevokeSharingButton project={project}>
            {(text, handleOpenModal) => (
              <MenuItemButton
                onClick={() => {
                  setIsOpened(false)
                  handleOpenModal()
                }}
                className="projects-action-menu-item"
              >
                <Icon type="chain-broken" className="menu-item-button-icon" />{' '}
                <span className="menu-item-button-text">{text}</span>
              </MenuItemButton>
            )}
          </RevokeSharingButton>
        </Dropdown.Menu>
      </Dropdown>
    )
  }

  return (
    <>
      <Dropdown
        id={`project-actions-dropdown-${project.id}`}
        pullRight
        open={isOpened}
        onToggle={open => setIsOpened(open)}
      >
        <Dropdown.Toggle noCaret className="btn-transparent">
          <Icon type="ellipsis-h" fw />
        </Dropdown.Toggle>
        <Dropdown.Menu className="projects-dropdown-menu text-left">
          <CopyProjectButtonMenuItem project={project} onClick={handleClose} />
          <DownloadProjectButtonMenuItem
            project={project}
            onClick={handleClose}
          />
          {!project.archived && (
            <ProjectActionModalMenuItem
              iconType="inbox"
              text={t('archive')}
              onOpen={() => handleOpenModal('archive')}
            />
          )}
          {!project.trashed && (
            <ProjectActionModalMenuItem
              iconType="trash"
              text={t('trash')}
              onOpen={() => handleOpenModal('trash')}
            />
          )}
          <UnarchiveProjectButtonMenuItem
            project={project}
            onClick={handleClose}
          />
          <UntrashProjectButtonMenuItem
            project={project}
            onClick={handleClose}
          />
          {project.trashed && !isOwner && (
            <ProjectActionModalMenuItem
              iconType="sign-out"
              text={t('leave')}
              onOpen={() => handleOpenModal('leave')}
            />
          )}
          {project.trashed && isOwner && (
            <ProjectActionModalMenuItem
              iconType="ban"
              text={t('delete')}
              onOpen={() => handleOpenModal('delete')}
            />
          )}
        </Dropdown.Menu>
      </Dropdown>

      <ArchiveProjectModal
        projects={[project]}
        actionHandler={handleArchiveProject}
        showModal={actionModal === 'archive'}
        handleCloseModal={handleCloseModal}
      />
      <TrashProjectModal
        projects={[project]}
        actionHandler={handleTrashProject}
        showModal={actionModal === 'trash'}
        handleCloseModal={handleCloseModal}
      />
      <LeaveProjectModal
        projects={[project]}
        actionHandler={handleLeaveProject}
        showModal={actionModal === 'leave'}
        handleCloseModal={handleCloseModal}
      />
      <DeleteProjectModal
        projects={[project]}
        actionHandler={handleDeleteProject}
        showModal={actionModal === 'delete'}
        handleCloseModal={handleCloseModal}
      />
    </>
  )
}

export default ActionsDropdown
