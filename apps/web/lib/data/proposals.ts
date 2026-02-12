import { getOffset, getTotalPages } from "@/lib/pagination"
import { createSupabaseServerClient } from "@/lib/supabase-server"
import type {
  LinkedDocument,
  ListQuery,
  ProposalDetail,
  ProposalDetailResponse,
  ProposalListItem,
  ProposalListResponse,
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
      "id,title,feed_description,status,decision_date,stortinget_link,lovdata_link,created_at"
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

  return {
    proposal: proposal as ProposalDetail,
    linkedDocuments,
  }
}
