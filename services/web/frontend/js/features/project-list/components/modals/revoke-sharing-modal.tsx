import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ProjectsActionModal from './projects-action-modal'
import ProjectsList from './projects-list'

type RevokeSharingModalProps = Pick<
  React.ComponentProps<typeof ProjectsActionModal>,
  'projects' | 'actionHandler' | 'showModal' | 'handleCloseModal'
>

// FIXED: 2026-11-14 取消链接分享的确认弹窗。
// 沿用 archive/trash 那套 ProjectsActionModal：同样的按钮、同样的错误提示、
// 同样的「逐个处理」流程，视觉与行为都和项目列表其它批量操作一致。
function RevokeSharingModal({
  projects,
  actionHandler,
  showModal,
  handleCloseModal,
}: RevokeSharingModalProps) {
  const { t } = useTranslation()
  const [projectsToDisplay, setProjectsToDisplay] = useState<typeof projects>(
    []
  )

  useEffect(() => {
    if (showModal) {
      setProjectsToDisplay(displayProjects => {
        return displayProjects.length ? displayProjects : projects
      })
    } else {
      setProjectsToDisplay([])
    }
  }, [showModal, projects])

  return (
    <ProjectsActionModal
      action="revokeSharing"
      actionHandler={actionHandler}
      title={t('revoke_sharing')}
      showModal={showModal}
      handleCloseModal={handleCloseModal}
      projects={projects}
    >
      <p>{t('about_to_revoke_sharing')}</p>
      <ProjectsList projects={projects} projectsToDisplay={projectsToDisplay} />
    </ProjectsActionModal>
  )
}

export default RevokeSharingModal
