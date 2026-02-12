import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ProposalListView } from "@/components/proposals/proposal-list-view"
import type { ProposalListResponse } from "@/lib/types"

const pushMock = vi.fn()
let searchValue = ""

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
  useSearchParams: () => new URLSearchParams(searchValue),
}))

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function createPayload(overrides?: Partial<ProposalListResponse>): ProposalListResponse {
  return {
    items: [
      {
        id: "d4d87de7-e28f-44c9-b6c5-0f899f9a3201",
        title: "Endringer i skatteloven",
        feed_description: "Forslaget gjelder modernisering av skattereglene.",
        status: "vedtatt",
        decision_date: "2026-02-01",
        stortinget_link: "https://stortinget.no/vedtak/1",
        lovdata_link: null,
      },
    ],
    pagination: {
      page: 1,
      pageSize: 20,
      totalPages: 1,
      totalCount: 1,
    },
    ...overrides,
  }
}

describe("ProposalListView", () => {
  beforeEach(() => {
    pushMock.mockReset()
    searchValue = ""
    vi.stubGlobal("fetch", vi.fn())
  })

  it("renders proposal rows from the API", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(createPayload()))

    render(<ProposalListView />)

    expect(await screen.findByText("Endringer i skatteloven")).toBeInTheDocument()
    expect(screen.getAllByText("Vedtatt").length).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith("/api/proposals", { cache: "no-store" })
  })

  it("pushes updated URL filters when submitting search form", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(createPayload()))

    const user = userEvent.setup()

    render(<ProposalListView />)

    await screen.findByText("Endringer i skatteloven")

    await user.clear(screen.getByLabelText("Søk i beskrivelse"))
    await user.type(screen.getByLabelText("Søk i beskrivelse"), "modernisering")
    await user.click(screen.getByRole("button", { name: "Filtrer" }))

    expect(pushMock).toHaveBeenCalledWith("/?q=modernisering")
  })

  it("opens detail page when clicking anywhere on a proposal row", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(createPayload()))

    const user = userEvent.setup()

    render(<ProposalListView />)

    await screen.findByText("Endringer i skatteloven")
    await user.click(screen.getByText("Forslaget gjelder modernisering av skattereglene."))

    expect(pushMock).toHaveBeenCalledWith(
      "/proposal/d4d87de7-e28f-44c9-b6c5-0f899f9a3201"
    )
  })

  it("opens detail page when pressing Enter on focused row", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(createPayload()))

    render(<ProposalListView />)

    await screen.findByText("Endringer i skatteloven")

    const rowLink = screen.getByRole("link", {
      name: "Åpne detalj for Endringer i skatteloven",
    })

    fireEvent.keyDown(rowLink, { key: "Enter" })

    expect(pushMock).toHaveBeenCalledWith(
      "/proposal/d4d87de7-e28f-44c9-b6c5-0f899f9a3201"
    )
  })

  it("does not hijack Enter key presses from nested source link", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(createPayload()))

    render(<ProposalListView />)

    await screen.findByText("Endringer i skatteloven")

    const sourceLink = screen.getByRole("link", { name: "Stortinget" })

    fireEvent.keyDown(sourceLink, { key: "Enter" })

    expect(pushMock).not.toHaveBeenCalledWith(
      "/proposal/d4d87de7-e28f-44c9-b6c5-0f899f9a3201"
    )
  })

  it("shows empty-state feedback when no rows are returned", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      jsonResponse(
        createPayload({
          items: [],
          pagination: {
            page: 1,
            pageSize: 20,
            totalCount: 0,
            totalPages: 1,
          },
        })
      )
    )

    render(<ProposalListView />)

    expect(
      await screen.findByText("Ingen treff for gjeldende filtre.")
    ).toBeInTheDocument()
  })

  it("offers recovery when page is out of range but matches still exist", async () => {
    searchValue = "page=9"

    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      jsonResponse(
        createPayload({
          items: [],
          pagination: {
            page: 9,
            pageSize: 20,
            totalCount: 41,
            totalPages: 3,
          },
        })
      )
    )

    const user = userEvent.setup()

    render(<ProposalListView />)

    expect(
      await screen.findByText("Siden du åpnet er utenfor tilgjengelige sider.")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Ingen treff for gjeldende filtre.")
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Gå til siste side" }))

    expect(pushMock).toHaveBeenCalledWith("/?page=3")
  })

  it("shows readable API error feedback", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Testfeil fra API" }, 500)
    )

    render(<ProposalListView />)

    await waitFor(() => {
      expect(screen.getByText("Kunne ikke laste data")).toBeInTheDocument()
    })

    expect(screen.getByText("Testfeil fra API")).toBeInTheDocument()
    expect(
      screen.queryByText("Ingen treff for gjeldende filtre.")
    ).not.toBeInTheDocument()
  })
})
