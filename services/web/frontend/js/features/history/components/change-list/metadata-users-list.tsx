import { useTranslation } from 'react-i18next'
import { getUserColor } from '../../utils/history-details'
import { LoadedUpdate } from '../../services/types/update'
import UserNameWithColoredBadge from './user-name-with-colored-badge'

type MetadataUsersListProps = {
  currentUserId: string
} & Pick<LoadedUpdate['meta'], 'users' | 'origin'>

function MetadataUsersList({
  users,
  origin,
  currentUserId,
}: MetadataUsersListProps) {
  const { t } = useTranslation()

  return (
    <ol
      className="history-version-metadata-users"
      data-testid="history-version-metadata-users"
    >
      {users.map((user, index) => (
        <li key={index}>
          <UserNameWithColoredBadge user={user} currentUserId={currentUserId} />
        </li>
      ))}
      {!users.length && (
        <li>
          <span
            className="history-version-user-badge-color"
            style={{ backgroundColor: getUserColor() }}
          />
          {origin?.kind === 'history-resync' ||
          origin?.kind === 'history-migration' ? (
            t('overleaf_history_system')
          ) : origin?.kind === 'ai-agent' ? (
            // FIXED: 2026-10-30 Agent 改文件时 user_id 为空，原来显示"匿名"；
            // docupdater 会把 source 记成 origin.kind='ai-agent'，据此显示 AI 助手
            t('ai_assistant')
          ) : (
            t('anonymous')
          )}
        </li>
      )}
    </ol>
  )
}

export default MetadataUsersList
