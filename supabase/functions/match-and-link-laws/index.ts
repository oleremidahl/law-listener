import { createClient } from "@supabase/supabase-js";
import {
  errorResponse,
  getErrorCode,
  getOrCreateRequestId,
  isTimeoutError,
  jsonResponse,
  Logger,
  withTimeout,
} from "../shared/logger.ts";

const SUPABASE_TIMEOUT_MS = 10_000;

type RequestPayload = {
  proposal_id?: unknown;
  extracted_ids?: unknown;
};

type MatchErrorClassification = {
  code: string;
  retryable: boolean;
  classification: "timeout" | "data_integrity_error" | "infrastructure_error";
};

function classifyMatchError(error: unknown): MatchErrorClassification {
  if (isTimeoutError(error)) {
    return {
      code: "timeout",
      retryable: true,
      classification: "timeout",
    };
  }

  const code = getErrorCode(error);

  if (typeof code === "string" && code.startsWith("23")) {
    return {
      code,
      retryable: false,
      classification: "data_integrity_error",
    };
  }

  if (code === "42501") {
    return {
      code,
      retryable: false,
      classification: "infrastructure_error",
    };
  }

  return {
    code: code ?? "internal_failure",
    retryable: true,
    classification: "infrastructure_error",
  };
}

function normalizeExtractedIds(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim());
  }

  return null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = getOrCreateRequestId(req);
  const logger = new Logger("match-and-link-laws", requestId);

  try {
    const incomingSecret = req.headers.get("x-worker-secret");
    const localSecret = Deno.env.get("LAW_MATCHER_WORKER_SECRET");

    if (!incomingSecret || incomingSecret !== localSecret) {
      logger.warn("auth_failed", {
        classification: "expected_error",
        code: "invalid_secret",
      });

      return errorResponse(401, "Unauthorized", requestId, "invalid_secret");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      logger.error("configuration_missing", undefined, {
        has_supabase_url: Boolean(supabaseUrl),
        has_supabase_service_key: Boolean(supabaseKey),
        classification: "infrastructure_error",
      });

      return errorResponse(500, "Internal error", requestId, "config_missing");
    }

    let payload: RequestPayload;
    try {
      payload = (await req.json()) as RequestPayload;
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
    const extractedIds = normalizeExtractedIds(payload.extracted_ids);

    if (!proposalId || extractedIds === null) {
      logger.warn("invalid_payload", {
        classification: "expected_error",
        has_proposal_id: Boolean(proposalId),
        extracted_ids_type: typeof payload.extracted_ids,
      });

      return errorResponse(
        400,
        "Invalid request payload",
        requestId,
        "invalid_payload",
      );
    }

    const cleanIds = extractedIds
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    const supabase = createClient(supabaseUrl, supabaseKey);

    if (cleanIds.length === 0) {
      logger.info("no_ids_extracted", {
        proposal_id: proposalId,
        classification: "expected_error",
      });

      try {
        const updateResult = await withTimeout(
          supabase
            .from("law_proposals")
            .update({ is_new_law: true })
            .eq("id", proposalId),
          SUPABASE_TIMEOUT_MS,
        );

        const updateError = (updateResult as { error?: unknown }).error;
        if (updateError) {
          throw updateError;
        }
      } catch (error) {
        const classified = classifyMatchError(error);

        logger.error("mark_new_law_failed", error, {
          proposal_id: proposalId,
          classification: classified.classification,
          retryable: classified.retryable,
          code: classified.code,
        });

        return errorResponse(500, "Internal error", requestId, classified.code);
      }

      return jsonResponse(
        {
          status: "marked_as_new",
          proposal_id: proposalId,
          request_id: requestId,
        },
        200,
        requestId,
      );
    }

    let documents: { id: string }[] = [];

    try {
      const fetchResult = await withTimeout(
        supabase
          .from("legal_documents")
          .select("id")
          .in("legacy_id", cleanIds),
        SUPABASE_TIMEOUT_MS,
      );

      const fetchError = (fetchResult as { error?: unknown }).error;
      if (fetchError) {
        throw fetchError;
      }

      documents = (fetchResult as { data?: { id: string }[] }).data ?? [];
    } catch (error) {
      const classified = classifyMatchError(error);

      logger.error("fetch_documents_failed", error, {
        proposal_id: proposalId,
        searched_ids_count: cleanIds.length,
        classification: classified.classification,
        retryable: classified.retryable,
        code: classified.code,
      });

      return errorResponse(500, "Internal error", requestId, classified.code);
    }

    if (documents.length === 0) {
      logger.info("no_matches_found", {
        proposal_id: proposalId,
        searched_ids_count: cleanIds.length,
        classification: "expected_error",
      });

      return jsonResponse(
        {
          status: "ids_not_found_in_db",
          proposal_id: proposalId,
          searched: cleanIds.length,
          found: 0,
          request_id: requestId,
        },
        200,
        requestId,
      );
    }

    try {
      const linkEntries = documents.map((document) => ({
        proposal_id: proposalId,
        document_id: document.id,
      }));

      const upsertResult = await withTimeout(
        supabase
          .from("proposal_targets")
          .upsert(linkEntries, { onConflict: "proposal_id,document_id" }),
        SUPABASE_TIMEOUT_MS,
      );

      const upsertError = (upsertResult as { error?: unknown }).error;
      if (upsertError) {
        throw upsertError;
      }

      logger.info("linking_completed", {
        proposal_id: proposalId,
        searched_ids_count: cleanIds.length,
        found_count: documents.length,
        linked_count: linkEntries.length,
      });

      return jsonResponse(
        {
          status: "linked",
          proposal_id: proposalId,
          linked_count: linkEntries.length,
          request_id: requestId,
        },
        200,
        requestId,
      );
    } catch (error) {
      const classified = classifyMatchError(error);

      logger.error("linking_failed", error, {
        proposal_id: proposalId,
        found_count: documents.length,
        classification: classified.classification,
        retryable: classified.retryable,
        code: classified.code,
      });

      return errorResponse(500, "Internal error", requestId, classified.code);
    }
  } catch (error) {
    await logger.fatal("unhandled_error", error, {
      classification: "unexpected_error",
    });

    return errorResponse(500, "Internal error", requestId, "unexpected_error");
  }
});
