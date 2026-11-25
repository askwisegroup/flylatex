import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Dropdown, MenuItem } from 'react-bootstrap'
import getMeta from '../../../utils/meta'
import { useLayoutContext } from '../../../shared/context/layout-context'
import useScopeValue from '../../../shared/hooks/use-scope-value'
import type { UserSettings } from '../../editor-left-menu/utils/api'
import * as eventTracking from '../../../infrastructure/event-tracking'
import Icon from '../../../shared/components/icon'

function FileMenu() {
  const { t } = useTranslation()
  const { setLeftMenuShown } = useLayoutContext()
  const [settings] = useScopeValue<UserSettings | undefined>('settings', true)
  const anonymous = getMeta('ol-anonymous') as boolean | undefined
  const projectId = getMeta('ol-project_id') as string | undefined

  const handleBackToProjects = useCallback(() => {
    eventTracking.sendMB('navigation-clicked-home')
    window.location.href = '/project'
  }, [])

  const handleOpenSettings = useCallback(() => {
    eventTracking.sendMB('navigation-clicked-menu')
    // FIXED: 2026-11-01 设置的显示方式（左侧面板 / 居中弹窗）。
    // 实时编辑器的菜单在 toolbar-header.jsx，这里是新版 IDE 的同一入口，保持一致。
    if ((settings?.settingsPanelMode ?? 'modal') === 'modal') {
      document.dispatchEvent(
        new CustomEvent('fl:settings-modal', { detail: { open: true } })
      )
      return
    }
    setLeftMenuShown(true)
  }, [setLeftMenuShown, settings?.settingsPanelMode])

  const handleDownloadSource = useCallback(() => {
    if (projectId) {
      eventTracking.sendMB('download-zip-button-click', {
        projectId,
        location: 'file-menu',
      })
      window.open(`/project/${projectId}/download/zip`, '_blank')
    }
  }, [projectId])

  const handleDownloadPDF = useCallback(() => {
    window.dispatchEvent(new CustomEvent('file-menu:download-pdf'))
  }, [])

  if (anonymous === true || anonymous === undefined) {
    return null
  }

  return (
    <Dropdown id="ide-menu-file" pullRight className="ide-menu-dropdown">
      <Dropdown.Toggle noCaret className="ide-menu-toggle">
        {t('file')}
      </Dropdown.Toggle>
      <Dropdown.Menu className="ide-menu-dropdown-menu">
        <MenuItem onClick={handleBackToProjects}>
          <Icon type="home" fw /> {t('back_to_your_projects')}
        </MenuItem>
        <MenuItem onClick={handleOpenSettings}>
          <Icon type="cog" fw /> {t('settings')}
        </MenuItem>
        <MenuItem divider />
        <MenuItem onClick={handleDownloadSource}>
          <Icon type="file-archive-o" fw /> {t('download_source')}
        </MenuItem>
        <MenuItem onClick={handleDownloadPDF}>
          <Icon type="file-pdf-o" fw /> {t('download_pdf')}
        </MenuItem>
        <MenuItem divider />
        <MenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent('file-tree:upload'))
          }
        >
          <Icon type="upload" fw /> {t('upload')}
        </MenuItem>
        <MenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent('file-tree:delete-selected'))
          }
        >
          <Icon type="trash" fw /> {t('delete')}
        </MenuItem>
        <MenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent('file-tree:new-folder'))
          }
        >
          <Icon type="folder" fw /> {t('new_folder')}
        </MenuItem>
      </Dropdown.Menu>
    </Dropdown>
  )
}

export default FileMenu
