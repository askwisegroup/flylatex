import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import AccessibleModal from '../../../shared/components/accessible-modal'
import Icon from '../../../shared/components/icon'
import { MAX_TAG_LENGTH } from '../../project-list/util/tag'

/**
 * 「项目信息」弹窗：在编辑器里直接改项目名称与标签。
 *
 * FIXED: 2026-11 需求：进了项目之后，顶部能看到名称和标签；改名/改标签不用
 * 每次都退回项目列表。编辑入口放在弹窗里（不把输入框摊在顶部工具条上）。
 *
 * 配色只用 var(--fl-*)，三套主题自动跟随；文案全部走 i18n。
 */

const labelStyle = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 600,
  marginBottom: '6px',
  color: 'var(--fl-text-muted, #666)',
}

const inputStyle = {
  flex: 1,
  minWidth: 0,
  padding: '8px 10px',
  fontSize: '13px',
  borderRadius: '4px',
  border: '1px solid var(--fl-border, #ddd)',
  background: 'var(--fl-surface, #fff)',
  color: 'var(--fl-text, #333)',
}

function ProjectInfoModal({
  show,
  onHide,
  projectName,
  hasRenamePermissions,
  onRename,
  tagsState,
}) {
  const { t } = useTranslation()
  const {
    allTags,
    hasTag,
    addTag,
    removeTag,
    createAndAddTag,
    loading,
    error,
  } = tagsState

  const [nameValue, setNameValue] = useState(projectName || '')
  const [newTagName, setNewTagName] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState(null) // { text, tone }

  // 每次打开都同步一次（用户可能在别处改过名字）
  useEffect(() => {
    if (show) {
      setNameValue(projectName || '')
      setNewTagName('')
      setBusy('')
      setNotice(null)
    }
  }, [show, projectName])

  const trimmedName = nameValue.trim()
  const nameChanged = trimmedName !== '' && trimmedName !== (projectName || '')
  const canRename = Boolean(hasRenamePermissions)

  const submitName = useCallback(
    async e => {
      e.preventDefault()
      if (!canRename || !nameChanged) return
      setBusy('name')
      setNotice(null)
      try {
        await onRename(trimmedName)
        setNotice({ text: t('project_info_saved'), tone: 'ok' })
      } catch (err) {
        setNotice({
          text: `${t('project_info_save_failed')} — ${err.message}`,
          tone: 'error',
        })
      } finally {
        setBusy('')
      }
    },
    [canRename, nameChanged, onRename, trimmedName, t]
  )

  const toggleTag = useCallback(
    async tag => {
      setBusy(`tag:${tag._id}`)
      setNotice(null)
      try {
        if (hasTag(tag._id)) {
          await removeTag(tag._id)
        } else {
          await addTag(tag._id)
        }
      } catch (err) {
        setNotice({
          text: `${t('project_info_tag_failed')} — ${err.message}`,
          tone: 'error',
        })
      } finally {
        setBusy('')
      }
    },
    [addTag, removeTag, hasTag, t]
  )

  const submitNewTag = useCallback(
    async e => {
      e.preventDefault()
      const name = newTagName.trim()
      if (!name) return
      setBusy('new-tag')
      setNotice(null)
      try {
        await createAndAddTag(name)
        setNewTagName('')
      } catch (err) {
        setNotice({
          text: `${t('project_info_tag_failed')} — ${err.message}`,
          tone: 'error',
        })
      } finally {
        setBusy('')
      }
    },
    [createAndAddTag, newTagName, t]
  )

  // 已打在本项目上的标签排前面，省得在一堆标签里找
  const sortedTags = useMemo(() => {
    const list = [...(allTags || [])]
    list.sort((a, b) => {
      const aOn = hasTag(a._id) ? 0 : 1
      const bOn = hasTag(b._id) ? 0 : 1
      if (aOn !== bOn) return aOn - bOn
      return (a.name || '').localeCompare(b.name || '')
    })
    return list
  }, [allTags, hasTag])

  return (
    <AccessibleModal show={show} onHide={onHide} id="project-info-modal">
      <Modal.Header closeButton>
        <Modal.Title>{t('project_info')}</Modal.Title>
      </Modal.Header>

      <Modal.Body>
        {/* 名称 */}
        <form onSubmit={submitName} style={{ marginBottom: '20px' }}>
          <label htmlFor="project-info-name" style={labelStyle}>
            {t('project_name')}
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              id="project-info-name"
              type="text"
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              disabled={!canRename || busy === 'name'}
              style={inputStyle}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canRename || !nameChanged || busy === 'name'}
            >
              {t('project_info_save')}
            </button>
          </div>
          {!canRename && (
            <p
              style={{
                margin: '6px 0 0',
                fontSize: '12px',
                color: 'var(--fl-text-muted, #666)',
              }}
            >
              {t('project_info_rename_forbidden')}
            </p>
          )}
        </form>

        {/* 标签 */}
        <div>
          <span style={labelStyle}>{t('tags')}</span>
          {loading && (
            <p
              style={{ fontSize: '12px', color: 'var(--fl-text-muted, #666)' }}
            >
              {t('project_info_loading')}
            </p>
          )}
          {!loading && sortedTags.length === 0 && (
            <p
              style={{ fontSize: '12px', color: 'var(--fl-text-muted, #666)' }}
            >
              {t('project_info_no_tags')}
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {sortedTags.map(tag => {
              const active = hasTag(tag._id)
              const color = tagsState.getTagColor(tag)
              return (
                <button
                  key={tag._id}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  disabled={busy === `tag:${tag._id}`}
                  aria-pressed={active}
                  title={
                    active
                      ? t('project_info_tag_remove')
                      : t('project_info_tag_add')
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '4px 10px',
                    fontSize: '12px',
                    borderRadius: '12px',
                    cursor: 'pointer',
                    border: `1px solid ${color || 'var(--fl-border, #ddd)'}`,
                    // 选中态用中灰半透明底：亮/暗两套主题都成立，又不必知道
                    // 标签色是浅是深（纯 tag 色填底时浅色标签上的白字会糊成一团）
                    background: active
                      ? 'rgba(127, 127, 127, 0.18)'
                      : 'transparent',
                    color: 'var(--fl-text, #333)',
                    fontWeight: active ? 600 : 400,
                    opacity: busy === `tag:${tag._id}` ? 0.6 : active ? 1 : 0.8,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: color,
                    }}
                  />
                  {tag.name}
                  {active && <Icon type="check" fw style={{ color }} />}
                </button>
              )
            })}
          </div>

          <form
            onSubmit={submitNewTag}
            style={{ display: 'flex', gap: '8px', marginTop: '10px' }}
          >
            <input
              type="text"
              value={newTagName}
              maxLength={MAX_TAG_LENGTH}
              onChange={e => setNewTagName(e.target.value)}
              placeholder={t('new_tag_name')}
              aria-label={t('new_tag_name')}
              style={inputStyle}
            />
            <button
              type="submit"
              className="btn btn-default"
              disabled={!newTagName.trim() || busy === 'new-tag'}
            >
              {t('project_info_create_tag')}
            </button>
          </form>
        </div>

        {(notice || error) && (
          <p
            role="status"
            style={{
              margin: '14px 0 0',
              fontSize: '12px',
              color:
                notice && notice.tone === 'error'
                  ? 'var(--fl-danger, #c0392b)'
                  : 'var(--fl-success, #1a7f64)',
            }}
          >
            {notice
              ? notice.text
              : `${t('project_info_tag_failed')} — ${error}`}
          </p>
        )}
      </Modal.Body>

      <Modal.Footer>
        <button type="button" className="btn btn-default" onClick={onHide}>
          {t('close')}
        </button>
      </Modal.Footer>
    </AccessibleModal>
  )
}

export default ProjectInfoModal
