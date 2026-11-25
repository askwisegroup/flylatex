const _ = require('lodash')
const settings = require('@overleaf/settings')

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"

// FIXED: 2026-11-19 邮件模板改版：
//   - 扁平化、无阴影/渐变，600px 自适应，移动端单列
//   - 支持 prefers-color-scheme: dark（深色模式下文字不再白底白字）
//   - 所有链接 target="_blank"，避免点链接后把邮件本身顶掉
//   - 表格布局 + 内联样式，兼容 Outlook / Gmail / Apple Mail
module.exports = _.template(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${_.escape(settings.appName)}</title>
<style>
  body { margin: 0; padding: 0; }
  table { border-collapse: collapse; }
  a { text-decoration: none; }
  .email-text a { color: #15803d; text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    .email-bg { background-color: #0b0f14 !important; }
    .email-card { background-color: #141922 !important; border-color: #232a35 !important; }
    .email-title { color: #f9fafb !important; }
    .email-text, .email-text p, .email-text div, .email-text span { color: #e5e7eb !important; }
    .email-muted { color: #9ca3af !important; }
    .email-footer { color: #9ca3af !important; }
    .email-link { color: #4ade80 !important; }
    .email-code { background-color: #0f141b !important; color: #f3f4f6 !important; border-color: #232a35 !important; }
  }
  @media (max-width: 620px) {
    .email-container { width: 100% !important; }
    .email-card { padding: 24px 20px !important; border-radius: 12px !important; }
    .email-title { font-size: 20px !important; }
    .email-button a { text-align: center !important; }
    .email-footer { padding-left: 8px !important; padding-right: 8px !important; }
  }
</style>
</head>
<body class="email-bg" style="margin: 0; padding: 0; background: #f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-bg" style="background: #f3f4f6;">
  <tr>
    <td align="center" style="padding: 28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-container" style="width: 600px; max-width: 600px;">
        <tr>
          <td align="left" style="padding: 0 4px 16px 4px;">
            <span class="email-title" style="font-family: ${FONT}; font-size: 18px; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; color: #111827;">
              ${_.escape(settings.appName)}
            </span>
          </td>
        </tr>
        <tr>
          <td class="email-card" style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 32px; font-family: ${FONT};">
            <%= body %>
          </td>
        </tr>
        <tr>
          <td class="email-footer" align="left" style="padding: 20px 6px 0 6px; font-family: ${FONT}; font-size: 12px; line-height: 1.6; color: #6b7280;">
            ${
              settings.email &&
              settings.email.template &&
              settings.email.template.customFooter
                ? `${settings.email.template.customFooter}<br>`
                : ''
            }
            ${_.escape(settings.appName)} &middot;
            <a href="${
              settings.siteUrl
            }" target="_blank" rel="noopener noreferrer" class="email-link" style="color: #15803d; text-decoration: none;">${
  settings.siteUrl
}</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<!-- 阻止 Gmail iOS 自动放大字体 -->
<div style="display: none; white-space: nowrap; font: 15px courier; line-height: 0;">
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
</div>
</body>
</html>`)
