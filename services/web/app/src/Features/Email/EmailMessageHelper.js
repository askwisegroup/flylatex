const sanitizeHtml = require('sanitize-html')
const sanitizeOptions = {
  html: {
    allowedTags: ['span', 'b', 'br', 'i'],
    allowedAttributes: {
      span: ['style', 'class'],
    },
  },
  plainText: {
    allowedTags: [],
    allowedAttributes: {},
  },
}

function cleanHTML(text, isPlainText) {
  if (!isPlainText) return sanitizeHtml(text, sanitizeOptions.html)
  return sanitizeHtml(text, sanitizeOptions.plainText)
}

function displayLink(text, url, isPlainText) {
  // FIXED: 2026-11-19 邮件正文链接新窗口打开，避免点链接后离开邮件
  return isPlainText
    ? `${text} (${url})`
    : `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
}

module.exports = {
  cleanHTML,
  displayLink,
}
