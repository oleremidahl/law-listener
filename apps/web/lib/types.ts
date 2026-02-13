import type { PROPOSAL_STATUSES } from "@/lib/constants"

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
export type ProposalStatusFilter = ProposalStatus | "all"

export interface ListQuery {
  q: string
  status: ProposalStatusFilter
  from: string | null
  to: string | null
  page: number
  pageSize: number
}

export interface ProposalListItem {
  id: string
  title: string
  feed_description: string | null
  status: ProposalStatus
  decision_date: string | null
  enforcement_date: string | null
  stortinget_link: string | null
  lovdata_link: string | null
}

export interface ProposalDetail {
  id: string
  title: string
  status: ProposalStatus
  decision_date: string | null
  enforcement_date: string | null
  feed_description: string | null
  stortinget_link: string | null
  lovdata_link: string | null
}

export type ProposalSummaryPayload = string

export type ProposalSummaryStatus = "missing" | "pending" | "ready" | "failed"

export interface ProposalSummaryState {
  status: ProposalSummaryStatus
  data: ProposalSummaryPayload | null
  generated_at: string | null
  next_retry_at: string | null
}

export interface LinkedDocument {
  id: string
  dokid: string
  legacy_id: string | null
  title: string
  short_title: string | null
  document_type: string
}

export interface PaginationMeta {
  page: number
  pageSize: number
  totalPages: number
  totalCount: number
}

export interface ProposalListResponse {
  items: ProposalListItem[]
  pagination: PaginationMeta
}

export interface ProposalDetailResponse {
  proposal: ProposalDetail
  linkedDocuments: LinkedDocument[]
  summary: ProposalSummaryState
}

export interface ApiError {
  error: string
}

export type ProposalSummaryTriggerStatus =
  | "started"
  | "pending"
  | "already_ready"
  | "cooldown"
  | "failed"

export interface ProposalSummaryTriggerResponse {
  status: ProposalSummaryTriggerStatus
  request_id?: string
  proposal_id?: string
  summary_id?: string
}
