import { useTranslation } from 'react-i18next'
import ZoteroConfig from '@/features/settings/components/zotero-config'

/**
 * FIXED: 2026-11-16 设置 → 系统集成 → Zotero 文献库。
 *
 * 与账号设置页那一节共用 zotero-config.tsx（同一份状态机/表单）。
 * 排版对齐 AMiner 那一项：同样的 form-group + label + 说明，避免「AMiner 有标头、
 * Zotero 只有一行输入框」的观感不一致。
 */
export default function SettingsZotero() {
  const { t } = useTranslation()

  return (
    <div className="form-group left-menu-setting">
      <label htmlFor="settings-menu-zotero">
        {t('settings_zotero_label', { defaultValue: 'Zotero 文献库' })}
      </label>

      <div className="settings-aminer-search">
        <p className="settings-aminer-hint">
          {t('settings_zotero_hint', {
            defaultValue:
              '在自己的 Zotero 文献库里搜索条目，选中即写入项目 .bib 并插入 \\cite；也可以整库/按分类导入。',
          })}
        </p>

        <ZoteroConfig showHint={false} />
      </div>
    </div>
  )
}
