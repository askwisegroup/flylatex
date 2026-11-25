import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'

export default function MemberPrivileges({ privileges }) {
  const { t } = useTranslation()

  switch (privileges) {
    case 'readAndWrite':
      return t('can_edit')

    // FIXED: 2026-11 评审者档文案
    case 'review':
      return t('can_review')

    case 'readOnly':
      return t('read_only')

    default:
      return null
  }
}
MemberPrivileges.propTypes = {
  privileges: PropTypes.string.isRequired,
}
