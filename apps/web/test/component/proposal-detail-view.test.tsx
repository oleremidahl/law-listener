import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ProposalDetailView } from "@/components/proposals/proposal-detail-view"
import type { ProposalDetailResponse } from "@/lib/types"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function createPayload(): ProposalDetailResponse {
  return {
    proposal: {
      id: "d4d87de7-e28f-44c9-b6c5-0f899f9a3201",
      title: "Endringer i skatteloven",
      status: "vedtatt",
      decision_date: "2026-02-01",
      enforcement_date: "KONGEN_BESTEMMER",
      feed_description: "Forslaget gjelder modernisering av skattereglene.",
      stortinget_link: "https://stortinget.no/vedtak/1",
      lovdata_link: null,
    },
    linkedDocuments: [
      {
        id: "f8df4ea6-67cb-4f9d-8146-a96998742ce6",
        dokid: "LOV-2017-06-16-60",
        legacy_id: "LOV-2017-06-16-60",
        title: "Skatteforvaltningsloven",
        short_title: "Skatteforvaltningsloven",
        document_type: "lov",
      },
    ],
    summary: {
      status: "ready",
      data: {
        short_summary: "Forslaget moderniserer skattereglene.",
        law_changes: ["Oppdaterer hjemmel for digital rapportering."],
        affected_groups: ["Bedrifter med rapporteringsplikt."],
        caveats: ["Detaljer avhenger av forskrifter."],
        sources: {
          proposal_url: "https://stortinget.no/vedtak/1",
          fetch_method: "jina",
        },
      },
      generated_at: "2026-02-10T10:00:00.000Z",
      next_retry_at: null,
    },
  }
}

describe("ProposalDetailView", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  it("renders detail metadata and linked legal documents", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(createPayload()))

    render(
      <ProposalDetailView proposalId="d4d87de7-e28f-44c9-b6c5-0f899f9a3201" />
    )

    expect(await screen.findByText("Endringer i skatteloven")).toBeInTheDocument()
    expect(screen.getByText("Skatteforvaltningsloven")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Åpne på Stortinget" })).toBeInTheDocument()
    expect(
      screen.getByText(/Kongen fastsetter dato under kongelig resolusjon\./)
    ).toBeInTheDocument()
    expect(
      screen.getByText("Forslaget moderniserer skattereglene.")
    ).toBeInTheDocument()
  })

  it("shows not-found feedback when the proposal API returns 404", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "not found" }, 404))

    render(
      <ProposalDetailView proposalId="00000000-0000-4000-8000-000000000000" />
    )

    await waitFor(() => {
      expect(screen.getByText("404")).toBeInTheDocument()
    })

    expect(
      screen.getByText(/Forslaget finnes ikke, eller du har brukt en ugyldig lenke/)
    ).toBeInTheDocument()
  })

  it("auto-triggers summary generation when summary is missing", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          ...createPayload(),
          summary: {
            status: "missing",
            data: null,
            generated_at: null,
            next_retry_at: null,
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ status: "started" }))
      .mockResolvedValueOnce(jsonResponse(createPayload()))

    render(
      <ProposalDetailView proposalId="d4d87de7-e28f-44c9-b6c5-0f899f9a3201" />
    )

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "/api/proposals/d4d87de7-e28f-44c9-b6c5-0f899f9a3201"
    )
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe(
      "/api/proposals/d4d87de7-e28f-44c9-b6c5-0f899f9a3201/summary"
    )
  })
})
