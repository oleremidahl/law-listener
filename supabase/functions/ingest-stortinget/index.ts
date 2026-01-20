import * as Sentry from "https://esm.sh/@sentry/deno@7.90.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Logger, FailedItem } from "../shared/logger.ts";

// Initialize Sentry once at module load
Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  environment: Deno.env.get("DENO_ENV") || "production",
  tracesSampleRate: 0.1,
});

interface IngestionResponse {
  status: "ok" | "partial" | "error";
  processed: number;
  succeeded: number;
  failed: number;
  failures: FailedItem[];
  request_id: string;
}

interface IngestionItem {
  stortinget_id?: string;
  [key: string]: unknown;
}

const SUPABASE_TIMEOUT_MS = 10000; // 10 second timeout

// Helper to add timeout to Supabase promises
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs)
    ),
  ]);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const logger = new Logger(
    "ingest-stortinget",
    req.headers.get("x-request-id") || undefined
  );
  const requestId = logger.getRequestId();

  try {
    const secret = req.headers.get("x-ingest-secret");
    if (!secret || secret !== Deno.env.get("STORTINGET_WORKER_SECRET")) {
      logger.warn("auth_failed", { code: "invalid_secret" });
      return new Response(
        JSON.stringify({ error: "Unauthorized", request_id: requestId }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
        }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      logger.error(
        "config_error",
        new Error("Missing Supabase configuration"),
        { hasUrl: !!supabaseUrl, hasKey: !!supabaseKey },
        true
      );
      return new Response(
        JSON.stringify({ error: "Internal error", request_id: requestId }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
        }
      );
    }

    let items: IngestionItem[];
    try {
      const body = await req.json();
      items = body.items;

      if (!Array.isArray(items)) {
        logger.warn("invalid_payload", {
          code: "items_not_array",
          classification: "client_error",
          retryable: false,
        });
        return new Response(
          JSON.stringify({
            error: "Invalid request payload",
            request_id: requestId,
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "X-Request-ID": requestId,
            },
          }
        );
      }

      if (items.length === 0) {
        logger.info("empty_batch", { count: 0 });
        return new Response(
          JSON.stringify({
            status: "ok",
            processed: 0,
            succeeded: 0,
            failed: 0,
            failures: [],
            request_id: requestId,
          } as IngestionResponse),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-ID": requestId,
            },
          }
        );
      }
    } catch (err) {
      logger.error(
        "json_parse_error",
        err as Error,
        {
          code: "invalid_json",
          classification: "client_error",
          retryable: false,
        }
      );
      return new Response(
        JSON.stringify({
          error: "Invalid request payload",
          request_id: requestId,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
        }
      );
    }

    logger.info("ingest_started", { batch_size: items.length });

    const supabaseAdmin = createClient(supabaseUrl, supabaseKey);
    const failures: FailedItem[] = [];
    let succeeded = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemId = item.stortinget_id || `unknown_${i}`;

      try {
        await withTimeout(
          supabaseAdmin
            .from("law_proposals")
            .upsert(item, {
              onConflict: "stortinget_id",
              ignoreDuplicates: true,
            }),
          SUPABASE_TIMEOUT_MS
        );
        succeeded++;
        logger.debug("item_upserted", {
          item_id: itemId,
          position: i + 1,
        });
      } catch (err) {
        const error = err as any;
        let code = "unknown_error";
        let message_safe = "Failed to process item";
        let retryable = true;

        if (error.message === "timeout") {
          code = "timeout";
          message_safe = "Request timeout";
          retryable = true;
        } else if (error.code === "23505") {
          // Duplicate key - idempotent, not retryable
          code = "duplicate_key";
          message_safe = "Item already exists (idempotent)";
          retryable = false;
          succeeded++; // Count as success since upsert is idempotent
        } else if (error.code?.startsWith("23")) {
          // Data integrity error
          code = error.code;
          message_safe = "Data integrity error";
          retryable = false;
        } else {
          code = error.code || "unknown_error";
          message_safe = "Failed to upsert item";
          retryable = !error.message?.includes("permission");
        }

        failures.push({
          stortinget_id: itemId,
          code,
          message_safe,
          retryable,
        });

        logger.warn(
          "item_upsert_failed",
          {
            item_id: itemId,
            error_code: code,
            classification: "expected_error",
            retryable,
            position: i + 1,
          }
        );
      }
    }

    // 5. Return response
    const failed = failures.length;
    const response: IngestionResponse = {
      status: failed === 0 ? "ok" : "partial",
      processed: items.length,
      succeeded,
      failed,
      failures,
      request_id: requestId,
    };

    if (failed === 0) {
      logger.info("ingest_completed", {
        batch_size: items.length,
        succeeded,
        status: "ok",
      });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
      });
    } else if (succeeded > 0) {
      logger.warn(
        "ingest_completed_partial",
        {
          batch_size: items.length,
          succeeded,
          failed,
          status: "partial",
          classification: "expected_error",
        }
      );
      return new Response(JSON.stringify(response), {
        status: 207, // Multi-Status
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
      });
    } else {
      // All failed
      logger.error(
        "ingest_completed_failure",
        new Error(`All ${items.length} items failed to upsert`),
        {
          batch_size: items.length,
          failed: items.length,
          classification: "infrastructure_error",
        },
        true
      );
      return new Response(JSON.stringify(response), {
        status: 503, // Service Unavailable
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
      });
    }
  } catch (err) {
    const logger = new Logger("ingest-stortinget");
    await logger.fatal(
      "unhandled_error",
      err as Error,
      { classification: "unexpected_error" }
    );

    return new Response(
      JSON.stringify({
        error: "Internal error",
        request_id: logger.getRequestId(),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": logger.getRequestId(),
        },
      }
    );
  }
});


