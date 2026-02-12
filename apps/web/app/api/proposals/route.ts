import { NextRequest, NextResponse } from "next/server"

import { listProposals } from "@/lib/data/proposals"
import { parseListQuery } from "@/lib/query"
import type { ApiError } from "@/lib/types"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const query = parseListQuery(request.nextUrl.searchParams)
    const response = await listProposals(query)
    return NextResponse.json(response)
  } catch (error) {
    console.error("Failed to load proposals", error)

    const body: ApiError = {
      error: "Kunne ikke hente lovforslag. Prøv igjen.",
    }

    return NextResponse.json(body, { status: 500 })
  }
}
