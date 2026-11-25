import PropTypes from 'prop-types'
import { useTranslation, Trans } from 'react-i18next'
import { memo, useCallback } from 'react'
import { Button } from 'react-bootstrap'
import PdfLogEntry from './pdf-log-entry'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import { useStopOnFirstError } from '../../../shared/hooks/use-stop-on-first-error'
import getMeta from '../../../utils/meta'

function PdfPreviewError({ error }) {
  const { t } = useTranslation()

  const { startCompile } = useCompileContext()

  switch (error) {
    case 'rendering-error-expected':
      return (
        <PdfLogEntry
          headerTitle={t('pdf_rendering_error')}
          formattedContent={
            <>
              <Trans
                i18nKey="something_went_wrong_rendering_pdf_expected"
                components={[
                  // eslint-disable-next-line react/jsx-key
                  <Button
                    bsSize="xs"
                    bsStyle="info"
                    onClick={() => startCompile()}
                  />,
                ]}
              />
              <br />
              <br />
              <Trans
                i18nKey="last_resort_trouble_shooting_guide"
                components={[
                  // eslint-disable-next-line jsx-a11y/anchor-has-content
                  <a
                    href="/help#help-pdf"
                    target="_blank" rel="noopener"
                    key="troubleshooting-link"
                  />,
                ]}
              />
            </>
          }
          level="warning"
        />
      )

    case 'rendering-error':
      return (
        <ErrorLogEntry title={t('pdf_rendering_error')}>
          {t('something_went_wrong_rendering_pdf')}
          &nbsp;
          <Trans
            i18nKey="try_recompile_project_or_troubleshoot"
            components={[
              // eslint-disable-next-line jsx-a11y/anchor-has-content
              <a
                href="/help#help-pdf"
                target="_blank" rel="noopener"
                key="troubleshooting-link"
              />,
            ]}
          />
          {getMeta('ol-compilesUserContentDomain') && (
            <>
              <br />
              <br />
              <Trans
                i18nKey="new_compile_domain_notice"
                values={{
                  compilesUserContentDomain: new URL(
                    getMeta('ol-compilesUserContentDomain')
                  ).hostname,
                }}
                shouldUnescape
                tOptions={{ interpolation: { escapeValue: true } }}
                components={[
                  <code key="domain" />,
                  /* eslint-disable-next-line jsx-a11y/anchor-has-content */
                  <a
                    href="/help#help-pdf"
                    target="_blank" rel="noopener"
                    key="troubleshooting-link"
                  />,
                ]}
              />
            </>
          )}
        </ErrorLogEntry>
      )

    case 'clsi-maintenance':
      return (
        <ErrorLogEntry title={t('server_error')}>
          {t('clsi_maintenance')}
        </ErrorLogEntry>
      )

    case 'clsi-unavailable':
      return (
        <ErrorLogEntry title={t('server_error')}>
          {t('clsi_unavailable')}
        </ErrorLogEntry>
      )

    // FIXED: 2026-11-11 并发满载不是错误，是「编译器忙」。
    // 用 warning 而不是 error 级别：用户不该以为编译失败了，
    // 也不该看到红叉（服务本身是好的，只是两个编译槽位都占着）。
    // 标题复用已有的 pdf_compile_try_again（"请等待其他项目编译完成后再试"），
    // 它本来就是为「编译槽位被占」这个场景写的。
    case 'clsi-overloaded':
      return (
        <PdfLogEntry
          headerTitle={t('pdf_compile_try_again')}
          formattedContent={t('clsi_overloaded')}
          level="warning"
        />
      )

    case 'too-recently-compiled':
      return (
        <ErrorLogEntry title={t('server_error')}>
          {t('too_recently_compiled')}
        </ErrorLogEntry>
      )

    case 'terminated':
      return (
        <ErrorLogEntry title={t('terminated')}>
          {t('compile_terminated_by_user')}
        </ErrorLogEntry>
      )

    case 'rate-limited':
      return (
        <ErrorLogEntry title={t('pdf_compile_rate_limit_hit')}>
          {t('project_flagged_too_many_compiles')}
        </ErrorLogEntry>
      )

    case 'compile-in-progress':
      return (
        <ErrorLogEntry title={t('pdf_compile_in_progress_error')}>
          {t('pdf_compile_try_again')}
        </ErrorLogEntry>
      )

    case 'auto-compile-disabled':
      return (
        <ErrorLogEntry title={t('autocompile_disabled')}>
          {t('autocompile_disabled_reason')}
        </ErrorLogEntry>
      )

    case 'project-too-large':
      return (
        <ErrorLogEntry title={t('project_too_large')}>
          {t('project_too_much_editable_text')}
        </ErrorLogEntry>
      )

    case 'timedout':
      return <TimedOutLogEntry />

    case 'failure':
      return (
        <ErrorLogEntry title={t('no_pdf_error_title')}>
          {t('no_pdf_error_explanation')}

          <ul className="log-entry-formatted-content-list">
            <li>{t('no_pdf_error_reason_unrecoverable_error')}</li>
            <li>
              <Trans
                i18nKey="no_pdf_error_reason_no_content"
                components={{ code: <code /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="no_pdf_error_reason_output_pdf_already_exists"
                components={{ code: <code /> }}
              />
            </li>
          </ul>
        </ErrorLogEntry>
      )

    case 'clear-cache':
      return (
        <ErrorLogEntry title={t('server_error')}>
          {t('somthing_went_wrong_compiling')}
        </ErrorLogEntry>
      )

    case 'pdf-viewer-loading-error':
      return (
        <ErrorLogEntry title={t('pdf_rendering_error')}>
          <Trans
            i18nKey="something_went_wrong_loading_pdf_viewer"
            components={[
              <strong key="strong-" />,
              // eslint-disable-next-line jsx-a11y/anchor-has-content
              <a
                href="/help#help-pdf"
                target="_blank" rel="noopener"
                key="troubleshooting-link"
              />,
              // eslint-disable-next-line jsx-a11y/anchor-has-content
              <a key="contact-link" target="_blank" href="/contact" />,
            ]}
          />
        </ErrorLogEntry>
      )

    case 'validation-problems':
      return null // handled elsewhere

    case 'error':
    default:
      return (
        <ErrorLogEntry title={t('server_error')}>
          {t('somthing_went_wrong_compiling')}
        </ErrorLogEntry>
      )
  }
}

PdfPreviewError.propTypes = {
  error: PropTypes.string.isRequired,
}

export default memo(PdfPreviewError)

function ErrorLogEntry({ title, headerIcon, children }) {
  const { t } = useTranslation()

  return (
    <PdfLogEntry
      headerTitle={title}
      headerIcon={headerIcon}
      formattedContent={children}
      entryAriaLabel={t('compile_error_entry_description')}
      level="error"
    />
  )
}
ErrorLogEntry.propTypes = {
  title: PropTypes.string.isRequired,
  headerIcon: PropTypes.element,
  children: PropTypes.any.isRequired,
}

function TimedOutLogEntry() {
  const { t } = useTranslation()
  const { enableStopOnFirstError } = useStopOnFirstError({
    eventSource: 'timeout',
  })
  const { startCompile, lastCompileOptions, setAnimateCompileDropdownArrow } =
    useCompileContext()

  // FIXED: 2026-11-03 超时提示要说明「撞到了多久的上限」，
  //   否则用户只看到「编译超时」，不知道自己是 5 分钟档还是 10 分钟档，
  //   也就不知道升级能不能解决问题。配额取 ol-user.features.compileTimeout，
  //   和设置页 UsageSection 展示的是同一份数据。
  // OLD: 只有一句「编译运行时间过长，已超时」
  const user = getMeta('ol-user') || {}
  const compileTimeout = user.features?.compileTimeout || 300
  const limitMinutes = Math.max(1, Math.round(compileTimeout / 60))
  const upgradeMinutes = 10
  const canExtendTimeout = compileTimeout < upgradeMinutes * 60

  const handleEnableStopOnFirstErrorClick = useCallback(() => {
    enableStopOnFirstError()
    startCompile({ stopOnFirstError: true })
    setAnimateCompileDropdownArrow(true)
  }, [enableStopOnFirstError, startCompile, setAnimateCompileDropdownArrow])

  return (
    <ErrorLogEntry title={t('timedout')}>
      <p>{t('project_timed_out_reached_limit', { minutes: limitMinutes })}</p>
      {canExtendTimeout && (
        <p>
          {t('project_timed_out_upgrade_for_more_time', {
            minutes: upgradeMinutes,
          })}
        </p>
      )}
      <p>{t('project_timed_out_reasons_intro')}</p>
      <ul>
        <li>
          <Trans
            i18nKey="project_timed_out_optimize_images"
            components={[<strong key="b" />]}
          />
        </li>
        <li>
          <Trans
            i18nKey="project_timed_out_fatal_error"
            components={[<strong key="b" />]}
          />
          {!lastCompileOptions.stopOnFirstError && (
            <>
              {' '}
              <Trans
                i18nKey="project_timed_out_enable_stop_on_first_error"
                components={[
                  // eslint-disable-next-line react/jsx-key
                  <Button
                    bsSize="xs"
                    bsStyle="info"
                    onClick={handleEnableStopOnFirstErrorClick}
                  />,
                ]}
              />{' '}
            </>
          )}
        </li>
      </ul>
      <p>
        <Trans
          i18nKey="project_timed_out_learn_more"
          components={[<a href="/help#help-timeout" target="_blank" rel="noopener" key="a" />]}
        />
      </p>
    </ErrorLogEntry>
  )
}
TimedOutLogEntry.propTypes = {}
