import { describe, expect, it } from "vitest"

import { formatDate, parseListQuery, toSearchParams } from "@/lib/query"

describe("parseListQuery", () => {
  it("sanitizes invalid values and falls back to defaults", () => {
    const params = new URLSearchParams({
      status: "ukjent",
      page: "0",
      from: "invalid",
      to: "2026-02-31",
    })

    const parsed = parseListQuery(params)

    expect(parsed.status).toBe("all")
    expect(parsed.page).toBe(1)
    expect(parsed.from).toBeNull()
    expect(parsed.to).toBeNull()
  })

  it("keeps valid filters and swaps date range when reversed", () => {
    const params = new URLSearchParams({
      q: " skatt  ",
      status: "vedtatt",
      from: "2026-02-10",
      to: "2026-01-01",
      page: "3",
    })

    const parsed = parseListQuery(params)

    expect(parsed.q).toBe("skatt")
    expect(parsed.status).toBe("vedtatt")
    expect(parsed.from).toBe("2026-01-01")
    expect(parsed.to).toBe("2026-02-10")
    expect(parsed.page).toBe(3)
  })
})

describe("toSearchParams", () => {
  it("serializes filters and omits defaults", () => {
    const params = toSearchParams({
      q: "energi",
      status: "all",
      page: 1,
      from: null,
      to: null,
    })

    expect(params.toString()).toBe("q=energi")
  })

  it("includes non-default status and pagination", () => {
    const params = toSearchParams({
      status: "i_kraft",
      page: 4,
      from: "2025-12-01",
      to: "2025-12-31",
    })

    expect(params.get("status")).toBe("i_kraft")
    expect(params.get("page")).toBe("4")
    expect(params.get("from")).toBe("2025-12-01")
    expect(params.get("to")).toBe("2025-12-31")
  })
})

describe("formatDate", () => {
  it("returns Norwegian date formatting for valid date", () => {
    expect(formatDate("2026-01-15")).toMatch(/2026/)
  })

  it("returns fallback text for null/invalid value", () => {
    expect(formatDate(null)).toBe("Ikke oppgitt")
    expect(formatDate("not-a-date")).toBe("Ikke oppgitt")
  })
})
