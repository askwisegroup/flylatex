import { useTranslation } from 'react-i18next'
import Icon from '../../../shared/components/icon'
import { Tag } from '../../../../../app/src/Features/Tags/types'
import { getTagColor } from '../../project-list/util/tag'

/**
 * 顶部工具条上的「本项目标签」小药丸。
 *
 * FIXED: 2026-11 需求：进项目后就能看到标签，点一下就近改（弹窗里改，
 * 不把编辑控件摊在工具条上）。
 *
 * 显示策略：最多 2 个药丸 + 「+N」，其余在弹窗里看；窄屏只留编辑按钮，
 * 名字和标签都不会把工具条撑破。
 */

const MAX_PILLS = 2

type ProjectTagsPillsProps = {
  tags: Tag[]
  onEdit: () => void
  /** 匿名只读（没有登录用户）时不可编辑，只展示 */
  canEdit?: boolean
  className?: string
}

function ProjectTagsPills({
  tags,
  onEdit,
  canEdit = true,
  className,
}: ProjectTagsPillsProps) {
  const { t } = useTranslation()
  const visible = tags.slice(0, MAX_PILLS)
  const hiddenCount = tags.length - visible.length

  return (
    <div className={['project-tags', className].filter(Boolean).join(' ')}>
      {visible.map(tag => (
        <button
          key={tag._id}
          type="button"
          className="project-tags-pill"
          style={{ borderColor: getTagColor(tag), color: getTagColor(tag) }}
          onClick={onEdit}
          title={tag.name}
        >
          {tag.name}
        </button>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="project-tags-pill project-tags-pill-more"
          onClick={onEdit}
          title={t('project_info')}
        >
          +{hiddenCount}
        </button>
      )}
      {canEdit && (
        <button
          type="button"
          className="project-tags-edit"
          onClick={onEdit}
          title={t('project_info_edit')}
          aria-label={t('project_info_edit')}
        >
          <Icon type={tags.length > 0 ? 'pencil' : 'tags'} fw />
        </button>
      )}
    </div>
  )
}

export default ProjectTagsPills
