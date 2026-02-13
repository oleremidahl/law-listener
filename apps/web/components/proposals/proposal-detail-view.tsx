"use client"

import Link from "next/link"
import { ArrowLeftIcon, ExternalLinkIcon, RefreshCcwIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { formatEnforcementDate } from "@/lib/enforcement"
import { formatDate } from "@/lib/query"
import { cn, getLovdataLinkFromDokid } from "@/lib/utils"
import type {
  ProposalDetailResponse,
  ProposalSummaryState,
  ProposalSummaryTriggerResponse,
} from "@/lib/types"

import { StatusBadge } from "./status-badge"

function LoadingDetail() {
  return (
    <div className="space-y-3" role="status" aria-label="Laster detaljvisning">
      <Skeleton className="h-12 w-1/2" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-52 w-full" />
    </div>
  )
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-"
  }

  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat("nb-NO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed)
}

function isRetryEligible(summary: ProposalSummaryState): boolean {
  if (summary.status === "missing") {
    return true
  }

  if (summary.status !== "failed") {
    return false
  }

  if (!summary.next_retry_at) {
    return true
  }

  const nextRetryAt = new Date(summary.next_retry_at)
  if (Number.isNaN(nextRetryAt.getTime())) {
    return true
  }

  return Date.now() >= nextRetryAt.getTime()
}

export function ProposalDetailView({ proposalId }: { proposalId: string }) {
  const [payload, setPayload] = useState<ProposalDetailResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isNotFound, setIsNotFound] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const triggerSentRef = useRef(false)

  useEffect(() => {
    triggerSentRef.current = false
  }, [proposalId])

  useEffect(() => {
    let ignore = false

    async function load() {
      setIsLoading(true)
      setErrorMessage(null)
      setIsNotFound(false)

      try {
        const response = await fetch(`/api/proposals/${proposalId}`, {
          cache: "no-store",
        })

        if (response.status === 404) {
          if (!ignore) {
            setIsNotFound(true)
            setPayload(null)
          }
          return
        }

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null

          throw new Error(body?.error ?? "Kunne ikke hente forslag.")
        }

        const data = (await response.json()) as ProposalDetailResponse

        if (!ignore) {
          setPayload(data)
        }
      } catch (error) {
        if (!ignore) {
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
  }, [proposalId, refreshTick])

  useEffect(() => {
    if (!payload || triggerSentRef.current || !isRetryEligible(payload.summary)) {
      return
    }

    triggerSentRef.current = true

    let ignore = false

    async function triggerSummary() {
      try {
        const response = await fetch(`/api/proposals/${proposalId}/summary`, {
          method: "POST",
          cache: "no-store",
        })

        if (!response.ok) {
          return
        }

        const body = (await response.json().catch(() => null)) as
          | ProposalSummaryTriggerResponse
          | null

        if (ignore || !body) {
          return
        }

        setRefreshTick((value) => value + 1)
      } catch {
        // Fail-open in UI; detail still remains usable without summary.
      }
    }

    void triggerSummary()

    return () => {
      ignore = true
    }
  }, [payload, proposalId])

  useEffect(() => {
    if (payload?.summary.status !== "pending") {
      return
    }

    const timer = setInterval(() => {
      setRefreshTick((value) => value + 1)
    }, 4000)

    return () => clearInterval(timer)
  }, [payload?.summary.status])

  if (isLoading) {
    return <LoadingDetail />
  }

  if (isNotFound) {
    return (
      <Alert>
        <AlertTitle>404</AlertTitle>
        <AlertDescription>
          Forslaget finnes ikke, eller du har brukt en ugyldig lenke.
        </AlertDescription>
      </Alert>
    )
  }

  if (errorMessage) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Kunne ikke laste forslag</AlertTitle>
        <AlertDescription>{errorMessage}</AlertDescription>
      </Alert>
    )
  }

  if (!payload) {
    return null
  }

  const { proposal, linkedDocuments, summary } = payload

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">
            <ArrowLeftIcon className="size-4" />
            Til oversikten
          </Link>
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefreshTick((value) => value + 1)}
        >
          <RefreshCcwIcon className={cn("size-4", isLoading && "animate-spin")} />
          Oppdater
        </Button>
      </div>

      <Card className="border-zinc-300/90 bg-white/90 shadow-sm backdrop-blur">
        <CardHeader className="space-y-3">
          <CardTitle className="font-serif text-3xl leading-tight text-zinc-900">
            {proposal.title}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={proposal.status} />
            <span className="text-sm text-zinc-600">
              Beslutningsdato: {formatDate(proposal.decision_date)}
            </span>
            <span className="text-sm text-zinc-600">
              Ikrafttredelse: {formatEnforcementDate(proposal.enforcement_date)}
            </span>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 text-sm text-zinc-800">
          {proposal.feed_description ? (
            <p className="leading-relaxed whitespace-pre-line">
              {proposal.feed_description}
            </p>
          ) : (
            <p className="text-zinc-600">Ingen beskrivelse registrert.</p>
          )}

          <Separator className="bg-zinc-300/70" />

          <div className="flex flex-wrap gap-2">
            {proposal.stortinget_link ? (
              <Button asChild variant="outline" size="sm">
                <a href={proposal.stortinget_link} target="_blank" rel="noreferrer">
                  Åpne på Stortinget
                  <ExternalLinkIcon className="size-4" />
                </a>
              </Button>
            ) : null}

            {proposal.lovdata_link ? (
              <Button asChild variant="outline" size="sm">
                <a href={proposal.lovdata_link} target="_blank" rel="noreferrer">
                  Åpne på Lovdata
                  <ExternalLinkIcon className="size-4" />
                </a>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="border-zinc-300/90 bg-white/95 shadow-sm">
        <CardHeader>
          <CardTitle className="font-serif text-2xl text-zinc-900">
            AI-oppsummering
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {summary.status === "ready" && summary.data ? (
            <>
              <p className="text-sm leading-relaxed whitespace-pre-line text-zinc-800">
                {summary.data}
              </p>

              <p className="text-xs text-zinc-500">
                Generert: {formatDateTime(summary.generated_at)}
              </p>
            </>
          ) : null}

          {summary.status === "missing" || summary.status === "pending" ? (
            <p className="text-sm text-zinc-600">
              Oppsummering genereres automatisk. Denne seksjonen oppdateres når den er klar.
            </p>
          ) : null}

          {summary.status === "failed" ? (
            <div className="space-y-1">
              <p className="text-sm text-zinc-700">
                Oppsummering er midlertidig utilgjengelig. Systemet prøver automatisk igjen.
              </p>
              {summary.next_retry_at ? (
                <p className="text-xs text-zinc-500">
                  Neste automatiske forsøk etter: {formatDateTime(summary.next_retry_at)}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-zinc-300/90 bg-white/95 shadow-sm">
        <CardHeader>
          <CardTitle className="font-serif text-2xl text-zinc-900">
            Koblede lover
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {linkedDocuments.length === 0 ? (
            <p className="text-sm text-zinc-600">
              Ingen koblede lover funnet for dette forslaget.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tittel</TableHead>
                  <TableHead>Dokument-ID</TableHead>
                  <TableHead>Dokumenttype</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {linkedDocuments.map((document) => (
                  <TableRow key={document.id}>
                    <TableCell className="font-medium text-zinc-900">
                      {document.short_title ?? document.title}
                    </TableCell>
                    <TableCell className="text-zinc-700">
                      <a
                        href={getLovdataLinkFromDokid(document.dokid)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {document.dokid}
                      </a>
                    </TableCell>
                    <TableCell className="text-zinc-700">
                      {document.document_type}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
