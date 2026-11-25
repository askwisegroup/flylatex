import { useState } from 'react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import * as eventTracking from '../../../infrastructure/event-tracking'

import { Button } from 'react-bootstrap'
import Tooltip from '../../../shared/components/tooltip'
import Icon from '../../../shared/components/icon'

import { useEditorContext } from '../../../shared/context/editor-context'
import useIsMobile from '../../../shared/hooks/use-is-mobile'
import { useFileTreeActionable } from '../contexts/file-tree-actionable'
// FIXED: 2026-11-11 移动端文件树工具条里的「项目设置」弹窗（编译器 + 主目录）
import ProjectSettingsModal from '../../editor-left-menu/components/project-settings-modal'

function FileTreeToolbar() {
  const { permissionsLevel } = useEditorContext(editorContextPropTypes)
  const isMobile = useIsMobile()
  const [showProjectSettings, setShowProjectSettings] = useState(false)

  if (permissionsLevel === 'readOnly') return null

  return (
    <>
      <div className="toolbar toolbar-filetree">
        <FileTreeToolbarLeft />
        <FileTreeToolbarRight
          isMobile={isMobile}
          onOpenProjectSettings={() => setShowProjectSettings(true)}
        />
      </div>
      {/* 弹窗放在工具栏外面：工具栏有固定高度和 flex 排版，
          别让 position:fixed 的遮罩层落在它里面 */}
      {isMobile ? (
        <ProjectSettingsModal
          show={showProjectSettings}
          onHide={() => setShowProjectSettings(false)}
        />
      ) : null}
    </>
  )
}

const editorContextPropTypes = {
  permissionsLevel: PropTypes.oneOf(['readOnly', 'readAndWrite', 'owner']),
}

function FileTreeToolbarLeft() {
  const { t } = useTranslation()
  const {
    canCreate,
    startCreatingFolder,
    startCreatingDocOrFile,
    startUploadingDocOrFile,
  } = useFileTreeActionable()

  const createWithAnalytics = () => {
    eventTracking.sendMB('new-file-click', { location: 'toolbar' })
    startCreatingDocOrFile()
  }

  const uploadWithAnalytics = () => {
    eventTracking.sendMB('upload-click', { location: 'toolbar' })
    startUploadingDocOrFile()
  }

  if (!canCreate) return null

  return (
    <div className="toolbar-left">
      <Tooltip
        id="new-file"
        description={t('new_file')}
        overlayProps={{ placement: 'bottom' }}
      >
        <Button onClick={createWithAnalytics} bsStyle={null}>
          <Icon type="file" fw accessibilityLabel={t('new_file')} />
        </Button>
      </Tooltip>
      <Tooltip
        id="new-folder"
        description={t('new_folder')}
        overlayProps={{ placement: 'bottom' }}
      >
        <Button onClick={startCreatingFolder} bsStyle={null}>
          <Icon type="folder" fw accessibilityLabel={t('new_folder')} />
        </Button>
      </Tooltip>
      <Tooltip
        id="upload"
        description={t('upload')}
        overlayProps={{ placement: 'bottom' }}
      >
        <Button onClick={uploadWithAnalytics}>
          <Icon type="upload" fw accessibilityLabel={t('upload')} />
        </Button>
      </Tooltip>
    </div>
  )
}

function FileTreeToolbarRight({ isMobile, onOpenProjectSettings }) {
  const { t } = useTranslation()
  const { canRename, canDelete, startRenaming, startDeleting } =
    useFileTreeActionable()

  // FIXED: 2026-11-11 手机上加一颗齿轮（设置编译器 + 主目录）。
  // 设置入口和选区无关，所以只要在手机端就渲染这一组，哪怕当前没有
  // 可改名/可删除的文件（否则「没选中文件」时又只剩一条死路）。
  if (!canRename && !canDelete && !isMobile) {
    return null
  }

  return (
    <div className="toolbar-right">
      {isMobile ? (
        <Tooltip
          id="project-settings"
          description={t('project_settings')}
          overlayProps={{ placement: 'bottom' }}
        >
          <Button onClick={onOpenProjectSettings}>
            <Icon type="cog" fw accessibilityLabel={t('project_settings')} />
          </Button>
        </Tooltip>
      ) : null}
      {canRename ? (
        <Tooltip
          id="rename"
          description={t('rename')}
          overlayProps={{ placement: 'bottom' }}
        >
          <Button onClick={startRenaming}>
            <Icon type="pencil" fw accessibilityLabel={t('rename')} />
          </Button>
        </Tooltip>
      ) : null}
      {canDelete ? (
        <Tooltip
          id="delete"
          description={t('delete')}
          overlayProps={{ placement: 'bottom' }}
        >
          <Button onClick={startDeleting}>
            <Icon type="trash-o" fw accessibilityLabel={t('delete')} />
          </Button>
        </Tooltip>
      ) : null}
    </div>
  )
}

FileTreeToolbarRight.propTypes = {
  isMobile: PropTypes.bool.isRequired,
  onOpenProjectSettings: PropTypes.func.isRequired,
}

export default FileTreeToolbar
