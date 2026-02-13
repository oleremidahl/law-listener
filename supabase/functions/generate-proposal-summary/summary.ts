export interface ProposalSummaryPayload {
  short_summary: string;
  law_changes: string[];
  affected_groups: string[];
  caveats: string[];
  sources: {
    proposal_url: string;
    fetch_method: string;
  };
}

export function extractBetweenComments(
  html: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const startIndex = html.indexOf(startMarker);
  if (startIndex < 0) {
    return null;
  }

  const contentStart = startIndex + startMarker.length;
  const endIndex = html.indexOf(endMarker, contentStart);

  if (endIndex < 0 || endIndex <= contentStart) {
    return null;
  }

  return html.slice(contentStart, endIndex).trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripHtmlTags(html: string): string {
  const withoutTags = html.replace(/<[^>]*>/g, " ");
  const normalizedEntities = withoutTags
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#160;", " ");

  return collapseWhitespace(normalizedEntities);
}

export function extractInnholdSection(html: string): string | null {
  const section = extractBetweenComments(
    html,
    "<!-- INNHOLD -->",
    "<!-- /INNHOLD -->",
  );

  if (!section) {
    return null;
  }

  const text = stripHtmlTags(section);
  return text.length > 0 ? text : null;
}

export function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

export function isProposalSummaryPayload(
  value: unknown,
): value is ProposalSummaryPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const sources = candidate.sources;

  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    return false;
  }

  const sourceRecord = sources as Record<string, unknown>;

  return typeof candidate.short_summary === "string" &&
    isStringArray(candidate.law_changes) &&
    isStringArray(candidate.affected_groups) &&
    isStringArray(candidate.caveats) &&
    typeof sourceRecord.proposal_url === "string" &&
    typeof sourceRecord.fetch_method === "string";
}

export function extractOpenAiOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const response = payload as {
    output_text?: unknown;
    output?: Array<{
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };

  if (
    typeof response.output_text === "string" &&
    response.output_text.trim().length > 0
  ) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return null;
  }

  for (const item of response.output) {
    if (!item || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (
        contentItem?.type === "output_text" &&
        typeof contentItem.text === "string" &&
        contentItem.text.trim().length > 0
      ) {
        return contentItem.text;
      }
    }
  }

  return null;
}
