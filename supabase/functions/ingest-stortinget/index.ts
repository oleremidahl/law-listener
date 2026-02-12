import { createClient } from "@supabase/supabase-js";
import {
  errorResponse,
  FailedItem,
  getErrorCode,
  getOrCreateRequestId,
  isTimeoutError,
  jsonResponse,
  Logger,
  withTimeout,
} from "../shared/logger.ts";

const SUPABASE_TIMEOUT_MS = 10_000;

type IngestionItem = {
  stortinget_id?: string;
  [key: string]: unknown;
};

type IngestionResponse = {
  status: "ok" | "partial" | "error";
  processed: number;
  succeeded: number;
  failed: number;
  failures: FailedItem[];
  request_id: string;
};

type IngestErrorClassification = {
  code: string;
  message_safe: string;
  retryable: boolean;
  classification:
    | "expected_error"
    | "infrastructure_error"
    | "timeout"
    | "data_integrity_error";
};

function classifyUpsertError(error: unknown): IngestErrorClassification {
  if (isTimeoutError(error)) {
    return {
      code: "timeout",
      message_safe: "Supabase request timed out",
      retryable: true,
      classification: "timeout",
    };
  }

  const code = getErrorCode(error);

  if (code === "23505") {
    return {
      code,
      message_safe: "Duplicate row",
      retryable: false,
      classification: "expected_error",
    };
  }

  if (typeof code === "string" && code.startsWith("23")) {
    return {
      code,
      message_safe: "Data integrity error",
      retryable: false,
      classification: "data_integrity_error",
    };
  }

  if (code === "42501") {
    return {
      code,
      message_safe: "Authorization error",
      retryable: false,
      classification: "infrastructure_error",
    };
  }

  return {
    code: code ?? "unknown_error",
    message_safe: "Failed to upsert item",
    retryable: true,
    classification: "infrastructure_error",
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = getOrCreateRequestId(req);
  const logger = new Logger("ingest-stortinget", requestId);

  try {
    const secret = req.headers.get("x-ingest-secret");
    if (!secret || secret !== Deno.env.get("STORTINGET_WORKER_SECRET")) {
      logger.warn("auth_failed", {
        code: "invalid_secret",
        classification: "expected_error",
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

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch (error) {
      logger.warn("invalid_json", {
        classification: "expected_error",
        error_code: getErrorCode(error),
      });

      return errorResponse(
        400,
        "Invalid request payload",
        requestId,
        "invalid_json",
      );
    }

    const itemsRaw = (parsedBody as { items?: unknown }).items;
    if (!Array.isArray(itemsRaw)) {
      logger.warn("invalid_payload", {
        classification: "expected_error",
        payload_type: typeof itemsRaw,
      });

      return errorResponse(
        400,
        "Invalid request payload",
        requestId,
        "invalid_payload",
      );
    }

    if (
      !itemsRaw.every(
        (item) =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    ) {
      logger.warn("invalid_payload_items", {
        classification: "expected_error",
      });

      return errorResponse(
        400,
        "Invalid request payload",
        requestId,
        "invalid_payload_items",
      );
    }

    const items = itemsRaw as IngestionItem[];
    const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

    logger.info("ingest_started", {
      batch_size: items.length,
    });

    const failures: FailedItem[] = [];
    let succeeded = 0;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const itemId =
        typeof item.stortinget_id === "string" && item.stortinget_id.length > 0
          ? item.stortinget_id
          : `unknown_${index + 1}`;

      try {
        const upsertResult = await withTimeout(
          supabaseAdmin
            .from("law_proposals")
            .upsert(item, {
              onConflict: "stortinget_id",
              ignoreDuplicates: true,
            }),
          SUPABASE_TIMEOUT_MS,
        );

        const upsertError = (upsertResult as { error?: unknown }).error;
        if (upsertError) {
          throw upsertError;
        }

        succeeded += 1;
      } catch (error) {
        const classified = classifyUpsertError(error);

        if (classified.code === "23505") {
          // Treat duplicate key as idempotent success.
          succeeded += 1;
          logger.debug("item_upsert_duplicate", {
            item_id: itemId,
            position: index + 1,
            classification: "expected_error",
            retryable: false,
            error_code: classified.code,
          });
        } else {
          failures.push({
            stortinget_id: itemId,
            code: classified.code,
            message_safe: classified.message_safe,
            retryable: classified.retryable,
          });
          logger.warn("item_upsert_failed", {
            item_id: itemId,
            position: index + 1,
            classification: classified.classification,
            retryable: classified.retryable,
            error_code: classified.code,
          });
        }
      }
    }

    const failed = failures.length;
    const response: IngestionResponse = {
      status: failed === 0 ? "ok" : succeeded > 0 ? "partial" : "error",
      processed: items.length,
      succeeded,
      failed,
      failures,
      request_id: requestId,
    };

    if (failed === 0) {
      logger.info("ingest_completed", {
        processed: items.length,
        succeeded,
        failed,
      });

      return jsonResponse(response, 200, requestId);
    }

    if (succeeded > 0) {
      logger.warn("ingest_partial_failure", {
        processed: items.length,
        succeeded,
        failed,
      });

      return jsonResponse(response, 200, requestId);
    }

    logger.error("ingest_failed", undefined, {
      processed: items.length,
      failed,
      classification: "infrastructure_error",
    });

    return jsonResponse(response, 503, requestId);
  } catch (error) {
    await logger.fatal("unhandled_error", error, {
      classification: "unexpected_error",
    });

    return errorResponse(500, "Internal error", requestId, "unexpected_error");
  }
});
