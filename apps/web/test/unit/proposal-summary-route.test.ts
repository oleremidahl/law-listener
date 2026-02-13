import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const proposalId = "d4d87de7-e28f-44c9-b6c5-0f899f9a3201"

async function loadPostHandler() {
  vi.resetModules()
  const routeModule = await import("@/app/api/proposals/[id]/summary/route")
  return routeModule.POST
}

describe("POST /api/proposals/[id]/summary", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.SUMMARY_EDGE_FUNCTION_URL = "https://example.com/functions/v1/generate-proposal-summary"
    process.env.SUMMARY_TRIGGER_SECRET = "test-secret"
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("returns 404 for invalid proposal id", async () => {
    const POST = await loadPostHandler()

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ id: "invalid-id" }),
    })

    expect(response.status).toBe(404)
  })

  it("returns trigger response when upstream succeeds", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: "started" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )

    const POST = await loadPostHandler()

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ id: proposalId }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "started" })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it("maps upstream 5xx to 502", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "failed" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    )

    const POST = await loadPostHandler()

    const response = await POST(new Request("http://localhost") as never, {
      params: Promise.resolve({ id: proposalId }),
    })

    expect(response.status).toBe(502)
  })
})
