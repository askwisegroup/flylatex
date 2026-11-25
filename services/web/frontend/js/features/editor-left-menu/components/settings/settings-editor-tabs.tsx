import { useEffect, useState } from 'react'
import SettingsMenuSelect from './settings-menu-select'
import {
  isTabsEnabled,
  setTabsEnabled,
  subscribeTabs,
} from '@/features/editor-tabs/editor-tabs-store'

/**
 * FIXED: 2026-11-16 「显示文件页签」（设置 → 编辑器）
 *
 * 为什么不走 useProjectSettingsContext / User.ace：
 *   那条链路要改 5 个服务端文件（UserController / AuthenticationController /
 *   ProjectController / ExpressLocals / models/User）+ 3 个语言包 + 白名单，
 *   为一个纯显示层开关不值当。这里存在浏览器本地（与页签列表同一套 localStorage），
 *   代价是换设备不同步 —— 页签本身就是「这台机器上打开了哪些文件」，口径一致。
 *
 * 文案直接用中文：这个设置项只服务 zh-CN 用户，走 i18n 要动 8 个语言包与白名单。
 */
export default function SettingsEditorTabs() {
  const [, setVersion] = useState(0)

  // 页签栏右端的收起按钮也会改这个开关，这里订阅一下保证下拉不残留旧值
  useEffect(() => subscribeTabs(() => setVersion(version => version + 1)), [])

  return (
    <SettingsMenuSelect<boolean>
      onChange={setTabsEnabled}
      value={isTabsEnabled()}
      options={[
        { value: true, label: '显示' },
        { value: false, label: '隐藏' },
      ]}
      label="文件页签"
      name="editorTabs"
    />
  )
}
