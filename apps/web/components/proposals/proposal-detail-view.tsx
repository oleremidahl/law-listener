"use client"

import Link from "next/link"
import { ArrowLeftIcon, ExternalLinkIcon, RefreshCcwIcon } from "lucide-react"
import { useEffect, useState } from "react"

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
import { cn } from "@/lib/utils"
import type { ProposalDetailResponse } from "@/lib/types"

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

export function ProposalDetailView({ proposalId }: { proposalId: string }) {
  const [payload, setPayload] = useState<ProposalDetailResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isNotFound, setIsNotFound] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

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

  const { proposal, linkedDocuments } = payload

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
                  <TableHead>Legacy ID</TableHead>
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
                      {document.legacy_id ?? "Mangler"}
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
