import { memo, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../../../../../../shared/components/icon'
import Tooltip from '../../../../../../shared/components/tooltip'
import RevokeSharingModal from '../../../modals/revoke-sharing-modal'
import useIsMounted from '../../../../../../shared/hooks/use-is-mounted'
import { useProjectListContext } from '../../../../context/project-list-context'
import { revokeSharing } from '../../../../util/api'
import { Project } from '../../../../../../../../types/project/dashboard/api'

// FIXED: 2026-11-14 「您共享的」里的批量操作：取消链接分享。
// 结构与 archive/trash 的批量按钮一致（Tooltip + 确认弹窗），
// 只是动作落到已有的项目设置端点（publicAccessLevel=private → 清空 tokens，
// 旧链接立刻失效），不新增后端接口。
function RevokeSharingButton() {
  const { selectedProjects, updateProjectViewData } = useProjectListContext()
  const { t } = useTranslation()
  const text = t('revoke_sharing')
  // 没有勾选时按钮置灰：这一档工具条只有它一个按钮，
  // 不留一个点了没反应的按钮
  const disabled = selectedProjects.length === 0

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

  const handleRevokeSharing = async (project: Project) => {
    await revokeSharing([project.id])

    // 改成 private 后，sharedByMe 过滤器会把它过滤掉，行随即消失
    updateProjectViewData({
      ...project,
      publicAccessLevel: 'private',
      selected: false,
    })
  }

  return (
    <>
      <Tooltip
        id="tooltip-revoke-sharing"
        description={text}
        overlayProps={{ placement: 'bottom', trigger: ['hover', 'focus'] }}
      >
        <button
          className="btn btn-secondary"
          aria-label={text}
          onClick={handleOpenModal}
          disabled={disabled}
        >
          <Icon type="chain-broken" fw /> {text}
        </button>
      </Tooltip>
      <RevokeSharingModal
        projects={selectedProjects}
        actionHandler={handleRevokeSharing}
        showModal={showModal}
        handleCloseModal={handleCloseModal}
      />
    </>
  )
}

export default memo(RevokeSharingButton)
