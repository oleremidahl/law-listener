import { describe, expect, it } from "vitest"

import { formatEnforcementDate } from "@/lib/enforcement"

describe("formatEnforcementDate", () => {
  it("maps known sentinel tokens", () => {
    expect(formatEnforcementDate("KONGEN_BESTEMMER")).toBe(
      "Kongen fastsetter dato under kongelig resolusjon."
    )
    expect(formatEnforcementDate("STRAKS")).toBe(
      "Trer i kraft så snart kongen har sanksjonert forslaget."
    )
    expect(formatEnforcementDate("FLERE_DATOER")).toBe(
      "Flere bestemmelser trer i kraft til ulike tider."
    )
    expect(formatEnforcementDate("PARSER_IKKE_FUNNET")).toBe(
      "Fant ikke ikrafttredelse i teksten automatisk. Se lenke."
    )
    expect(formatEnforcementDate("PARSER_FEIL")).toBe(
      "Kunne ikke hente/lese vedtak automatisk. Se lenke."
    )
  })

  it("formats ISO dates and falls back for missing/invalid", () => {
    expect(formatEnforcementDate("2027-01-01")).toMatch(/2027/)
    expect(formatEnforcementDate(null)).toBe("Ikke oppgitt")
    expect(formatEnforcementDate("invalid-value")).toBe("Ikke oppgitt")
  })
})
