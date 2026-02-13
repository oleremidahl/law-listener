import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  errorResponse,
  getErrorCode,
  getOrCreateRequestId,
  isTimeoutError,
  jsonResponse,
  Logger,
  withTimeout,
} from "../shared/logger.ts";
import { extractOpenAiOutputText, truncateForPrompt } from "./summary.ts";

const FUNCTION_NAME = "generate-proposal-summary";
const OPENAI_MODEL_ID = "gpt-4.1-mini";
const PROMPT_VERSION = "proposal_summary_v1";

const SUPABASE_TIMEOUT_MS = 10_000;
const SOURCE_FETCH_TIMEOUT_MS = 12_000;
const OPENAI_TIMEOUT_MS = 25_000;
const MIN_SOURCE_TEXT_LENGTH = 250;
const MAX_SOURCE_TEXT_CHARS = 12_000;

const DEFAULT_RETRY_COOLDOWN_SECONDS = 3600;
const DEFAULT_PENDING_TTL_SECONDS = 180;

type RequestPayload = {
  proposal_id?: unknown;
};

type ProposalRecord = {
  id: string;
  title: string;
  status: string;
  decision_date: string | null;
  enforcement_date: string | null;
  feed_description: string | null;
  stortinget_link: string | null;
  lovdata_link: string | null;
};

type ClaimDecision =
  | "claimed"
  | "already_ready"
  | "already_pending"
  | "cooldown";

type ClaimResponseRow = {
  decision: ClaimDecision;
  summary_id: string;
};

type SourceResult = {
  text: string;
  method: "jina";
  sourceUrl: string;
};

type TriggerStatus =
  | "started"
  | "pending"
  | "already_ready"
  | "cooldown"
  | "failed";

type ErrorClass = {
  code: string;
  messageSafe: string;
  retryable: boolean;
  classification:
    | "expected_error"
    | "infrastructure_error"
    | "timeout"
    | "model_error"
    | "data_integrity_error";
};

type ClassifiedError = Error & {
  meta: ErrorClass;
};

type OpenAiResponsePayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const value = Deno.env.get(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function makeClassifiedError(
  meta: ErrorClass,
  message?: string,
): ClassifiedError {
  const error = new Error(message ?? meta.messageSafe) as ClassifiedError;
  error.meta = meta;
  return error;
}

function getClassified(error: unknown): ErrorClass | null {
  if (
    error instanceof Error &&
    "meta" in error &&
    typeof (error as { meta?: unknown }).meta === "object"
  ) {
    return (error as ClassifiedError).meta;
  }

  return null;
}

function classifySupabaseError(error: unknown): ErrorClass {
  if (isTimeoutError(error)) {
    return {
      code: "timeout",
      messageSafe: "Supabase request timed out",
      retryable: true,
      classification: "timeout",
    };
  }

  const code = getErrorCode(error);

  if (typeof code === "string" && code.startsWith("23")) {
    return {
      code,
      messageSafe: "Data integrity error",
      retryable: false,
      classification: "data_integrity_error",
    };
  }

  if (code === "42501") {
    return {
      code,
      messageSafe: "Authorization error",
      retryable: false,
      classification: "infrastructure_error",
    };
  }

  return {
    code: code ?? "supabase_error",
    messageSafe: "Failed Supabase operation",
    retryable: true,
    classification: "infrastructure_error",
  };
}

function classifyOpenAiHttpStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) {
    return {
      code: "openai_auth_error",
      messageSafe: "OpenAI authentication failed",
      retryable: false,
      classification: "model_error",
    };
  }

  if (status === 429) {
    return {
      code: "openai_rate_limited",
      messageSafe: "OpenAI rate limit reached",
      retryable: true,
      classification: "model_error",
    };
  }

  if (status >= 500) {
    return {
      code: "openai_server_error",
      messageSafe: "OpenAI server error",
      retryable: true,
      classification: "model_error",
    };
  }

  return {
    code: `openai_http_${status}`,
    messageSafe: "OpenAI request failed",
    retryable: true,
    classification: "model_error",
  };
}

function classifyGenerationError(error: unknown): ErrorClass {
  const classified = getClassified(error);
  if (classified) {
    return classified;
  }

  if (isTimeoutError(error)) {
    return {
      code: "timeout",
      messageSafe: "Generation timed out",
      retryable: true,
      classification: "timeout",
    };
  }

  return {
    code: getErrorCode(error) ?? "generation_error",
    messageSafe: "Summary generation failed",
    retryable: true,
    classification: "infrastructure_error",
  };
}

function truncateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= 300) {
    return message;
  }

  return `${message.slice(0, 300)}...`;
}

function mapClaimDecision(decision: ClaimDecision): TriggerStatus {
  if (decision === "already_ready") {
    return "already_ready";
  }

  if (decision === "already_pending") {
    return "pending";
  }

  return "cooldown";
}

function createPrompt(
  proposal: ProposalRecord,
  sourceText: string,
): { system: string; user: string } {
  const system = [
    "Du oppsummerer norske lovforslag kort og nøkternt på norsk.",
    "Skriv kun vanlig tekst. Ikke bruk JSON, markdown-tabeller eller spesialformat.",
    "Hold deg til det som kan underbygges av kildeteksten.",
  ].join(" ");

  const user = [
    `Tittel: ${proposal.title}`,
    `Status: ${proposal.status}`,
    `Beslutningsdato: ${proposal.decision_date ?? "ukjent"}`,
    `Ikrafttredelse: ${proposal.enforcement_date ?? "ukjent"}`,
    `Stortinget-lenke: ${proposal.stortinget_link ?? "ukjent"}`,
    "",
    "Oppgave:",
    "Lag en kort og oversiktlig oppsummering av hva forslaget innebærer og hvem som kan bli berørt.",
    "Nevn usikkerhet hvis teksten er uklar.",
    "",
    "Kildetekst:",
    truncateForPrompt(sourceText, MAX_SOURCE_TEXT_CHARS),
  ].join("\n");

  return { system, user };
}

async function fetchViaJina(targetUrl: string): Promise<SourceResult> {
  const jinaUrl = `https://r.jina.ai/${targetUrl}`;

  const response = await withTimeout(
    fetch(jinaUrl, {
      method: "GET",
      headers: {
        "User-Agent": "law-listener/1.0",
        Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.8",
      },
    }),
    SOURCE_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw makeClassifiedError(
      {
        code: `jina_http_${response.status}`,
        messageSafe: "Jina source fetch failed",
        retryable: true,
        classification: "infrastructure_error",
      },
      `Jina source fetch failed with status ${response.status}`,
    );
  }

  const text = (await response.text()).trim();

  if (text.length < MIN_SOURCE_TEXT_LENGTH) {
    throw makeClassifiedError(
      {
        code: "jina_source_too_short",
        messageSafe: "Jina source text too short",
        retryable: true,
        classification: "expected_error",
      },
      "Jina source text too short",
    );
  }

  return {
    text,
    method: "jina",
    sourceUrl: targetUrl,
  };
}

async function fetchProposalSource(
  proposal: ProposalRecord,
): Promise<SourceResult> {
  if (!proposal.stortinget_link) {
    throw makeClassifiedError(
      {
        code: "missing_source_url",
        messageSafe: "Proposal source URL is missing",
        retryable: false,
        classification: "expected_error",
      },
      "Proposal source URL is missing",
    );
  }

  return await fetchViaJina(proposal.stortinget_link);
}

async function callOpenAiSummary(
  openAiApiKey: string,
  prompt: { system: string; user: string },
): Promise<{ summaryText: string; usage: OpenAiResponsePayload["usage"] }> {
  const response = await withTimeout(
    fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_ID,
        store: false,
        temperature: 0.2,
        max_output_tokens: 900,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: prompt.system }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: prompt.user }],
          },
        ],
      }),
    }),
    OPENAI_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw makeClassifiedError(classifyOpenAiHttpStatus(response.status));
  }

  const parsedResponse = await response.json() as OpenAiResponsePayload;
  const outputText = extractOpenAiOutputText(parsedResponse)?.trim();

  if (!outputText) {
    throw makeClassifiedError(
      {
        code: "openai_empty_output",
        messageSafe: "OpenAI returned empty output",
        retryable: true,
        classification: "model_error",
      },
      "OpenAI returned empty output",
    );
  }

  return {
    summaryText: outputText,
    usage: parsedResponse.usage,
  };
}

async function persistFailure(
  supabase: ReturnType<typeof createClient>,
  summaryId: string,
  classified: ErrorClass,
  retryCooldownSeconds: number,
): Promise<void> {
  const nextRetryAt = new Date(Date.now() + retryCooldownSeconds * 1000)
    .toISOString();

  const result = await withTimeout(
    supabase
      .from("proposal_summaries")
      .update({
        generation_status: "failed",
        generated_at: null,
        next_retry_at: nextRetryAt,
        last_error_code: classified.code,
        last_error_message_safe: classified.messageSafe,
      })
      .eq("id", summaryId),
    SUPABASE_TIMEOUT_MS,
  );

  const error = (result as { error?: unknown }).error;
  if (error) {
    throw makeClassifiedError(classifySupabaseError(error));
  }
}

async function persistSuccess(
  supabase: ReturnType<typeof createClient>,
  summaryId: string,
  summaryText: string,
  source: SourceResult,
): Promise<void> {
  const result = await withTimeout(
    supabase
      .from("proposal_summaries")
      .update({
        generation_status: "ready",
        summary_payload: summaryText,
        model_id: OPENAI_MODEL_ID,
        prompt_version: PROMPT_VERSION,
        source_url: source.sourceUrl,
        source_method: source.method,
        generated_at: new Date().toISOString(),
        next_retry_at: null,
        last_error_code: null,
        last_error_message_safe: null,
      })
      .eq("id", summaryId),
    SUPABASE_TIMEOUT_MS,
  );

  const error = (result as { error?: unknown }).error;
  if (error) {
    throw makeClassifiedError(classifySupabaseError(error));
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = getOrCreateRequestId(req);
  const logger = new Logger(FUNCTION_NAME, requestId);

  const retryCooldownSeconds = parsePositiveIntEnv(
    "SUMMARY_RETRY_COOLDOWN_SECONDS",
    DEFAULT_RETRY_COOLDOWN_SECONDS,
  );
  const pendingTtlSeconds = parsePositiveIntEnv(
    "SUMMARY_PENDING_TTL_SECONDS",
    DEFAULT_PENDING_TTL_SECONDS,
  );

  try {
    const incomingSecret = req.headers.get("x-summary-secret");
    const expectedSecret = Deno.env.get("SUMMARY_TRIGGER_SECRET");

    if (!incomingSecret || incomingSecret !== expectedSecret) {
      logger.warn("auth_failed", {
        classification: "expected_error",
        code: "invalid_secret",
      });

      return errorResponse(401, "Unauthorized", requestId, "invalid_secret");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openAiApiKey = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !supabaseKey || !openAiApiKey) {
      logger.error("configuration_missing", undefined, {
        has_supabase_url: Boolean(supabaseUrl),
        has_supabase_service_key: Boolean(supabaseKey),
        has_openai_api_key: Boolean(openAiApiKey),
        classification: "infrastructure_error",
      });

      return errorResponse(500, "Internal error", requestId, "config_missing");
    }

    let payload: RequestPayload;
    try {
      payload = await req.json() as RequestPayload;
    } catch {
      logger.warn("invalid_json", {
        classification: "expected_error",
      });

      return errorResponse(
        400,
        "Invalid request payload",
        requestId,
        "invalid_json",
      );
    }

    const proposalId = typeof payload.proposal_id === "string"
      ? payload.proposal_id.trim()
      : "";

    if (!proposalId || !isUuid(proposalId)) {
      logger.warn("invalid_payload", {
        has_proposal_id: Boolean(proposalId),
        classification: "expected_error",
      });

      return errorResponse(
        400,
        "Invalid request payload",
        requestId,
        "invalid_payload",
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const proposalResult = await withTimeout(
      supabase
        .from("law_proposals")
        .select(
          "id,title,status,decision_date,enforcement_date,feed_description,stortinget_link,lovdata_link",
        )
        .eq("id", proposalId)
        .maybeSingle(),
      SUPABASE_TIMEOUT_MS,
    );

    const proposalError = (proposalResult as { error?: unknown }).error;
    if (proposalError) {
      throw makeClassifiedError(classifySupabaseError(proposalError));
    }

    const proposal =
      (proposalResult as { data?: ProposalRecord | null }).data ?? null;

    if (!proposal) {
      return errorResponse(404, "Proposal not found", requestId, "not_found");
    }

    const claimResult = await withTimeout(
      supabase.rpc("claim_proposal_summary_generation", {
        p_proposal_id: proposal.id,
        p_proposal_status: proposal.status,
        p_pending_ttl_seconds: pendingTtlSeconds,
        p_retry_cooldown_seconds: retryCooldownSeconds,
        p_prompt_version: PROMPT_VERSION,
        p_model_id: OPENAI_MODEL_ID,
      }),
      SUPABASE_TIMEOUT_MS,
    );

    const claimError = (claimResult as { error?: unknown }).error;
    if (claimError) {
      throw makeClassifiedError(classifySupabaseError(claimError));
    }

    const claimRow =
      ((claimResult as { data?: ClaimResponseRow[] }).data ?? [])[0];

    if (!claimRow || !claimRow.summary_id || !claimRow.decision) {
      logger.error("claim_result_invalid", undefined, {
        classification: "infrastructure_error",
      });

      return errorResponse(500, "Internal error", requestId, "claim_invalid");
    }

    if (claimRow.decision !== "claimed") {
      const status = mapClaimDecision(claimRow.decision);

      logger.info("generation_claim_skipped", {
        proposal_id: proposalId,
        summary_id: claimRow.summary_id,
        status,
      });

      return jsonResponse(
        {
          status,
          request_id: requestId,
          proposal_id: proposalId,
          summary_id: claimRow.summary_id,
        },
        200,
        requestId,
      );
    }

    logger.info("generation_claimed", {
      proposal_id: proposalId,
      summary_id: claimRow.summary_id,
      status: proposal.status,
    });

    try {
      const source = await fetchProposalSource(proposal);
      const prompt = createPrompt(proposal, source.text);
      const openAi = await callOpenAiSummary(openAiApiKey, prompt);

      await persistSuccess(
        supabase,
        claimRow.summary_id,
        openAi.summaryText,
        source,
      );

      logger.info("summary_generation_completed", {
        proposal_id: proposalId,
        summary_id: claimRow.summary_id,
        source_method: source.method,
        usage_input_tokens: openAi.usage?.input_tokens,
        usage_output_tokens: openAi.usage?.output_tokens,
        usage_total_tokens: openAi.usage?.total_tokens,
      });

      return jsonResponse(
        {
          status: "started",
          request_id: requestId,
          proposal_id: proposalId,
          summary_id: claimRow.summary_id,
        },
        200,
        requestId,
      );
    } catch (generationError) {
      const classified = classifyGenerationError(generationError);

      logger.warn("summary_generation_failed", {
        proposal_id: proposalId,
        summary_id: claimRow.summary_id,
        code: classified.code,
        classification: classified.classification,
        retryable: classified.retryable,
        error_message: truncateErrorMessage(generationError),
      });

      try {
        await persistFailure(
          supabase,
          claimRow.summary_id,
          {
            ...classified,
            messageSafe: truncateErrorMessage(generationError),
          },
          retryCooldownSeconds,
        );
      } catch (persistError) {
        const persistClassified = classifyGenerationError(persistError);

        logger.error("summary_failure_persist_failed", persistError, {
          proposal_id: proposalId,
          summary_id: claimRow.summary_id,
          code: persistClassified.code,
          classification: persistClassified.classification,
        });

        return errorResponse(
          500,
          "Internal error",
          requestId,
          "persist_failure",
        );
      }

      return jsonResponse(
        {
          status: "failed",
          request_id: requestId,
          proposal_id: proposalId,
          summary_id: claimRow.summary_id,
        },
        200,
        requestId,
      );
    }
  } catch (error) {
    const classified = classifyGenerationError(error);

    logger.error("summary_generation_unhandled", error, {
      code: classified.code,
      classification: classified.classification,
    });

    return errorResponse(500, "Internal error", requestId, classified.code);
  }
});
