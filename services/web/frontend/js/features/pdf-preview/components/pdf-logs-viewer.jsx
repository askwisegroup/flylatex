import { useTranslation } from 'react-i18next'
import { memo } from 'react'
import classnames from 'classnames'
import PdfValidationIssue from './pdf-validation-issue'
import StopOnFirstErrorPrompt from './stop-on-first-error-prompt'
import TimeoutUpgradePrompt from './timeout-upgrade-prompt'
import TimeoutUpgradePromptNew from './timeout-upgrade-prompt-new'
import PdfPreviewError from './pdf-preview-error'
import PdfClearCacheButton from './pdf-clear-cache-button'
import PdfDownloadFilesButton from './pdf-download-files-button'
import PdfFixWithAIButton from './pdf-fix-with-ai-button'
// FIXED: 2026-11-16 AI 修复建议面板：作为日志内容区的整宽区块（不再塞进底部动作行）
import PdfAiFixPanel from '@/features/compile-error-fix/pdf-ai-fix-panel'
import PdfLogsEntries from './pdf-logs-entries'
import withErrorBoundary from '../../../infrastructure/error-boundary'
import PdfPreviewErrorBoundaryFallback from './pdf-preview-error-boundary-fallback'
import PdfCodeCheckFailedNotice from './pdf-code-check-failed-notice'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import PdfLogEntry from './pdf-log-entry'
import { usePdfPreviewContext } from '@/features/pdf-preview/components/pdf-preview-provider'

function PdfLogsViewer() {
  const {
    codeCheckFailed,
    error,
    logEntries,
    rawLog,
    validationIssues,
    showLogs,
    stoppedOnFirstError,
    showNewCompileTimeoutUI,
  } = useCompileContext()

  const { loadingError } = usePdfPreviewContext()

  const { t } = useTranslation()

  // FIXED: 2026-11-03 日志面板是绝对定位、全屏覆盖在 PDF 区域上的（.logs-pane，
  //   top:@pdf-top-offset，z-index:11，不透明背景 #faf9f5）。
  //   以前只要 showLogs 为真就铺开，哪怕里面一条内容都没有——
  //   结果是右侧整个变成一块空白的米色面板，把真正要展示的
  //   PDF / 载入动画 / 编译失败说明全部盖住。
  //   用户看到的“白板”就是这块空面板（截图像素正好是 @logs-pane-bg）。
  //   现在：没内容就不铺开。
  const hasLogContent = Boolean(
    codeCheckFailed ||
      stoppedOnFirstError ||
      loadingError ||
      error ||
      validationIssues ||
      logEntries ||
      rawLog
  )

  return (
    <div
      className={classnames('logs-pane', {
        hidden: (!showLogs || !hasLogContent) && !loadingError,
      })}
    >
      <div className="logs-pane-content">
        {codeCheckFailed && <PdfCodeCheckFailedNotice />}

        {stoppedOnFirstError && <StopOnFirstErrorPrompt />}

        {loadingError && <PdfPreviewError error="pdf-viewer-loading-error" />}

        {/* FIXED: 2026-11-03 超时时日志面板一片空白，原因就在这里：
            showNewCompileTimeoutUI 在生产环境里恒为真（EditorHttpController 会对每个项目
            设成 'active' 或 'changing'），于是超时时**只**渲染 TimeoutUpgradePromptNew；
            而它第一行就是 if (!window.ExposedSettings.enableSubscriptions) return null，
            本部署 enableSubscriptions 是 false（settings.defaults.js 默认 false），
            所以整块面板渲染成空。
            因为走了这个分支，下面 PdfPreviewError 的超时提示从来没被渲染过。
            现在：错误说明永远渲染；升级引导只在能真显示出来时才选新版。
            OLD: {showNewCompileTimeoutUI && error === 'timedout' ? (
                   <TimeoutUpgradePromptNew />
                 ) : (
                   <>{error && <PdfPreviewError error={error} />}
                     {error === 'timedout' && <TimeoutUpgradePrompt />}</>
                 )} */}
        {error && <PdfPreviewError error={error} />}

        {error === 'timedout' &&
          (showNewCompileTimeoutUI &&
          window.ExposedSettings?.enableSubscriptions ? (
            <TimeoutUpgradePromptNew />
          ) : (
            <TimeoutUpgradePrompt />
          ))}

        {validationIssues &&
          Object.entries(validationIssues).map(([name, issue]) => (
            <PdfValidationIssue key={name} name={name} issue={issue} />
          ))}

        {logEntries?.all && (
          <PdfLogsEntries
            entries={logEntries.all}
            hasErrors={logEntries.errors.length > 0}
          />
        )}

        {rawLog && (
          <PdfLogEntry
            headerTitle={t('raw_logs')}
            rawContent={rawLog}
            entryAriaLabel={t('raw_logs_description')}
            level="raw"
          />
        )}

        <PdfAiFixPanel />

        <div className="logs-pane-actions">
          <PdfFixWithAIButton />
          <PdfClearCacheButton />
          <PdfDownloadFilesButton />
        </div>
      </div>
    </div>
  )
}

export default withErrorBoundary(memo(PdfLogsViewer), () => (
  <PdfPreviewErrorBoundaryFallback type="logs" />
))
