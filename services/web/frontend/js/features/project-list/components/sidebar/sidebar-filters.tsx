import { useTranslation } from 'react-i18next'
import { Button } from 'react-bootstrap'
import {
  Filter,
  useProjectListContext,
} from '../../context/project-list-context'
import TagsList from './tags-list'
import ProjectsFilterMenu from '../projects-filter-menu'

type SidebarFilterProps = {
  filter: Filter
  text: React.ReactNode
}

export function SidebarFilter({ filter, text }: SidebarFilterProps) {
  const { selectFilter } = useProjectListContext()

  return (
    <ProjectsFilterMenu filter={filter}>
      {isActive => (
        <li className={isActive ? 'active' : ''}>
          <Button onClick={() => selectFilter(filter)} bsStyle={null}>
            {text}
          </Button>
        </li>
      )}
    </ProjectsFilterMenu>
  )
}

export default function SidebarFilters() {
  const { t } = useTranslation()

  return (
    <ul className="list-unstyled project-list-filters">
      <SidebarFilter filter="all" text={t('all_projects')} />
      <SidebarFilter filter="owned" text={t('your_projects')} />
      <SidebarFilter filter="shared" text={t('shared_with_you')} />
      {/* FIXED: 2026-11-14 「您共享的」：与其它过滤器完全同一套组件，
          所以配色/选中态/布局自动一致，不再单开一个页面。 */}
      <SidebarFilter filter="sharedByMe" text={t('shared_by_you')} />
      <SidebarFilter filter="archived" text={t('archived_projects')} />
      <SidebarFilter filter="trashed" text={t('trashed_projects')} />
      <TagsList />
    </ul>
  )
}
