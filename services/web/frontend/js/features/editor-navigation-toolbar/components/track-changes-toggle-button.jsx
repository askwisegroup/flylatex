import PropTypes from 'prop-types'
import classNames from 'classnames'
import { useTranslation } from 'react-i18next'

function TrackChangesToggleButton({
  trackChangesIsOpen,
  disabled,
  onMouseDown,
}) {
  const { t } = useTranslation()
  const classes = classNames('btn', 'btn-full-height', {
    active: trackChangesIsOpen && !disabled,
    disabled,
  })

  return (
    // FIXED: 2026-11-18 加 ide-review-entry 类：手机上只在「源码」档显示（见
    // mobile-pdf-only.less）。其他档位编辑器那栏根本不显示，点了没有任何反应。
    <div className="toolbar-item ide-review-entry">
      <button disabled={disabled} className={classes} onMouseDown={onMouseDown}>
        <i className="review-icon" />
        <p className="toolbar-label">{t('review')}</p>
      </button>
    </div>
  )
}

TrackChangesToggleButton.propTypes = {
  trackChangesIsOpen: PropTypes.bool,
  disabled: PropTypes.bool,
  onMouseDown: PropTypes.func.isRequired,
}

export default TrackChangesToggleButton
