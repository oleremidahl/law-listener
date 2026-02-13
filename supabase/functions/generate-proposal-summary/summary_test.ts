import {
  extractBetweenComments,
  extractInnholdSection,
  extractOpenAiOutputText,
  isProposalSummaryPayload,
  stripHtmlTags,
  truncateForPrompt,
} from "./summary.ts";

Deno.test("extractBetweenComments returns section when markers exist", () => {
  const html =
    "prefix <!-- INNHOLD -->hej<p>verden</p><!-- /INNHOLD --> suffix";
  const extracted = extractBetweenComments(
    html,
    "<!-- INNHOLD -->",
    "<!-- /INNHOLD -->",
  );

  if (!extracted) {
    throw new Error("expected extracted section");
  }

  if (!extracted.includes("hej")) {
    throw new Error("expected extracted section to contain payload");
  }
});

Deno.test("extractInnholdSection strips html", () => {
  const html =
    "<!-- INNHOLD --><h1>Tittel</h1><p>Brødtekst&nbsp;her</p><!-- /INNHOLD -->";
  const extracted = extractInnholdSection(html);

  if (extracted !== "Tittel Brødtekst her") {
    throw new Error(`unexpected extracted text: ${extracted}`);
  }
});

Deno.test("stripHtmlTags collapses whitespace", () => {
  const stripped = stripHtmlTags("<p>  A   B </p><div>C</div>");

  if (stripped !== "A B C") {
    throw new Error(`unexpected stripped text: ${stripped}`);
  }
});

Deno.test("truncateForPrompt keeps shorter text unchanged", () => {
  const value = truncateForPrompt("kort tekst", 100);

  if (value !== "kort tekst") {
    throw new Error("expected unchanged text");
  }
});

Deno.test("truncateForPrompt truncates with ellipsis", () => {
  const value = truncateForPrompt("abcdef", 4);

  if (value !== "abcd...") {
    throw new Error(`unexpected truncated text: ${value}`);
  }
});

Deno.test("isProposalSummaryPayload validates expected shape", () => {
  const valid = {
    short_summary: "Kort oppsummering",
    law_changes: ["Endring 1"],
    affected_groups: ["Gruppe 1"],
    caveats: ["Forbehold"],
    sources: {
      proposal_url: "https://example.com",
      fetch_method: "jina",
    },
  };

  if (!isProposalSummaryPayload(valid)) {
    throw new Error("expected payload to be valid");
  }

  const invalid = {
    ...valid,
    law_changes: "ikke array",
  };

  if (isProposalSummaryPayload(invalid)) {
    throw new Error("expected invalid payload to be rejected");
  }
});

Deno.test("extractOpenAiOutputText prefers output_text", () => {
  const payload = {
    output_text: '{"short_summary":"Hei"}',
    output: [
      {
        content: [{ type: "output_text", text: "fallback" }],
      },
    ],
  };

  const output = extractOpenAiOutputText(payload);
  if (output !== '{"short_summary":"Hei"}') {
    throw new Error(`unexpected output text: ${output}`);
  }
});

Deno.test("extractOpenAiOutputText falls back to output content", () => {
  const payload = {
    output: [
      {
        content: [{ type: "output_text", text: '{"ok":true}' }],
      },
    ],
  };

  const output = extractOpenAiOutputText(payload);
  if (output !== '{"ok":true}') {
    throw new Error(`unexpected fallback output text: ${output}`);
  }
});
