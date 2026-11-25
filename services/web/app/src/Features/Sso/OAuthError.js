'use strict'

/**
 * FlyLaTeX SSO · OAuth2 标准错误
 *
 * 形状见 RFC 6749 §5.2：
 *
 *     400 { "error": "invalid_grant", "error_description": "…" }
 *
 * `error` 只能是标准词表里的值 —— 下游（含第三方 SDK）会按字符串匹配来
 * 决定是「重新走一遍授权」还是「报错给用户」，自定义词会让它们全部走错分支。
 *
 * status 单列出来，是因为 `invalid_client` 按 RFC 6749 §5.2 **必须**是 401，
 * 其余基本是 400。混用会让一部分客户端库直接抛网络层异常。
 */
class OAuthError extends Error {
  /**
   * @param {string} code  标准 error 值
   * @param {string} [description] 给人看的一句话（不要放内部堆栈/ID）
   * @param {number} [status] HTTP 状态码
   */
  constructor(code, description, status = 400) {
    super(description || code)
    this.name = 'OAuthError'
    this.code = code
    this.description = description
    this.status = status
  }

  toJSON() {
    const body = { error: this.code }
    if (this.description) body.error_description = this.description
    return body
  }
}

module.exports = OAuthError
