import { lazy, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import LoadingBranded from '../../../shared/components/loading-branded'
import getMeta from '../../../utils/meta'

const PdfJsViewer = lazy(() =>
  import(/* webpackChunkName: "pdf-js-viewer" */ './pdf-js-viewer')
)

function PdfViewer() {
  const { t } = useTranslation()
  const { pdfUrl, pdfFile, pdfViewer, compiling, data } = useCompileContext()

  if (!pdfUrl) {
    // FIXED: 2026-11-03 右侧只依据「有没有 PDF / 有没有编译结果」这两个事实决定显示什么，
    //   不再依赖 error 字符串。原因：error 要经过 compile 响应 → context 的 switch →
    //   setError → PdfLogsViewer 四道关，任何一处不对，右侧就是一片空白，
    //   用户看不出到底在编译、还是编译失败了。
    //   （2026-11-03 实际就碰到了：响应里明明是 status=timedout，右侧全白、日志面板也空）
    //
    // 三个状态：没结果/正在编译 → 转圈；有结果但没有 PDF → 说明；有 PDF → 渲染。
    if (compiling || !data) {
      return (
        <div className="pdf-waiting-branded">
          <LoadingBranded loadProgress={compiling ? 70 : 35} />
        </div>
      )
    }

    const isTimeout = data.status === 'timedout'
    const compileTimeout = getMeta('ol-user')?.features?.compileTimeout || 300
    const limitMinutes = Math.max(1, Math.round(compileTimeout / 60))
    return (
      <div className="pdf-waiting-branded">
        <div className="pdf-failed-state">
          <p className="pdf-failed-state-title">
            {isTimeout ? t('timedout') : t('no_pdf_error_title')}
          </p>
          {isTimeout && (
            <p className="pdf-failed-state-line">
              {t('project_timed_out_reached_limit', {
                minutes: limitMinutes,
              })}
            </p>
          )}
          <p className="pdf-failed-state-line pdf-failed-state-line-muted">
            {t('compile_failed_see_logs')}
          </p>
        </div>
      </div>
    )
  }

  switch (pdfViewer) {
    case 'native':
      return <iframe title="PDF Preview" src={pdfUrl} />

    case 'pdfjs':
    default:
      return <PdfJsViewer url={pdfUrl} pdfFile={pdfFile} />
  }
}

export default memo(PdfViewer)
