import {
  ProjectListProvider,
  useProjectListContext,
} from '../context/project-list-context'
import { ColorPickerProvider } from '../context/color-picker-context'
import * as eventTracking from '../../../infrastructure/event-tracking'
import { Col, Row } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import useWaitForI18n from '../../../shared/hooks/use-wait-for-i18n'
import CurrentPlanWidget from './current-plan-widget/current-plan-widget'
import NewProjectButton from './new-project-button'
import ProjectListTable from './table/project-list-table'
import SurveyWidget from './survey-widget'
import WelcomeMessage from './welcome-message'
import LoadingBranded from '../../../shared/components/loading-branded'
import SystemMessages from './notifications/system-messages'
import UserNotifications from './notifications/user-notifications'
import SearchForm from './search-form'
import ProjectsDropdown from './dropdown/projects-dropdown'
import SortByDropdown from './dropdown/sort-by-dropdown'
import ProjectTools from './table/project-tools/project-tools'
import ProjectListTitle from './title/project-list-title'
import Sidebar from './sidebar/sidebar'
import LoadMore from './load-more'
import { useEffect } from 'react'
import getMeta from '../../../utils/meta'
import WelcomeMessageNew from './welcome-message-new'
import withErrorBoundary from '../../../infrastructure/error-boundary'
import { GenericErrorBoundaryFallback } from '../../../shared/components/generic-error-boundary-fallback'
import { FetchError } from '../../../infrastructure/fetch-json'

function ProjectListRoot() {
  const { isReady } = useWaitForI18n()

  if (!isReady) {
    return null
  }

  return <ProjectListRootInner />
}

export function ProjectListRootInner() {
  return (
    <ProjectListProvider>
      <ColorPickerProvider>
        <ProjectListPageContent />
      </ColorPickerProvider>
    </ProjectListProvider>
  )
}

function ProjectListPageContent() {
  const {
    totalProjectsCount,
    error,
    isLoading,
    loadProgress,
    searchText,
    setSearchText,
    selectedProjects,
    filter,
    tags,
    selectedTagId,
  } = useProjectListContext()

  const selectedTag = tags.find(tag => tag._id === selectedTagId)
  const welcomePageRedesignVariant = getMeta(
    'ol-welcomePageRedesignVariant'
  ) as 'enabled' | 'default'

  useEffect(() => {
    eventTracking.sendMB('loads_v2_dash', {})
  }, [])

  return isLoading ? (
    <div className="loading-container">
      <LoadingBranded loadProgress={loadProgress} />
    </div>
  ) : (
    <>
      <SystemMessages />
      <div className="project-list-wrapper clearfix">
        {totalProjectsCount > 0 ? (
          <>
            <Sidebar />
            <div className="project-list-main-react">
              {error ? <DashApiError error={error} /> : ''}
              <Row>
                <Col xs={12}>
                  <UserNotifications />
                </Col>
              </Row>
              <div className="project-list-header-row">
                <ProjectListTitle
                  filter={filter}
                  selectedTag={selectedTag}
                  className="hidden-xs text-truncate"
                />
                <div className="project-tools">
                  <div className="hidden-xs">
                    {selectedProjects.length === 0 ? (
                      <CurrentPlanWidget />
                    ) : (
                      <ProjectTools />
                    )}
                  </div>
                  <div className="visible-xs">
                    <CurrentPlanWidget />
                  </div>
                </div>
              </div>
              <Row className="hidden-xs">
                <Col md={7}>
                  <SearchForm
                    inputValue={searchText}
                    setInputValue={setSearchText}
                    filter={filter}
                    selectedTag={selectedTag}
                  />
                </Col>
              </Row>
              <div className="project-list-sidebar-survey-wrapper visible-xs">
                <SurveyWidget />
              </div>
              <div className="visible-xs mt-1">
                <div role="toolbar" className="projects-toolbar">
                  <ProjectsDropdown />
                  <SortByDropdown />
                </div>
              </div>
              <Row className="row-spaced">
                <Col xs={12}>
                  <div className="card project-list-card">
                    <div className="visible-xs pt-2 pb-3">
                      <div className="clearfix">
                        <NewProjectButton
                          id="new-project-button-projects-table"
                          className="pull-left me-2"
                          showAddAffiliationWidget
                        />
                        <SearchForm
                          inputValue={searchText}
                          setInputValue={setSearchText}
                          filter={filter}
                          selectedTag={selectedTag}
                          className="overflow-hidden"
                          formGroupProps={{ className: 'mb-0' }}
                        />
                      </div>
                    </div>
                    <ProjectListTable />
                  </div>
                </Col>
              </Row>
              <Row className="row-spaced">
                <Col xs={12}>
                  <LoadMore />
                </Col>
              </Row>
            </div>
          </>
        ) : (
          <div className="project-list-welcome-wrapper">
            {error ? <DashApiError error={error} /> : ''}
            <Row className="row-spaced">
              <Col
                sm={10}
                smOffset={1}
                md={8}
                mdOffset={2}
                className="project-list-empty-col"
              >
                <Row>
                  <Col xs={12}>
                    <UserNotifications />
                  </Col>
                </Row>
                {welcomePageRedesignVariant === 'enabled' ? (
                  <WelcomeMessageNew />
                ) : (
                  <WelcomeMessage />
                )}
              </Col>
            </Row>
          </div>
        )}
      </div>
    </>
  )
}

// FIXED: 2026-11-05 这个提示原来只有一句「抱歉，出错了」，拿到的状态码全被丢掉，
//   出问题时日志和页面都看不出到底是 429（限流）、5xx（后端抖动）还是链路断了。
//   现在把可判定的原因显示出来，并给一个重试按钮，不再逼用户反复刷新。
// OLD: <div className="alert alert-danger">{t('generic_something_went_wrong')}</div>
function DashApiError({ error }: { error: Error | null }) {
  const { t } = useTranslation()
  const status = error instanceof FetchError ? error.response?.status : undefined

  let hint = ''
  if (status === 429) {
    hint = t('too_many_attempts')
  } else if (status !== undefined && status >= 500) {
    hint = t('server_error')
  } else if (status === undefined && error) {
    // 连响应都没拿到：断网、连接被重置、代理超时
    hint = error.message
  }

  return (
    <Row className="row-spaced">
      <Col xs={8} xsOffset={2} aria-live="polite" className="text-center">
        <div className="alert alert-danger">
          <div>{t('generic_something_went_wrong')}</div>
          {hint ? <div className="small">{hint}</div> : null}
          {status !== undefined ? (
            <div className="small text-muted">HTTP {status}</div>
          ) : null}
          <button
            type="button"
            className="btn btn-default btn-sm"
            onClick={() => window.location.reload()}
          >
            {t('try_again')}
          </button>
        </div>
      </Col>
    </Row>
  )
}

export default withErrorBoundary(ProjectListRoot, GenericErrorBoundaryFallback)
