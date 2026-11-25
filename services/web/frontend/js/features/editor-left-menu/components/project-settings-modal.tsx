import { useTranslation } from 'react-i18next'
import { Modal } from 'react-bootstrap'
import AccessibleModal from '../../../shared/components/accessible-modal'
import SettingsCompiler from './settings/settings-compiler'
import SettingsDocument from './settings/settings-document'

type ProjectSettingsModalProps = {
  show: boolean
  onHide: () => void
}

/**
 * FIXED: 2026-11-11 移动端「项目设置」弹窗：只放编译器 + 主目录。
 *
 * 背景：手机上文件树工具条右侧只有「改名 / 删除」，而编译器和主目录都藏在
 * 设置面板里 —— 设置入口在移动端被 CSS 收掉，导入的项目一旦主文件没选对，
 * 用户在手机上就改不了，编译不出来也就没有 PDF。
 *
 * 做法：只新增一个弹窗外壳，里面的两项直接渲染系统已有的
 * SettingsCompiler / SettingsDocument（同一个 ProjectSettingsProvider、
 * 同一份保存逻辑、同一套文案），不复制选项列表、不新增后端接口。
 */
export default function ProjectSettingsModal({
  show,
  onHide,
}: ProjectSettingsModalProps) {
  const { t } = useTranslation()

  return (
    <AccessibleModal
      show={show}
      onHide={onHide}
      id="project-settings-modal"
      // 复用设置弹窗的主题化样式（@fl-* 变量 + 设置行的排版），
      // 再在 project-settings-modal.less 里把它收成手机上合适的小窗。
      dialogClassName="settings-modal fl-project-settings-modal"
      aria-labelledby="project-settings-modal-title"
    >
      <Modal.Header closeButton>
        <Modal.Title id="project-settings-modal-title">
          {t('project_settings')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <SettingsCompiler />
        <SettingsDocument />
      </Modal.Body>
      <Modal.Footer>
        <button type="button" className="btn btn-primary" onClick={onHide}>
          {t('done')}
        </button>
      </Modal.Footer>
    </AccessibleModal>
  )
}
