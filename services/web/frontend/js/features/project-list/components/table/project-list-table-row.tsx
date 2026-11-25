import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import InlineTags from './cells/inline-tags'
import OwnerCell from './cells/owner-cell'
import LastUpdatedCell from './cells/last-updated-cell'
import ActionsCell from './cells/actions-cell'
import ActionsDropdown from '../dropdown/actions-dropdown'
import { useProjectListContext } from '../../context/project-list-context'
import { getOwnerName } from '../../util/project'
import { Project } from '../../../../../../types/project/dashboard/api'

type ProjectListTableRowProps = {
  project: Project
}
export default function ProjectListTableRow({
  project,
}: ProjectListTableRowProps) {
  const { t } = useTranslation()
  const ownerName = getOwnerName(project)
  const { updateProjectViewData, filter } = useProjectListContext()
  // FIXED: 2026-11-14 「您共享的」里这两列换成分享信息
  const isSharedByMe = filter === 'sharedByMe'

  const handleCheckboxChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      updateProjectViewData({ ...project, selected: event.target.checked })
    },
    [project, updateProjectViewData]
  )

  return (
    <tr>
      <td className="dash-cell-checkbox hidden-xs">
        <input
          type="checkbox"
          id={`select-project-${project.id}`}
          checked={project.selected === true}
          onChange={handleCheckboxChange}
          data-project-id={project.id}
        />
        <label htmlFor={`select-project-${project.id}`} className="sr-only">
          {t('select_project', { project: project.name })}
        </label>
      </td>
      <td className="dash-cell-name">
        {/* FIXED: 2026-11-07 点击项目不再 target='_blank'，在当前页签进入/切换项目。
            导航栏 LOGO（MenuBarLogo）点击回 /project，同一页签来回切换。
            OLD: <a href={`/project/${project.id}`} target='_blank'>{project.name}</a>{' '} */}
        <a href={`/project/${project.id}`}>{project.name}</a>{' '}
        {/* FIXED: 2026-11 关联了 Git 仓库的项目加一个分支图标，
            一眼能看出哪些项目可以从编辑器里拉取 / 推送 */}
        {project.gitLinked ? (
          <i
            className="fa fa-code-fork fa-fw git-linked-icon"
            aria-hidden="true"
            title={t('git_linked_project')}
          />
        ) : null}
        {!isSharedByMe && (
          <InlineTags className="hidden-xs" projectId={project.id} />
        )}
      </td>
      <td className="dash-cell-date-owner visible-xs pb-0">
        {isSharedByMe ? <ShareModeBadges project={project} /> : null}
        {isSharedByMe ? (
          <div>{project.sharedAt || '—'}</div>
        ) : (
          <>
            <LastUpdatedCell project={project} />
            {ownerName ? <> — {t('owned_by_x', { x: ownerName })}</> : null}
          </>
        )}
      </td>
      <td className="dash-cell-owner hidden-xs">
        {isSharedByMe ? (
          <ShareModeBadges project={project} />
        ) : (
          <OwnerCell project={project} />
        )}
      </td>
      <td className="dash-cell-date hidden-xs">
        {isSharedByMe ? project.sharedAt || '—' : <LastUpdatedCell project={project} />}
      </td>
      <td className="dash-cell-tag visible-xs pt-0">
        {!isSharedByMe && <InlineTags projectId={project.id} />}
      </td>
      <td className="dash-cell-actions">
        <div className="hidden-xs">
          <ActionsCell project={project} />
        </div>
        <div className="visible-xs">
          <ActionsDropdown project={project} />
        </div>
      </td>
    </tr>
  )
}

/**
 * 分享模式徽章。
 *
 * tokenBased（链接分享）同时给出只读和可编辑两个链接，所以显示两枚徽章；
 * 旧版 readOnly / readAndWrite 是「谁拿到链接谁能看/改」，只有一枚。
 */
function ShareModeBadges({ project }: { project: Project }) {
  const { t } = useTranslation()
  const level = project.publicAccessLevel
  const readOnly = level === 'readOnly' || level === 'tokenBased'
  const readAndWrite = level === 'readAndWrite' || level === 'tokenBased'
  return (
    <>
      {readOnly ? (
        <span className="share-mode-badge">{t('read_only')}</span>
      ) : null}
      {readAndWrite ? (
        <span className="share-mode-badge share-mode-badge--rw">
          {t('can_edit')}
        </span>
      ) : null}
    </>
  )
}
