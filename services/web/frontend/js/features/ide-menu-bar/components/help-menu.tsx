import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dropdown, MenuItem, Modal } from 'react-bootstrap'
import getMeta from '../../../utils/meta'
import Icon from '../../../shared/components/icon'
import { openContactUs } from '../../../shared/utils/contact-us'
// FIXED: 2026-11-10 关于弹窗正文顶部加渐变 FlyLaTeX 标记（替代原标题里的 favicon）
import AboutBrandMark from './about-brand-mark'
// FIXED: 2026-11-05 关于弹窗里的 TeX Live 版本改为探测真实值，不再写死
import {
  fetchTeXLiveVersion,
  texLiveVersionLabel,
  texLiveVersionTitle,
  type TeXLiveVersionInfo,
} from '../../../shared/utils/texlive-version'
// FIXED: 2026-11-24 版权行收口到配置（Settings.copyrightHolder），不再写死公司名
import { copyrightLine } from '../../../shared/utils/copyright'

function HelpMenu() {
  const { t } = useTranslation()
  const showSupport = getMeta('ol-showSupport') as boolean | undefined
  // FIXED: 2026-11-10 标题不再渲染 favicon 图片，baseAssetPath 只服务于那处 <img>，
  // 去掉后是未使用变量（会被 lint 拦）。如需恢复旧标题，把这行和
  // getMeta('ol-baseAssetPath') 一起加回来即可。
  // OLD: const baseAssetPath = getMeta('ol-baseAssetPath', '/') as string
  const [showAbout, setShowAbout] = useState(false)
  // FIXED: 2026-11-05 `tlmgr --version` 的结果（null = 还没取到/探测失败）
  const [texLiveVersion, setTeXLiveVersion] =
    useState<TeXLiveVersionInfo | null>(null)

  const handleShowHotkeys = useCallback(() => {
    window.dispatchEvent(new CustomEvent('hotkeys:show'))
  }, [])

  const handleOpenDocs = useCallback(() => {
    window.open('/learn', '_blank')
  }, [])

  // FIXED: 2026-11-01 原来开 /contact，本 fork 没有这条路由，点了跟没反应一样。
  // 现在跳服务端配置的 CONTACT_US_URL（可为 mailto:），没配就用论坛地址。
  const handleContactUs = useCallback(() => {
    openContactUs()
  }, [])

  const handleShowAbout = useCallback(() => {
    setShowAbout(true)
    fetchTeXLiveVersion().then(setTeXLiveVersion)
  }, [])

  const handleCloseAbout = useCallback(() => {
    setShowAbout(false)
  }, [])

  return (
    <>
      <Dropdown id="ide-menu-help" pullRight className="ide-menu-dropdown">
        <Dropdown.Toggle noCaret className="ide-menu-toggle">
          {t('help')}
        </Dropdown.Toggle>
        <Dropdown.Menu className="ide-menu-dropdown-menu">
          <MenuItem onClick={handleShowHotkeys}>
            <Icon type="keyboard-o" fw /> {t('hotkeys')}
          </MenuItem>
          {showSupport && (
            <>
              <MenuItem onClick={handleOpenDocs}>
                <Icon type="book" fw /> {t('documentation')}
              </MenuItem>
              <MenuItem onClick={handleContactUs}>
                <Icon type="envelope" fw /> {t('contact_us')}
              </MenuItem>
            </>
          )}
          <MenuItem divider />
          <MenuItem onClick={handleShowAbout}>
            <Icon type="info-circle" fw /> {t('about_system')}
          </MenuItem>
        </Dropdown.Menu>
      </Dropdown>
      <Modal show={showAbout} onHide={handleCloseAbout} centered>
        <Modal.Header closeButton>
          {/* FIXED: 2026-11-10 标题不再用「favicon + FlyLaTeX」，改成多语言的「关于系统」。
                  旧写法：
                    <img src={`${baseAssetPath}favicon.ico`} alt="FlyLaTeX" width="32"
                         height="32" style={{ marginRight: '10px', verticalAlign: 'middle' }} />
                    FlyLaTeX
                  产品标识挪到正文（见下方 AboutBrandMark），这里只留标题文字。 */}
          <Modal.Title>{t('about_system')}</Modal.Title>
        </Modal.Header>
        {/* FIXED: 2026-11-10 正文上下的空白收一点：默认 .modal-body 的 padding
                加上字标容器自身的高度，会把标题和字标之间拉开一大块空白。 */}
        <Modal.Body style={{ textAlign: 'center', paddingTop: '18px' }}>
          {/* FIXED: 2026-11-10 正文顶部放 FlyLaTeX 字标（复用系统加载页的填充动画），
                  压在 TeXLive 版本号上方。
                  宽度收窄到 150px：字标按 220x60 的比例缩放，再大就会把弹窗撑得很高。 */}
          <AboutBrandMark width={150} />
          {/* FIXED: 2026-11-05 原来写死 `TeXLive 2026`，服务器上装的是 2023/2025，
                三者互不相同。现在用 tlmgr 自己报的版本，探测不到就只显示 `TeXLive`。
                刻意不展示安装树路径 / 原始输出（不向客户端泄露服务器细节） */}
          {/* 悬停显示完整版本号（TeX Live 2025）：不带安装路径，不加任何解释性文案 */}
          {/* FIXED: 2026-11-10 版本号原来只有浏览器默认的下边距，上方紧贴字标，看起来
                上下不对称。改成上下各 12.5px，与字标和版权行保持匀称的间距。 */}
          <p
            title={texLiveVersionTitle(texLiveVersion)}
            style={{ margin: '12.5px 0' }}
          >
            <strong>{texLiveVersionLabel(texLiveVersion)}</strong>
          </p>
          {/* FIXED: 2026-11-24 版权保护方改为配置驱动（cn 公司主体 / sg 产品名） */}
          <p>{copyrightLine()}</p>
        </Modal.Body>
        <Modal.Footer>
          <button className="btn btn-primary" onClick={handleCloseAbout}>
            {t('close')}
          </button>
        </Modal.Footer>
      </Modal>
    </>
  )
}

export default HelpMenu
