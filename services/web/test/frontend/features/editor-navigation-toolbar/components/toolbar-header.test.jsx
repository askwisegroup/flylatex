import { expect } from 'chai'
import { screen } from '@testing-library/react'

import ToolbarHeader from '../../../../../frontend/js/features/editor-navigation-toolbar/components/toolbar-header'
import { renderWithEditorContext } from '../../../helpers/render-with-context'

describe('<ToolbarHeader />', function () {
  const defaultProps = {
    onShowLeftMenuClick: () => {},
    toggleChatOpen: () => {},
    toggleReviewPanelOpen: () => {},
    toggleHistoryOpen: () => {},
    unreadMessageCount: 0,
    onlineUsers: [],
    goToUser: () => {},
    projectName: 'test project',
    renameProject: () => {},
    openShareModal: () => {},
    hasPublishPermissions: true,
    trackChangesVisible: true,
    handleChangeLayout: () => {},
    pdfLayout: 'sideBySide',
    view: 'editor',
    reattach: () => {},
    detach: () => {},
  }

  describe('cobranding logo', function () {
    it('is not displayed by default', function () {
      renderWithEditorContext(<ToolbarHeader {...defaultProps} />)
      expect(screen.queryByRole('link', { name: 'variation' })).to.not.exist
    })

    it('is displayed when cobranding data is available', function () {
      const props = {
        ...defaultProps,
        cobranding: {
          brandVariationHomeUrl: 'http://cobranding',
          brandVariationName: 'variation',
          logoImgUrl: 'http://cobranding/logo',
        },
      }
      renderWithEditorContext(<ToolbarHeader {...props} />)
      screen.getByRole('link', { name: 'variation' })
    })
  })

  describe('track changes toggle button', function () {
    // FIXED: 2026-11-19 「审阅」现在有两个入口（顶栏按钮 + 工具菜单项），
    // 用 queryAllByText 断言存在性，避免 getByText 因重复元素报错。
    it('is displayed by default', function () {
      renderWithEditorContext(<ToolbarHeader {...defaultProps} />)
      expect(screen.queryAllByText('Review')).to.have.length.greaterThan(0)
    })

    it('is not displayed when "isRestrictedTokenMember" prop is set to true', function () {
      const props = {
        ...defaultProps,
        isRestrictedTokenMember: true,
      }
      renderWithEditorContext(<ToolbarHeader {...props} />)
      expect(screen.queryAllByText('Review')).to.have.length(0)
    })

    it('is not displayed when "trackChangesVisible" prop is set to false', function () {
      const props = {
        ...defaultProps,
        trackChangesVisible: false,
      }
      renderWithEditorContext(<ToolbarHeader {...props} />)
      expect(screen.queryAllByText('Review')).to.have.length(0)
    })
  })

  describe('History toggle button', function () {
    it('is displayed by default', function () {
      renderWithEditorContext(<ToolbarHeader {...defaultProps} />)
      screen.getByText('History')
    })

    it('is not displayed when "isRestrictedTokenMember" prop is set to true', function () {
      const props = {
        ...defaultProps,
        isRestrictedTokenMember: true,
      }
      renderWithEditorContext(<ToolbarHeader {...props} />)
      expect(screen.queryByText('History')).to.not.exist
    })
  })

  describe('Chat toggle button', function () {
    // FIXED: 2026-11-19 顶栏聊天按钮已于 2026-02 移除，聊天入口回到「工具 → 聊天」，
    // 断言对象随之改成菜单项（同样受 restricted token 限制）。
    it('is displayed by default', function () {
      renderWithEditorContext(<ToolbarHeader {...defaultProps} />)
      expect(screen.queryAllByText('Chat')).to.have.length.greaterThan(0)
    })

    it('is not displayed when "isRestrictedTokenMember" prop is set to true', function () {
      const props = {
        ...defaultProps,
        isRestrictedTokenMember: true,
      }
      renderWithEditorContext(<ToolbarHeader {...props} />)
      expect(screen.queryAllByText('Chat')).to.have.length(0)
    })
  })

  describe('tools menu', function () {
    // FIXED: 2026-11-19 审阅 / 共享原来只有顶栏按钮，聊天只剩语义不明的「合作」项。
    // 这里固定住「工具」菜单里的三个入口，避免以后再被删掉。
    it('contains chat, review and share entries', function () {
      renderWithEditorContext(<ToolbarHeader {...defaultProps} />)
      // 用 ^Chat 精确匹配「工具 → 聊天」，避免命中 AI 菜单的「Open Chat」
      expect(screen.getByRole('menuitem', { name: /^Chat/ })).to.exist
      expect(screen.getByRole('menuitem', { name: /Review/ })).to.exist
      expect(screen.getByRole('menuitem', { name: /Share/ })).to.exist
    })
  })

  describe('Publish button', function () {
    it('is displayed by default', function () {
      renderWithEditorContext(<ToolbarHeader {...defaultProps} />)
      screen.getByText('Submit')
    })

    it('is not displayed for users with no publish permissions', function () {
      const props = {
        ...defaultProps,
        hasPublishPermissions: false,
      }
      renderWithEditorContext(<ToolbarHeader {...props} />)
      expect(screen.queryByText('Submit')).to.not.exist
    })
  })
})
