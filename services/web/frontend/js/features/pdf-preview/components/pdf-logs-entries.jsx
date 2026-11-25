import { memo } from 'react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import PreviewLogsPaneMaxEntries from '../../preview/components/preview-logs-pane-max-entries'
import PdfLogEntry from './pdf-log-entry'
import { useDetachCompileContext } from '../../../shared/context/detach-compile-context'
import Icon from '../../../shared/components/icon'

const LOG_PREVIEW_LIMIT = 100

function PdfLogsEntries({ entries, hasErrors }) {
  const { t } = useTranslation()
  const { syncToEntry } = useDetachCompileContext()
  const logEntries = entries.slice(0, LOG_PREVIEW_LIMIT)

  return (
    <>
      {entries.length > LOG_PREVIEW_LIMIT && (
        <PreviewLogsPaneMaxEntries
          totalEntries={entries.length}
          entriesShown={LOG_PREVIEW_LIMIT}
          hasErrors={hasErrors}
        />
      )}
      {logEntries.map(logEntry => (
        <div key={`wrap-${logEntry.key}`}>
          <PdfLogEntry
            key={logEntry.key}
            ruleId={logEntry.ruleId}
            headerTitle={logEntry.messageComponent ?? logEntry.message}
            rawContent={logEntry.content}
            logType={logEntry.type}
            level={logEntry.level}
            contentDetails={logEntry.contentDetails}
            entryAriaLabel={t('log_entry_description', {
              level: logEntry.level,
            })}
            sourceLocation={{
              file: logEntry.file,
              line: logEntry.line,
              column: logEntry.column,
            }}
            onSourceLocationClick={syncToEntry}
          />
          {/* FIXED: 2026-11-16 「AI 修复」入口就放在每条 error 下面：
            用户看到的第一处错误旁边就有按钮，不用再滑到面板底部去找。
            只派发一个事件，真正的请求/面板状态仍由 PdfFixWithAIButton 持有。 */}
          {logEntry.level === 'error' && (
            <div className="fl-error-fix-entry-action">
              <button
                type="button"
                className="fl-error-fix-entry-btn"
                onClick={() =>
                  window.dispatchEvent(new Event('fl-error-fix:request'))
                }
              >
                <Icon type="magic" /> AI 修复
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  )
}
PdfLogsEntries.propTypes = {
  entries: PropTypes.arrayOf(PropTypes.object),
  hasErrors: PropTypes.bool,
}

export default memo(PdfLogsEntries)
