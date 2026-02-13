import { describe, expect, it } from "vitest"
import { getLovdataLinkFromDokid } from "@/lib/utils"

describe("getLovdataLinkFromDokid", () => {
  it("generates correct Lovdata link from dokid", () => {
    const dokid = "NL/lov/2008-06-27-71"
    const expectedLink = "https://lovdata.no/dokument/NL/lov/2008-06-27-71"
    expect(getLovdataLinkFromDokid(dokid)).toBe(expectedLink)
  })

  it("generates correct Lovdata link from different dokid formats", () => {
    const testCases = [
      { dokid: "LOV-2017-06-16-60", expected: "https://lovdata.no/dokument/LOV-2017-06-16-60" },
      { dokid: "NL/lov/2008-06-27-71", expected: "https://lovdata.no/dokument/NL/lov/2008-06-27-71" },
      { dokid: "SF/forskrift/2023-01-15-100", expected: "https://lovdata.no/dokument/SF/forskrift/2023-01-15-100" },
    ]

    testCases.forEach(({ dokid, expected }) => {
      expect(getLovdataLinkFromDokid(dokid)).toBe(expected)
    })
  })
})
