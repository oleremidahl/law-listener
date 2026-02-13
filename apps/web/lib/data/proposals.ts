import { getOffset, getTotalPages } from "@/lib/pagination"
import { createSupabaseServerClient } from "@/lib/supabase-server"
import type {
  LinkedDocument,
  ListQuery,
  ProposalDetail,
  ProposalDetailResponse,
  ProposalListItem,
  ProposalListResponse,
  ProposalSummaryPayload,
  ProposalSummaryState,
} from "@/lib/types"

function createListError(message: string, details: unknown): Error {
  console.error(message, details)
  return new Error(message)
}

export async function listProposals(query: ListQuery): Promise<ProposalListResponse> {
  const supabase = createSupabaseServerClient()

  const start = getOffset(query.page, query.pageSize)
  const end = start + query.pageSize - 1

  let countStatement = supabase
    .from("law_proposals")
    .select("id", { count: "exact", head: true })

  if (query.q) {
    countStatement = countStatement.ilike("feed_description", `%${query.q}%`)
  }

  if (query.status !== "all") {
    countStatement = countStatement.eq("status", query.status)
  }

  if (query.from) {
    countStatement = countStatement.gte("decision_date", query.from)
  }

  if (query.to) {
    countStatement = countStatement.lte("decision_date", query.to)
  }

  const { count, error: countError } = await countStatement

  if (countError) {
    throw createListError("Could not fetch proposals count", countError)
  }

  const totalCount = count ?? 0
  const totalPages = getTotalPages(totalCount, query.pageSize)

  // Avoid high-offset data queries when page is outside the available range.
  if (totalCount === 0 || start >= totalCount) {
    return {
      items: [],
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalCount,
        totalPages,
      },
    }
  }

  let statement = supabase
    .from("law_proposals")
    .select(
      "id,title,feed_description,status,decision_date,enforcement_date,stortinget_link,lovdata_link,created_at"
    )
    .order("decision_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(start, end)

  if (query.q) {
    statement = statement.ilike("feed_description", `%${query.q}%`)
  }

  if (query.status !== "all") {
    statement = statement.eq("status", query.status)
  }

  if (query.from) {
    statement = statement.gte("decision_date", query.from)
  }

  if (query.to) {
    statement = statement.lte("decision_date", query.to)
  }

  const { data, error } = await statement

  if (error) {
    throw createListError("Could not fetch proposals", error)
  }

  const items: ProposalListItem[] = (data ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    feed_description: item.feed_description,
    status: item.status,
    decision_date: item.decision_date,
    enforcement_date: item.enforcement_date,
    stortinget_link: item.stortinget_link,
    lovdata_link: item.lovdata_link,
  }))

  return {
    items,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalCount,
      totalPages,
    },
  }
}

function isNotFoundError(error: { code?: string } | null): boolean {
  return Boolean(error?.code && ["PGRST116", "PGRST205"].includes(error.code))
}

type SummaryGenerationStatus = "pending" | "ready" | "failed"

function extractSummaryPayload(value: unknown): ProposalSummaryPayload | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim()
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  // Backward compatibility for older rows written as object payloads.
  const record = value as Record<string, unknown>

  if (typeof record.summary_text === "string" && record.summary_text.trim().length > 0) {
    return record.summary_text.trim()
  }

  if (typeof record.short_summary === "string" && record.short_summary.trim().length > 0) {
    return record.short_summary.trim()
  }

  return null
}

function mapSummaryState(row: {
  generation_status: SummaryGenerationStatus
  summary_payload: unknown
  generated_at: string | null
  next_retry_at: string | null
} | null): ProposalSummaryState {
  if (!row) {
    return {
      status: "missing",
      data: null,
      generated_at: null,
      next_retry_at: null,
    }
  }

  if (row.generation_status === "pending") {
    return {
      status: "pending",
      data: null,
      generated_at: row.generated_at,
      next_retry_at: row.next_retry_at,
    }
  }

  const summaryPayload = extractSummaryPayload(row.summary_payload)

  if (row.generation_status === "ready" && summaryPayload) {
    return {
      status: "ready",
      data: summaryPayload,
      generated_at: row.generated_at,
      next_retry_at: row.next_retry_at,
    }
  }

  return {
    status: "failed",
    data: null,
    generated_at: row.generated_at,
    next_retry_at: row.next_retry_at,
  }
}

export async function getProposalDetail(
  proposalId: string
): Promise<ProposalDetailResponse | null> {
  const supabase = createSupabaseServerClient()

  const { data: proposal, error: proposalError } = await supabase
    .from("law_proposals")
    .select(
      "id,title,status,decision_date,enforcement_date,feed_description,stortinget_link,lovdata_link"
    )
    .eq("id", proposalId)
    .maybeSingle()

  if (proposalError && !isNotFoundError(proposalError)) {
    throw createListError("Could not fetch proposal detail", proposalError)
  }

  if (!proposal) {
    return null
  }

  const { data: proposalTargets, error: targetsError } = await supabase
    .from("proposal_targets")
    .select("document_id")
    .eq("proposal_id", proposalId)

  if (targetsError) {
    throw createListError("Could not fetch proposal target links", targetsError)
  }

  const documentIds = (proposalTargets ?? [])
    .map((target) => target.document_id)
    .filter((id): id is string => Boolean(id))

  let linkedDocuments: LinkedDocument[] = []

  if (documentIds.length > 0) {
    const { data: documents, error: documentsError } = await supabase
      .from("legal_documents")
      .select("id,dokid,legacy_id,title,short_title,document_type")
      .in("id", documentIds)

    if (documentsError) {
      throw createListError("Could not fetch linked legal documents", documentsError)
    }

    const byId = new Map((documents ?? []).map((document) => [document.id, document]))

    linkedDocuments = documentIds
      .map((id) => byId.get(id))
      .filter((document): document is LinkedDocument => Boolean(document))
  }

  const { data: summaryRow, error: summaryError } = await supabase
    .from("proposal_summaries")
    .select("generation_status,summary_payload,generated_at,next_retry_at")
    .eq("proposal_id", proposalId)
    .eq("proposal_status", proposal.status)
    .maybeSingle()

  if (summaryError && !isNotFoundError(summaryError)) {
    throw createListError("Could not fetch proposal summary", summaryError)
  }

  return {
    proposal: proposal as ProposalDetail,
    linkedDocuments,
    summary: mapSummaryState(summaryRow),
  }
}
