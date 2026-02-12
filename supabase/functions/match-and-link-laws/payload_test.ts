import {
  normalizeEnforcementDate,
  normalizeExtractedIds,
} from "./payload.ts";

Deno.test("normalizeEnforcementDate accepts all sentinel tokens", () => {
  const values = [
    "KONGEN_BESTEMMER",
    "STRAKS",
    "FLERE_DATOER",
    "PARSER_IKKE_FUNNET",
    "PARSER_FEIL",
  ];

  for (const value of values) {
    if (normalizeEnforcementDate(value) !== value) {
      throw new Error(`Expected sentinel value to pass: ${value}`);
    }
  }
});

Deno.test("normalizeEnforcementDate accepts valid ISO dates", () => {
  if (normalizeEnforcementDate("2027-01-01") !== "2027-01-01") {
    throw new Error("Expected ISO date to be accepted");
  }
});

Deno.test("normalizeEnforcementDate rejects invalid values", () => {
  const invalidValues = ["", "2027-13-01", "UNKNOWN", null, 42, {}];

  for (const value of invalidValues) {
    if (normalizeEnforcementDate(value) !== null) {
      throw new Error(`Expected value to be rejected: ${String(value)}`);
    }
  }
});

Deno.test("normalizeExtractedIds supports both array and comma-separated string", () => {
  const fromArray = normalizeExtractedIds(["LOV-1", "LOV-2", 10]);
  const fromString = normalizeExtractedIds("LOV-1, LOV-2");

  if (!fromArray || fromArray.length !== 2) {
    throw new Error("Expected array normalization to keep only strings");
  }

  if (!fromString || fromString.length !== 2) {
    throw new Error("Expected string normalization to split entries");
  }
});
