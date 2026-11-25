const PrivilegeLevels = {
  NONE: false,
  READ_ONLY: 'readOnly',
  // FIXED: 2026-11 新增「评审者」档：可读 + 可评论（行内批注），不可编辑正文。
  // 补齐 Overleaf Pro 的 reviewer 语义 —— 此前只有 readOnly / readAndWrite 两档，
  // 只读成员被前端 PermissionsManager 顺带赋予了评论权（见 PermissionsManager.js 的 FIXED 注释）。
  REVIEW: 'review',
  READ_AND_WRITE: 'readAndWrite',
  OWNER: 'owner',
}

module.exports = PrivilegeLevels
