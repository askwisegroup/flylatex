const _ = require('lodash')

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"

// FIXED: 2026-11-19 扁平化无 CTA 模板：深色模式可读、移动端自适应、验证码等高亮块清晰
module.exports =
  _.template(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td>
      <% if (title) { %>
        <h1 class="email-title" style="margin: 0 0 16px 0; font-family: ${FONT}; font-size: 24px; font-weight: 700; line-height: 1.35; letter-spacing: -0.01em; color: #111827;">
          <%= title %>
        </h1>
      <% } %>

      <div class="email-text" style="font-family: ${FONT}; font-size: 16px; line-height: 1.65; color: #374151;">
        <% if (greeting) { %>
          <p class="force-overleaf-style" style="margin: 0 0 12px 0;"><%= greeting %></p>
        <% } %>
        <% (message).forEach(function(paragraph) { %>
          <p class="force-overleaf-style" style="margin: 0 0 12px 0;"><%= paragraph %></p>
        <% }) %>
      </div>

      <% if (highlightedText) { %>
        <div class="email-code" style="margin: 20px 0 0 0; padding: 16px 12px; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 10px; text-align: center; font-family: ${FONT}; font-size: 28px; font-weight: 700; letter-spacing: 0.18em; line-height: 1.2; color: #111827;">
          <%= highlightedText %>
        </div>
      <% } %>
    </td>
  </tr>
</table>
`)
