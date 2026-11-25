import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dropdown, MenuItem } from 'react-bootstrap'
import Icon from '../../../shared/components/icon'

function EditMenu() {
  const { t } = useTranslation()
  const [copySuccess, setCopySuccess] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      const selection = window.getSelection()
      if (selection && selection.toString()) {
        await navigator.clipboard.writeText(selection.toString())
        setCopySuccess(true)
        setTimeout(() => setCopySuccess(false), 2000)
      }
    } catch (err) {
      console.error('Copy failed:', err)
    }
  }, [])

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      window.dispatchEvent(
        new CustomEvent('editor:paste', { detail: { text } })
      )
    } catch (err) {
      console.error('Paste failed:', err)
    }
  }, [])

  return (
    <Dropdown id="ide-menu-edit" pullRight className="ide-menu-dropdown">
      <Dropdown.Toggle noCaret className="ide-menu-toggle">
        {t('edit')}
      </Dropdown.Toggle>
      <Dropdown.Menu className="ide-menu-dropdown-menu">
        <MenuItem onClick={handleCopy}>
          <Icon type="copy" fw /> {copySuccess ? t('copied') : t('copy')}
          <span className="ide-menu-shortcut">Ctrl+C</span>
        </MenuItem>
        <MenuItem onClick={handlePaste}>
          <Icon type="paste" fw /> {t('paste')}
          <span className="ide-menu-shortcut">Ctrl+V</span>
        </MenuItem>
      </Dropdown.Menu>
    </Dropdown>
  )
}

export default EditMenu
