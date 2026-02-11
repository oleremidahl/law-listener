import { DEFAULT_PAGE_SIZE, MAX_QUERY_LENGTH, PROPOSAL_STATUSES } from "@/lib/constants"
import type { ListQuery, ProposalStatusFilter } from "@/lib/types"

const statusSet = new Set<string>(PROPOSAL_STATUSES)

function sanitizeText(value: string | null): string {
  if (!value) {
    return ""
  }

  return value.trim().slice(0, MAX_QUERY_LENGTH)
}

function isIsoDate(value: string | null): value is string {
  if (!value) {
    return false
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function parseStatus(value: string | null): ProposalStatusFilter {
  if (!value || value === "all") {
    return "all"
  }

  if (statusSet.has(value)) {
    return value as ProposalStatusFilter
  }

  return "all"
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback
  }

  return parsed
}

export function parseListQuery(
  params: URLSearchParams,
  pageSize = DEFAULT_PAGE_SIZE
): ListQuery {
  const q = sanitizeText(params.get("q"))
  const status = parseStatus(params.get("status"))

  let from = isIsoDate(params.get("from")) ? params.get("from") : null
  let to = isIsoDate(params.get("to")) ? params.get("to") : null

  if (from && to && from > to) {
    const tmp = from
    from = to
    to = tmp
  }

  const page = parsePositiveInt(params.get("page"), 1)

  return {
    q,
    status,
    from,
    to,
    page,
    pageSize,
  }
}

export function toSearchParams(query: Partial<ListQuery>): URLSearchParams {
  const params = new URLSearchParams()

  if (query.q?.trim()) {
    params.set("q", query.q.trim())
  }

  if (query.status && query.status !== "all") {
    params.set("status", query.status)
  }

  if (query.from) {
    params.set("from", query.from)
  }

  if (query.to) {
    params.set("to", query.to)
  }

  if (query.page && query.page > 1) {
    params.set("page", String(query.page))
  }

  return params
}

export function withPage(params: URLSearchParams, page: number): URLSearchParams {
  const next = new URLSearchParams(params)
  if (page <= 1) {
    next.delete("page")
  } else {
    next.set("page", String(page))
  }
  return next
}

export function formatDate(value: string | null): string {
  if (!value) {
    return "Ikke oppgitt"
  }

  const date = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    return "Ikke oppgitt"
  }

  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date)
}
