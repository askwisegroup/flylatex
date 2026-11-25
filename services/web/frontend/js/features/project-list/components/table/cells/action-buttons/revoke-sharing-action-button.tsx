import { memo, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Project } from '../../../../../../../../types/project/dashboard/api'
import Icon from '../../../../../../shared/components/icon'
import Tooltip from '../../../../../../shared/components/tooltip'
import RevokeSharingModal from '../../../modals/revoke-sharing-modal'
import useIsMounted from '../../../../../../shared/hooks/use-is-mounted'
import { useProjectListContext } from '../../../../context/project-list-context'
import { revokeSharing } from '../../../../util/api'

// FIXED: 2026-11-14 「您共享的」里每行一个「取消分享」动作。
//
// 这一档列表存在的目的就是「把分享收回来」，所以取消分享必须是**行内动作**，
// 而不是像归档/删除那样藏在批量选择之后 —— 只分享了一个项目的人不该先勾选
// 再去工具条里找按钮。
type RevokeSharingButtonProps = {
  project: Project
  children: (text: string, handleOpenModal: () => void) => React.ReactElement
}

function RevokeSharingButton({
  project,
  children,
}: RevokeSharingButtonProps) {
  const { updateProjectViewData } = useProjectListContext()
  const { t } = useTranslation()
  const text = t('revoke_sharing')
  const [showModal, setShowModal] = useState(false)
  const isMounted = useIsMounted()

  const handleOpenModal = useCallback(() => {
    setShowModal(true)
  }, [])

  const handleCloseModal = useCallback(() => {
    if (isMounted.current) {
      setShowModal(false)
    }
  }, [isMounted])

  const handleRevokeSharing = useCallback(async () => {
    await revokeSharing([project.id])
    // 变回 private 后，sharedByMe 过滤器会把这一行过滤掉
    updateProjectViewData({
      ...project,
      publicAccessLevel: 'private',
      selected: false,
    })
  }, [project, updateProjectViewData])

  return (
    <>
      {children(text, handleOpenModal)}
      <RevokeSharingModal
        projects={[project]}
        actionHandler={handleRevokeSharing}
        showModal={showModal}
        handleCloseModal={handleCloseModal}
      />
    </>
  )
}

const RevokeSharingActionButtonTooltip = memo(
  function RevokeSharingActionButtonTooltip({
    project,
  }: Pick<RevokeSharingButtonProps, 'project'>) {
    return (
      <RevokeSharingButton project={project}>
        {(text, handleOpenModal) => (
          <Tooltip
            key={`tooltip-revoke-sharing-${project.id}`}
            id={`revoke-sharing-${project.id}`}
            description={text}
            overlayProps={{ placement: 'top', trigger: ['hover', 'focus'] }}
          >
            <button
              className="btn btn-link action-btn"
              aria-label={text}
              onClick={handleOpenModal}
            >
              <Icon type="chain-broken" fw />
            </button>
          </Tooltip>
        )}
      </RevokeSharingButton>
    )
  }
)

export default memo(RevokeSharingButton)
export { RevokeSharingActionButtonTooltip }
