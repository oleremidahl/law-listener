import { formatDate } from "@/lib/query"

const ENFORCEMENT_TEXT: Record<string, string> = {
  KONGEN_BESTEMMER: "Kongen fastsetter dato under kongelig resolusjon.",
  STRAKS: "Trer i kraft så snart kongen har sanksjonert forslaget.",
  FLERE_DATOER: "Flere bestemmelser trer i kraft til ulike tider.",
  PARSER_IKKE_FUNNET:
    "Fant ikke ikrafttredelse i teksten automatisk. Se lenke.",
  PARSER_FEIL: "Kunne ikke hente/lese vedtak automatisk. Se lenke.",
}

export function formatEnforcementDate(value: string | null): string {
  if (!value) {
    return "Ikke oppgitt"
  }

  const normalized = value.trim()
  if (!normalized) {
    return "Ikke oppgitt"
  }

  const mapped = ENFORCEMENT_TEXT[normalized]
  if (mapped) {
    return mapped
  }

  return formatDate(normalized)
}
