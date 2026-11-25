import React from 'react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import Tooltip from '../../../shared/components/tooltip'
import Icon from '../../../shared/components/icon'

function AIChatToggleButton({ aiChatIsOpen, onClick }) {
    const { t } = useTranslation()

    return (
        <Tooltip
            description={t('ai_chat')}
            id="ai-chat-toggle-tooltip"
            overlayProps={{ placement: 'bottom' }}
        >
            <button
                className="toolbar-btn toolbar-btn-ai-chat toolbar-label"
                aria-label={t('ai_chat')}
                onClick={onClick}
                aria-pressed={aiChatIsOpen}
                style={{
                    width: 80,
                    border: 'none',
                    paddingTop: 6,
                }}
            >
                <Icon type={aiChatIsOpen ? 'ai-chat-active fa-paper-plane-o' : 'ai-chat fa-paper-plane-o'} />
                <span className="toolbar-label">&nbsp;AI对话</span>
            </button>
        </Tooltip>
    )
}

AIChatToggleButton.propTypes = {
    aiChatIsOpen: PropTypes.bool,
    onClick: PropTypes.func.isRequired,
}

export default AIChatToggleButton 