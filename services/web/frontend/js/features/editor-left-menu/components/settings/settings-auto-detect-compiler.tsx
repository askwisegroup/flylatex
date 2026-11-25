import { useTranslation } from 'react-i18next'
import { useProjectSettingsContext } from '../../context/project-settings-context'
import SettingsMenuSelect from './settings-menu-select'

/**
 * FIXED: 2026-11-02 自动探测编译器（用户级，跟账号走）
 *
 * 打开后：编译失败时后端读本次构建的 output.log，如果报错明确说文档需要
 * XeTeX / LuaTeX（fontspec / ctex / xeCJK / unicode-math / luacode …），
 * 就把这个项目的编译器切过去并重编译一次，前端弹一条轻提示。
 * 关掉则完全不介入，行为和以前一致。
 * FIXED: 2026-11 默认值改成「开启」：后端对「字段缺失」也按开启处理，
 * 前端如果还显示「关闭」，用户会以为没生效。
 */
export default function SettingsAutoDetectCompiler() {
  const { t } = useTranslation()
  const { autoDetectCompiler, setAutoDetectCompiler } =
    useProjectSettingsContext()

  return (
    <SettingsMenuSelect<boolean>
      onChange={setAutoDetectCompiler}
      value={autoDetectCompiler ?? true}
      options={[
        {
          value: true,
          label: t('on'),
        },
        {
          value: false,
          label: t('off'),
        },
      ]}
      label={t('auto_detect_compiler')}
      name="autoDetectCompiler"
    />
  )
}
