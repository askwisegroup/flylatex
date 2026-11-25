import { useState } from 'react'
import { ControlLabel, FormControl, FormGroup } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import getMeta from '../../../utils/meta'
import { applyLanguagePreference } from '../../../shared/utils/language-preference'

// FIXED: 2026-11-20 设置页「默认语言」区块（替换掉原来那块不允许使用的「更换密码」）。
//
// 语言清单：ol-languageOptions 由 settings.pug 从 Translations.js 的
// languageOptions 渲染过来（就是页脚选择器用的那份），站内能切的语言和这里
// 能选的语言永远是同一组。
//
// 切换动作：交给 layout-base.pug 里的 setLanguage（window.flylatexSetLanguage），
// 由它写 cookie + localStorage 再刷新 —— 服务端才读得到。之前设置页自己拼
// cookie 名，和模板写的不是同一个，导致「切了完全没反应」。

type LanguageOptions = Array<{ code: string; label: string }>

function readOptions(): LanguageOptions {
  const options = getMeta('ol-languageOptions') as LanguageOptions | undefined
  if (!Array.isArray(options)) return []
  return options.filter(option => option && option.code)
}

function LanguageSection() {
  const { t } = useTranslation()
  const options = readOptions()
  // 当前语言一律以服务端渲染值为准：页面文字就是它渲染出来的，不会看错
  const serverLanguage = (getMeta('ol-currentLanguage') as string) || ''
  const [value, setValue] = useState(
    options.some(option => option.code === serverLanguage)
      ? serverLanguage
      : options[0]?.code || ''
  )
  const [failed, setFailed] = useState(false)

  // 拿不到语言清单时整块不渲染，免得留一个空下拉框
  if (options.length === 0) return null

  const handleChange = (code: string) => {
    if (applyLanguagePreference(code)) {
      // setLanguage 自己会 reload，这里不用再做什么
      setValue(code)
      setFailed(false)
      return
    }
    // 语言切换脚本没加载（例如内联脚本被策略拦掉）：明确告诉用户去页脚切
    setFailed(true)
  }

  return (
    <>
      <h3>{t('default_language')}</h3>
      <FormGroup controlId="default-language-select">
        <ControlLabel>{t('language')}</ControlLabel>
        <FormControl
          componentClass="select"
          value={value}
          onChange={event =>
            handleChange((event.target as HTMLSelectElement).value)
          }
        >
          {options.map(option => (
            <option value={option.code} key={option.code} lang={option.code}>
              {option.label}
            </option>
          ))}
        </FormControl>
        {failed ? (
          <p className="help-block text-danger">
            {t('default_language_failed')}
          </p>
        ) : (
          <p className="help-block">{t('default_language_hint')}</p>
        )}
      </FormGroup>
    </>
  )
}

export default LanguageSection
