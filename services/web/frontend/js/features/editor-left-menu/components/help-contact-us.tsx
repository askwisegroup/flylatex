import { useTranslation } from 'react-i18next'
import { useCallback } from 'react'
import * as eventTracking from '../../../infrastructure/event-tracking'
import { useContactUsModal } from '../../../shared/hooks/use-contact-us-modal'
import LeftMenuButton from './left-menu-button'
import { openContactUs } from '../../../shared/utils/contact-us'

export default function HelpContactUs() {
  const { modal, showModal } = useContactUsModal()
  const { t } = useTranslation()

  // FIXED: 2026-11-01 本 fork 没有 contactUsModal 模块，showModal() 是个空操作，
  // 点「联系我们」什么都不发生。没有弹窗就退回服务端配置的跳转地址。
  const hasModal = Boolean(modal)
  const showModalWithAnalytics = useCallback(() => {
    eventTracking.sendMB('left-menu-contact')
    if (hasModal) {
      showModal()
    } else {
      openContactUs()
    }
  }, [hasModal, showModal])

  return (
    <>
      <LeftMenuButton
        onClick={showModalWithAnalytics}
        icon={{
          type: 'question',
          fw: true,
        }}
      >
        {t('contact_us')}
      </LeftMenuButton>
      {modal}
    </>
  )
}
