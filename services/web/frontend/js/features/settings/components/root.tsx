import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import getMeta from '../../../utils/meta'
import EmailsSection from './emails-section'
import AccountInfoSection from './account-info-section'
import ManagedAccountAlert from './managed-account-alert'
import PasswordSection from './password-section'
// FIXED: 2026-11-12 设置页新增「充值 / 充值记录」区块（见 billing-section.tsx）
import BillingSection from './billing-section'
import MembershipSection from './membership-section'
// FIXED: 2026-11-20 新增「默认语言」（sg 站有 Google 登录 + 8 种语言，同样需要）
import LanguageSection from './language-section'
import LinkingSection from './linking-section'
import BetaProgramSection from './beta-program-section'
import LabsProgramSection from './labs-program-section'
import SessionsSection from './sessions-section'
// FIXED: 2026-10-15 DesktopSync —— Web「设置 → 同步密钥」区块（服务未启用时自动隐藏）
import SyncKeysSection from './SyncKeysSection'
import NewsletterSection from './newsletter-section'
import LeaveSection from './leave-section'
import * as eventTracking from '../../../infrastructure/event-tracking'
import { UserProvider } from '../../../shared/context/user-context'
import { SSOProvider } from '../context/sso-context'
import useWaitForI18n from '../../../shared/hooks/use-wait-for-i18n'
import useScrollToIdOnLoad from '../../../shared/hooks/use-scroll-to-id-on-load'
import { ExposedSettings } from '../../../../../types/exposed-settings'
import { SSOAlert } from './emails/sso-alert'
import UsageSection from './UsageSection'
// FIXED: 2026-11-15 非 VIP 用户（cn）在设置页看到升级入口与权益对比
import VipUpsellSection from './vip-upsell-section'

function SettingsPageRoot() {
  const { isReady } = useWaitForI18n()
  useScrollToIdOnLoad()

  useEffect(() => {
    eventTracking.sendMB('settings-view')
  }, [])

  return (
    <div className="container">
      <div className="row">
        <div className="col-md-12 col-lg-10 col-lg-offset-1">
          {isReady ? <SettingsPageContent /> : null}
        </div>
      </div>
    </div>
  )
}

function SettingsPageContent() {
  const { t } = useTranslation()
  const { isOverleaf, labsEnabled, passwordChangeEnabled } = getMeta(
    'ol-ExposedSettings'
  ) as ExposedSettings
  const user = getMeta('ol-user')
  // FIXED: 2026-10-23 VIP 徽标只按「账号级别」判断（vipStatus.isVip），
  // 不再以「机构字段非空」作为 VIP 依据——此前任何填了学校的普通用户都会显示 VIP。
  // VIP 到期时间统一在「使用统计」里展示（徽标 + 天数），这里不再重复一块。
  const { institution, institutionSource } = user || {}

  return (
    <UserProvider>
      <div className="card">
        <div className="page-header">
          <h1>{t('account_settings')}</h1>
        </div>
        <div>
          <ManagedAccountAlert />
          <EmailsSection />
          <SSOAlert />
          {/* 表单两列等高，统计整幅铺开：之前把一长串统计塞进右侧窄栏，
              左栏早早结束，于是左下方留出一大片空白。 */}
          {/* FIXED: 2026-11-20 右栏原来是「更换密码」（只挂了一个去用户中心改密的
              外链，在这里既改不了密码、也占着位置）。现在换成「默认语言」：
              同样是短区块，两列在 md 以下自动堆叠，不会挤。 */}
          <div className="row">
            <div className="col-md-6">
              <AccountInfoSection />
            </div>
            <div className="col-md-6">
              {/* FIXED: 2026-11-12 「修改密码」默认下线，原位换成充值/充值记录：
                  本站注册登录走 Google / 统一认证，邮件通道未开通，改密与重置邮件的
                  闭环是断的。password-section.tsx 一行未改，PASSWORD_CHANGE_ENABLED=1
                  即可原样恢复。
                  OLD: <PasswordSection /> */}
              {passwordChangeEnabled ? <PasswordSection /> : <BillingSection />}
            </div>
          </div>
          <hr />
          {/* FIXED: 2026-11-20 默认语言（master 上放在右栏；sg 右栏是充值入口，
              语言单独占一段，避免和计费区挤在一起） */}
          <div className="row">
            <div className="col-md-6">
              <LanguageSection />
            </div>
          </div>
          <hr />
          {/* 会员（能力）与充值（LLM 用量）是两件事，放在用量统计之前 */}
          <MembershipSection />
          <hr />
          <UsageSection />
          <VipUpsellSection />
          <hr />
          <SSOProvider>
            <LinkingSection />
          </SSOProvider>
          {isOverleaf ? (
            <>
              <BetaProgramSection />
              <hr />
            </>
          ) : null}
          {labsEnabled ? (
            <>
              <LabsProgramSection />
              <hr />
            </>
          ) : null}
          {/* FIXED: 2026-10-23 机构单独展示，不再附挂 VIP 徽标 */}
          {institution && (
            <div className="settings-section">
              <h3>{t('institution')}</h3>
              <div className="form-group">
                <p className="form-control-static">
                  {institution}
                  {institutionSource === 'ne' && (
                    <small
                      className="text-muted"
                      style={{ display: 'block', marginTop: 4 }}
                    >
                      该机构由统一认证（CARSI / 学号 / 手机号）自动同步。
                      如与实际不符，请联系客服核对，修正后不会被登录覆盖。
                    </small>
                  )}
                </p>
              </div>
            </div>
          )}
          {/* FIXED: 2026-11-15 「会话」挪到 API 密钥之后（原来夹在机构与密钥中间，
              路径被无谓打断；会话管理是低频操作，放最末更合适） */}
          {/* FIXED: 2026-10-15 DesktopSync —— 同步密钥管理（桌面端入口） */}
          <hr />
          <SyncKeysSection />
          <hr />
          <SessionsSection />
          {isOverleaf ? (
            <>
              <hr />
              <NewsletterSection />
              <hr />
              <LeaveSection />
            </>
          ) : null}
        </div>
      </div>
    </UserProvider>
  )
}

export default SettingsPageRoot
