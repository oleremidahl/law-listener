import { NextRequest, NextResponse } from "next/server"

import { getProposalDetail } from "@/lib/data/proposals"
import type { ApiError } from "@/lib/types"

export const dynamic = "force-dynamic"
export const revalidate = 0

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params

    if (!isUuid(id)) {
      return NextResponse.json({ error: "Fant ikke forslaget." } satisfies ApiError, {
        status: 404,
      })
    }

    const detail = await getProposalDetail(id)

    if (!detail) {
      return NextResponse.json({ error: "Fant ikke forslaget." } satisfies ApiError, {
        status: 404,
      })
    }

    return NextResponse.json(detail)
  } catch (error) {
    console.error("Failed to load proposal detail", error)
    return NextResponse.json(
      { error: "Kunne ikke hente forslag." } satisfies ApiError,
      { status: 500 }
    )
  }
}
