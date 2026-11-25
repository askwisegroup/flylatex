import classNames from 'classnames'
import { useTranslation } from 'react-i18next'
import NewProjectButton from '../new-project-button'
import SidebarFilters from './sidebar-filters'
import AddAffiliation, { useAddAffiliation } from '../add-affiliation'
import SurveyWidget from '../survey-widget'
import { usePersistedResize } from '../../../../shared/hooks/use-resize'

function Sidebar() {
  const { t } = useTranslation()
  const { show: showAddAffiliationWidget } = useAddAffiliation()
  const { mousePos, isResizing, getHandleProps, getTargetProps } =
    usePersistedResize({
      name: 'project-sidebar',
    })

  return (
    <div
      className="project-list-sidebar-wrapper-react hidden-xs"
      {...getTargetProps({
        style: {
          ...(mousePos?.x && { flexBasis: `${mousePos.x}px` }),
        },
      })}
    >
      <div className="project-list-sidebar-subwrapper">
        <aside className="project-list-sidebar-react">
          <NewProjectButton id="new-project-button-sidebar" />
          <SidebarFilters />
          {showAddAffiliationWidget && <hr />}
          <AddAffiliation />
        </aside>
        <div className="project-list-sidebar-survey-wrapper">
          <SurveyWidget />
        </div>
      </div>
      {/* FIXED: 2026-11-19 拖拽条原来是 4px 的透明 div，只有 cursor 会变，
          肉眼完全看不见。改成和编辑器面板分隔条同款（浅色带 + 点阵抓握点），
          尺寸/配色/悬停反馈都交给 project-list-react.less。
          列表侧栏不支持收起，所以不带编辑器那个收起小三角。 */}
      <div
        className={classNames('project-list-sidebar-resize-handle', {
          'project-list-sidebar-resize-handle-dragging': isResizing,
        })}
        role="separator"
        aria-orientation="vertical"
        title={t('resize')}
        {...getHandleProps()}
      />
    </div>
  )
}

export default Sidebar
