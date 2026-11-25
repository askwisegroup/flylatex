import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { Button, Form, Modal } from 'react-bootstrap'
import AccessibleModal from '../../../shared/components/accessible-modal'
import { settingsGroups } from './settings-groups'

type SettingsModalProps = {
  show: boolean
  onHide: () => void
}

/**
 * 设置弹窗（居中、分类展示）。
 *
 * FIXED: 2026-11-01
 * 只是「设置的显示方式」为 modal 时的另一个渲染出口：
 * 设置项组件、保存逻辑、生效方式全部复用，没有任何功能改动。
 * 分类表来自 settings-groups，和左侧面板模式共用一份。
 */
export default function SettingsModal({ show, onHide }: SettingsModalProps) {
  const { t } = useTranslation()
  const [activeGroupId, setActiveGroupId] = useState(settingsGroups[0].id)

  const activeGroup = useMemo(
    () =>
      settingsGroups.find(group => group.id === activeGroupId) ??
      settingsGroups[0],
    [activeGroupId]
  )

  return (
    <AccessibleModal
      show={show}
      onHide={onHide}
      id="settings-modal"
      // FIXED: 2026-11-01 className 在 react-bootstrap 0.33 会落到最外层 .modal 上，
      // 把 fixed 遮罩层写成了 860px 宽（右侧那条竖白条就是这么来的）。改用 dialogClassName。
      dialogClassName="settings-modal"
      aria-labelledby="settings-modal-title"
    >
      <Modal.Header closeButton>
        <Modal.Title id="settings-modal-title">{t('settings')}</Modal.Title>
      </Modal.Header>
      <Modal.Body className="settings-modal-body">
        <nav className="settings-modal-nav" role="tablist">
          {settingsGroups.map(group => (
            <button
              key={group.id}
              type="button"
              role="tab"
              aria-selected={group.id === activeGroup.id}
              className={classNames('settings-modal-nav-item', {
                active: group.id === activeGroup.id,
              })}
              onClick={() => setActiveGroupId(group.id)}
            >
              {t(group.labelKey)}
            </button>
          ))}
        </nav>
        <div className="settings-modal-panel" role="tabpanel">
          <Form className="settings">
            {activeGroup.items.map((Item, index) => (
              <Item key={`${activeGroup.id}-${index}`} />
            ))}
          </Form>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button bsStyle="primary" onClick={onHide}>
          {t('close')}
        </Button>
      </Modal.Footer>
    </AccessibleModal>
  )
}
