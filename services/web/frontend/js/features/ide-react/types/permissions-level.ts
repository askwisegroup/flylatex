export type PermissionsLevel = 'owner' | 'readAndWrite' | 'review' | 'readOnly'

/**
 * FIXED: 2026-11 新增 `review`（评审者）档后，**不要再用 `!== 'readOnly'` 判断能不能改稿**。
 *
 * 原因：`permissionsLevel !== 'readOnly'` 对 `review` 会返回 true，等于把编辑权限
 * 白送给了评审者 —— 这类写法在本仓库原有 7 处（编辑器 editable、主文档/编译器设置、
 * metadata POST、文件视图等）。凡是「能不能写」的判断统一走 `canEditContent`。
 */
export function canEditContent(permissionsLevel?: PermissionsLevel): boolean {
  return (
    permissionsLevel === 'owner' || permissionsLevel === 'readAndWrite'
  )
}

/** 能不能评论（发/改/删批注、解决讨论）：可写的人 + 评审者 */
export function canCommentOnProject(
  permissionsLevel?: PermissionsLevel
): boolean {
  return (
    permissionsLevel === 'owner' ||
    permissionsLevel === 'readAndWrite' ||
    permissionsLevel === 'review'
  )
}
