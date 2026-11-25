const _ = require('lodash')

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"

// FIXED: 2026-11-19 扁平化 CTA 模板：全宽按钮、链接新窗口打开、移动端可点、深色模式可读
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

      <table role="presentation" class="email-button" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0 0 0;">
        <tr>
          <td align="center" bgcolor="#15803d" style="border-radius: 10px;">
            <a href="<%= ctaURL %>" target="_blank" rel="noopener noreferrer" style="display: block; padding: 14px 24px; font-family: ${FONT}; font-size: 16px; font-weight: 600; line-height: 1.2; color: #ffffff; text-align: center; text-decoration: none; border-radius: 10px;">
              <%= ctaText %>
            </a>
          </td>
        </tr>
      </table>

      <% if (secondaryMessage && secondaryMessage.length > 0) { %>
        <div class="email-text" style="margin: 24px 0 0 0; font-family: ${FONT}; font-size: 14px; line-height: 1.65; color: #6b7280;">
          <% (secondaryMessage).forEach(function(paragraph) { %>
            <p class="force-overleaf-style" style="margin: 0 0 8px 0;"><%= paragraph %></p>
          <% }) %>
        </div>
      <% } %>

      <p class="email-muted force-overleaf-style" style="margin: 24px 0 0 0; font-family: ${FONT}; font-size: 12px; line-height: 1.6; color: #6b7280;">
        If the button above doesn't work, copy and paste this link into your browser:
      </p>
      <p class="force-overleaf-style" style="margin: 6px 0 0 0; font-family: ${FONT}; font-size: 12px; line-height: 1.6; word-break: break-all; color: #15803d;">
        <a href="<%= ctaURL %>" target="_blank" rel="noopener noreferrer" class="email-link" style="color: #15803d; text-decoration: underline;"><%= ctaURL %></a>
      </p>
    </td>
  </tr>
</table>
<% if (gmailGoToAction) { %>
  <script type="application/ld+json">
    <%= JSON.stringify({ "@context": "http://schema.org", "@type": "EmailMessage", potentialAction: { "@type": "ViewAction", target: gmailGoToAction.target, name: gmailGoToAction.name } }) %>
  </script>
<% } %>
`)
