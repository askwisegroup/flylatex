import { useTranslation } from 'react-i18next'

type LoadingBrandedTypes = {
  loadProgress: number // Percentage
  label?: string
  error?: string | null
}

export default function LoadingBranded({
  loadProgress,
  label,
  error,
}: LoadingBrandedTypes) {
  const { t } = useTranslation()
  return (
    <div className="loading-screen-brand-container">
      {/*
        FIXED: 2026-11-02 动画交给 CSS（@keyframes fl-brand-rise 无限循环），
        组件不再往内联样式里塞进度 —— 之前那种写法一依赖前端 bundle、二在
        进度到 100% 后动画就停了。进度值保留成 data 属性，排查时看得见。
      */}
      <div className="loading-screen-brand" data-load-progress={loadProgress} />
      {error ? (
        <p className="loading-screen-error">{error}</p>
      ) : true ? (
        <></>
      ) : (
        <div className="h3 loading-screen-label" aria-live="polite">
          {label || t('loading')}
          <span className="loading-screen-ellip" aria-hidden="true">
            .
          </span>
          <span className="loading-screen-ellip" aria-hidden="true">
            .
          </span>
          <span className="loading-screen-ellip" aria-hidden="true">
            .
          </span>
        </div>
      )}
    </div>
  )
}
