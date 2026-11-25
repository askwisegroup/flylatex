import { SortingOrder } from '../../sorting-order'
import { MergeAndOverride } from '../../utils'

export type Page = {
  size: number
  lastId?: string
}

export type Sort = {
  by: 'lastUpdated' | 'title' | 'owner'
  order: SortingOrder
}

export type Filters = {
  ownedByUser?: boolean
  sharedWithUser?: boolean
  archived?: boolean
  trashed?: boolean
  tag?: string | null
  search?: string
}

export type GetProjectsRequestBody = {
  page: Page
  sort: Sort
  filters: Filters
}

export type UserRef = {
  id: string
  email: string
  firstName: string
  lastName: string
}

export type ProjectApi = {
  id: string
  name: string
  owner?: UserRef
  lastUpdated: Date
  lastUpdatedBy: UserRef | null
  archived: boolean
  trashed: boolean
  accessLevel: 'owner' | 'readWrite' | 'readOnly' | 'readAndWrite'
  source: 'owner' | 'invite' | 'token'
  // 2026-11 项目已关联 Git 仓库（列表里显示分支图标）。
  // 老数据 / 接口未返回时按 false 处理。
  gitLinked?: boolean
  // FIXED: 2026-11-14 「您共享的」过滤器用：自己项目的链接分享状态。
  // 只有 accessLevel === 'owner' 的项目才带这个字段。
  publicAccessLevel?: 'private' | 'tokenBased' | 'readOnly' | 'readAndWrite'
  // 最近一次打开分享的日期（YYYY-MM-DD），取审计日志；没有记录时为 null
  sharedAt?: string | null
}

export type Project = MergeAndOverride<
  ProjectApi,
  {
    lastUpdated: string
    selected?: boolean
  }
>

export type GetProjectsResponseBody = {
  totalSize: number
  projects: Project[]
}

export type ClonedProject = {
  project_id: string
  name: string
  lastUpdated: string
  owner: {
    _id: string
    email: string
    first_name: string
    last_name: string
  }
}
