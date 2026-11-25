import { Form } from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import getMeta from '../../../utils/meta'
import { settingsGroups } from './settings-groups'

/**
 * 左侧面板里的设置列表。
 *
 * FIXED: 2026-11-01
 * 改成按 settings-groups 拍平渲染，但顺序与原来的手写列表完全一致，
 * 所以默认（左侧面板）模式的 DOM 和行序都没有变化。
 */
export default function SettingsMenu() {
  const { t } = useTranslation()
  const anonymous = getMeta('ol-anonymous') as boolean | undefined

  if (anonymous === true || anonymous === undefined) {
    return null
  }

  return (
    <>
      <h4>{t('settings')}</h4>
      <Form className="settings">
        {settingsGroups.flatMap(({ id, items }) =>
          items.map((Item, index) => <Item key={`${id}-${index}`} />)
        )}
      </Form>
    </>
  )
}
