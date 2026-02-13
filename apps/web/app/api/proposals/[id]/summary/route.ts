import { NextRequest, NextResponse } from "next/server"

import { getSummaryServerEnv } from "@/lib/server-env"
import type { ApiError, ProposalSummaryTriggerResponse } from "@/lib/types"

export const dynamic = "force-dynamic"
export const revalidate = 0

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}

function isTriggerResponse(value: unknown): value is ProposalSummaryTriggerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return ["started", "pending", "already_ready", "cooldown", "failed"].includes(
    String(candidate.status)
  )
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params

    if (!isUuid(id)) {
      return NextResponse.json({ error: "Fant ikke forslaget." } satisfies ApiError, {
        status: 404,
      })
    }

    const { summaryEdgeFunctionUrl, summaryTriggerSecret } = getSummaryServerEnv()
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID()

    const upstream = await fetch(summaryEdgeFunctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-summary-secret": summaryTriggerSecret,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ proposal_id: id }),
      cache: "no-store",
    })

    const body = (await upstream.json().catch(() => null)) as unknown

    if (!upstream.ok) {
      const status = upstream.status >= 500 ? 502 : upstream.status

      return NextResponse.json(
        {
          error: "Kunne ikke starte oppsummering.",
        } satisfies ApiError,
        { status }
      )
    }

    if (!isTriggerResponse(body)) {
      return NextResponse.json(
        {
          error: "Ugyldig svar fra oppsummeringstjenesten.",
        } satisfies ApiError,
        { status: 502 }
      )
    }

    return NextResponse.json(body)
  } catch (error) {
    console.error("Failed to trigger proposal summary", error)
    return NextResponse.json(
      { error: "Kunne ikke starte oppsummering." } satisfies ApiError,
      { status: 500 }
    )
  }
}
