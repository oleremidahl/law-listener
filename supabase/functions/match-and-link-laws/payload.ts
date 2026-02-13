export const ENFORCEMENT_TOKENS = [
  "KONGEN_BESTEMMER",
  "STRAKS",
  "FLERE_DATOER",
  "PARSER_IKKE_FUNNET",
  "PARSER_FEIL",
] as const;

const ENFORCEMENT_SET = new Set<string>(ENFORCEMENT_TOKENS);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.toISOString().slice(0, 10) === value;
}

export function normalizeExtractedIds(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim());
  }

  return null;
}

export function normalizeEnforcementDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  if (ENFORCEMENT_SET.has(normalized)) {
    return normalized;
  }

  if (isValidIsoDate(normalized)) {
    return normalized;
  }

  return null;
}
