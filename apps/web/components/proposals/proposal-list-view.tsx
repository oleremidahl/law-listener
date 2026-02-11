"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { RefreshCcwIcon, SearchIcon, XIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { getVisiblePages } from "@/lib/pagination"
import { formatDate, parseListQuery, toSearchParams, withPage } from "@/lib/query"
import type {
  ProposalListItem,
  ProposalListResponse,
  ProposalStatusFilter,
} from "@/lib/types"

import { StatusBadge } from "./status-badge"

const statusOptions: Array<{ value: ProposalStatusFilter; label: string }> = [
  { value: "all", label: "Alle statuser" },
  { value: "vedtatt", label: "Vedtatt" },
  { value: "sanksjonert", label: "Sanksjonert" },
  { value: "i_kraft", label: "I kraft" },
]

function LoadingRows() {
  return (
    <div className="space-y-3" role="status" aria-label="Laster lovforslag">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

function ProposalRow({
  item,
  onOpen,
}: {
  item: ProposalListItem
  onOpen: () => void
}) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onOpen()
    }
  }

  return (
    <TableRow
      className="cursor-pointer hover:bg-zinc-100/80"
      tabIndex={0}
      role="link"
      aria-label={`Åpne detalj for ${item.title}`}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
    >
      <TableCell className="font-medium text-zinc-900">{item.title}</TableCell>
      <TableCell className="max-w-[34rem] text-zinc-700">
        <p className="truncate">
          {item.feed_description?.trim() || "Ingen beskrivelse"}
        </p>
      </TableCell>
      <TableCell>
        <StatusBadge status={item.status} />
      </TableCell>
      <TableCell className="text-zinc-700">{formatDate(item.decision_date)}</TableCell>
      <TableCell className="text-right">
        {item.stortinget_link ? (
          <a
            href={item.stortinget_link}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-sky-800 underline-offset-4 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            Stortinget
          </a>
        ) : (
          <span className="text-sm text-zinc-500">Mangler</span>
        )}
      </TableCell>
    </TableRow>
  )
}

export function ProposalListView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawQuery = searchParams.toString()

  const query = useMemo(
    () => parseListQuery(new URLSearchParams(rawQuery)),
    [rawQuery]
  )

  const [queryInput, setQueryInput] = useState(query.q)
  const [statusInput, setStatusInput] = useState<ProposalStatusFilter>(query.status)
  const [fromInput, setFromInput] = useState(query.from ?? "")
  const [toInput, setToInput] = useState(query.to ?? "")

  const [refreshTick, setRefreshTick] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [payload, setPayload] = useState<ProposalListResponse | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  useEffect(() => {
    setQueryInput(query.q)
    setStatusInput(query.status)
    setFromInput(query.from ?? "")
    setToInput(query.to ?? "")
  }, [query.q, query.status, query.from, query.to])

  const apiQuery = useMemo(() => toSearchParams(query).toString(), [query])

  useEffect(() => {
    let ignore = false

    async function load() {
      setIsLoading(true)
      setErrorMessage(null)

      try {
        const endpoint = apiQuery ? `/api/proposals?${apiQuery}` : "/api/proposals"
        const response = await fetch(endpoint, { cache: "no-store" })

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null

          throw new Error(body?.error ?? "Kunne ikke hente lovforslag.")
        }

        const data = (await response.json()) as ProposalListResponse

        if (!ignore) {
          setPayload(data)
          setLastUpdated(new Date())
        }
      } catch (error) {
        if (!ignore) {
          setPayload(null)
          setErrorMessage(
            error instanceof Error ? error.message : "Ukjent feil ved lasting"
          )
        }
      } finally {
        if (!ignore) {
          setIsLoading(false)
        }
      }
    }

    void load()

    return () => {
      ignore = true
    }
  }, [apiQuery, refreshTick])

  function pushQuery(nextParams: URLSearchParams) {
    const nextQuery = nextParams.toString()
    router.push(nextQuery ? `/?${nextQuery}` : "/")
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const nextParams = toSearchParams({
      q: queryInput,
      status: statusInput,
      from: fromInput || null,
      to: toInput || null,
      page: 1,
    })

    pushQuery(nextParams)
  }

  function handleReset() {
    setQueryInput("")
    setStatusInput("all")
    setFromInput("")
    setToInput("")
    pushQuery(new URLSearchParams())
  }

  const pagination = payload?.pagination
  const visiblePages = getVisiblePages(
    pagination?.page ?? 1,
    pagination?.totalPages ?? 1,
    5
  )

  const hasLeftEllipsis = visiblePages.length > 0 && visiblePages[0] > 2
  const hasRightEllipsis =
    visiblePages.length > 0 &&
    visiblePages[visiblePages.length - 1] < (pagination?.totalPages ?? 1) - 1

  const showFirstPage = visiblePages.length > 0 && visiblePages[0] > 1
  const showLastPage =
    visiblePages.length > 0 &&
    visiblePages[visiblePages.length - 1] < (pagination?.totalPages ?? 1)

  const totalRows = payload?.pagination.totalCount ?? 0

  return (
    <section className="space-y-6">
      <Card className="border-zinc-300/90 bg-white/85 shadow-lg backdrop-blur">
        <CardHeader className="pb-4">
          <CardTitle className="font-serif text-2xl text-zinc-900">
            Lovbeslutninger
          </CardTitle>
          <p className="max-w-2xl text-sm text-zinc-700">
            Oversikt over vedtatte lovforslag med status, datoer og lenker til
            Stortinget.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-600">
            <span>
              {totalRows > 0
                ? `${totalRows} forslag funnet`
                : "Ingen forslag i valgt utvalg"}
            </span>
            <div className="flex items-center gap-2">
              <span>
                Sist oppdatert: {lastUpdated ? lastUpdated.toLocaleTimeString("nb-NO") : "-"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefreshTick((value) => value + 1)}
                disabled={isLoading}
              >
                <RefreshCcwIcon
                  className={cn("size-4", isLoading && "animate-spin")}
                />
                Oppdater
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-zinc-300/90 bg-white/85 shadow-sm backdrop-blur">
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="grid gap-4 md:grid-cols-6">
            <div className="md:col-span-2">
              <label
                htmlFor="search-description"
                className="mb-1 block text-xs font-semibold tracking-wide text-zinc-600 uppercase"
              >
                Søk i beskrivelse
              </label>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-zinc-500" />
                <Input
                  id="search-description"
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                  className="pl-8"
                  placeholder="f.eks. modernisering, skatt, energi"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold tracking-wide text-zinc-600 uppercase">
                Status
              </label>
              <Select
                value={statusInput}
                onValueChange={(value) =>
                  setStatusInput(value as ProposalStatusFilter)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Velg status" />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label
                htmlFor="date-from"
                className="mb-1 block text-xs font-semibold tracking-wide text-zinc-600 uppercase"
              >
                Fra dato
              </label>
              <Input
                id="date-from"
                type="date"
                value={fromInput}
                onChange={(event) => setFromInput(event.target.value)}
              />
            </div>

            <div>
              <label
                htmlFor="date-to"
                className="mb-1 block text-xs font-semibold tracking-wide text-zinc-600 uppercase"
              >
                Til dato
              </label>
              <Input
                id="date-to"
                type="date"
                value={toInput}
                onChange={(event) => setToInput(event.target.value)}
              />
            </div>

            <div className="flex items-end gap-2 md:col-span-1">
              <Button type="submit" className="w-full md:w-auto">
                Filtrer
              </Button>
              <Button type="button" variant="outline" onClick={handleReset}>
                <XIcon className="size-4" />
                Nullstill
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Separator className="bg-zinc-300/70" />

      {errorMessage ? (
        <Alert variant="destructive">
          <AlertTitle>Kunne ikke laste data</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {isLoading ? (
        <LoadingRows />
      ) : payload && payload.items.length > 0 ? (
        <Card className="border-zinc-300/90 bg-white/95 shadow-sm">
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tittel</TableHead>
                  <TableHead>Beskrivelse</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Beslutningsdato</TableHead>
                  <TableHead className="text-right">Kilde</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payload.items.map((item) => (
                  <ProposalRow
                    key={item.id}
                    item={item}
                    onOpen={() => router.push(`/proposal/${item.id}`)}
                  />
                ))}
              </TableBody>
            </Table>

            {pagination && pagination.totalPages > 1 ? (
              <div className="mt-6">
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href={
                          pagination.page > 1
                            ? (() => {
                                const params = withPage(
                                  toSearchParams(query),
                                  pagination.page - 1
                                )
                                const queryString = params.toString()
                                return queryString ? `/?${queryString}` : "/"
                              })()
                            : "#"
                        }
                        className={cn(
                          pagination.page <= 1 &&
                            "pointer-events-none opacity-50"
                        )}
                      />
                    </PaginationItem>

                    {showFirstPage ? (
                      <PaginationItem>
                        <PaginationLink href={(() => {
                          const params = withPage(toSearchParams(query), 1)
                          const queryString = params.toString()
                          return queryString ? `/?${queryString}` : "/"
                        })()}>
                          1
                        </PaginationLink>
                      </PaginationItem>
                    ) : null}

                    {hasLeftEllipsis ? (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    ) : null}

                    {visiblePages.map((page) => {
                      const params = withPage(toSearchParams(query), page)
                      const queryString = params.toString()
                      const href = queryString ? `/?${queryString}` : "/"

                      return (
                        <PaginationItem key={page}>
                          <PaginationLink href={href} isActive={page === pagination.page}>
                            {page}
                          </PaginationLink>
                        </PaginationItem>
                      )
                    })}

                    {hasRightEllipsis ? (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    ) : null}

                    {showLastPage ? (
                      <PaginationItem>
                        <PaginationLink href={(() => {
                          const params = withPage(
                            toSearchParams(query),
                            pagination.totalPages
                          )
                          const queryString = params.toString()
                          return queryString ? `/?${queryString}` : "/"
                        })()}>
                          {pagination.totalPages}
                        </PaginationLink>
                      </PaginationItem>
                    ) : null}

                    <PaginationItem>
                      <PaginationNext
                        href={
                          pagination.page < pagination.totalPages
                            ? (() => {
                                const params = withPage(
                                  toSearchParams(query),
                                  pagination.page + 1
                                )
                                const queryString = params.toString()
                                return queryString ? `/?${queryString}` : "/"
                              })()
                            : "#"
                        }
                        className={cn(
                          pagination.page >= pagination.totalPages &&
                            "pointer-events-none opacity-50"
                        )}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-zinc-300/90 bg-white/95 shadow-sm">
          <CardContent className="py-12 text-center text-sm text-zinc-600">
            Ingen treff for gjeldende filtre.
          </CardContent>
        </Card>
      )}
    </section>
  )
}
