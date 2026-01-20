import * as Sentry from "https://esm.sh/@sentry/deno@7.90.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Logger } from "../shared/logger.ts";

// Initialize Sentry once at module load
Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  environment: Deno.env.get("DENO_ENV") || "production",
  tracesSampleRate: 0.1,
});

const SUPABASE_TIMEOUT_MS = 10000; // 10 second timeout

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

Deno.serve(async (req) => {
  const logger = new Logger(
    "match-and-link-laws",
    req.headers.get("x-request-id") || undefined
  );
  const requestId = logger.getRequestId();

  try {
    // 1. Security Check
    const incomingSecret = req.headers.get("x-worker-secret");
    const localSecret = Deno.env.get("LAW_MATCHER_WORKER_SECRET");

    if (!incomingSecret || incomingSecret !== localSecret) {
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

    // 2. Parse request
    let proposal_id: string;
    let extracted_ids: string[];

    try {
      const body = await req.json();
      proposal_id = body.proposal_id;
      extracted_ids = body.extracted_ids;

      if (!proposal_id || !Array.isArray(extracted_ids)) {
        logger.warn("invalid_payload", {
          code: "missing_fields",
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

    logger.info("webhook_received", {
      proposal_id,
      extracted_ids_count: extracted_ids.length,
    });

    // 3. Init Supabase
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

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 4. Filter and handle empty IDs
    const cleanIds = extracted_ids.filter((id: string) => id.trim().length > 0);

    if (cleanIds.length === 0) {
      logger.info("no_ids_extracted", {
        proposal_id,
        classification: "expected_error",
      });

      try {
        await withTimeout(
          supabase
            .from("law_proposals")
            .update({ is_new_law: true })
            .eq("id", proposal_id),
          SUPABASE_TIMEOUT_MS
        );
      } catch (err) {
        logger.error(
          "mark_new_law_failed",
          err as Error,
          {
            proposal_id,
            classification: "infrastructure_error",
          },
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

      return new Response(
        JSON.stringify({
          status: "marked_as_new",
          proposal_id,
          request_id: requestId,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
        }
      );
    }

    // 5. Find matching documents
    let documents: any[] = [];
    try {
      const { data, error } = await withTimeout(
        supabase
          .from("legal_documents")
          .select("id")
          .in("legacy_id", cleanIds),
        SUPABASE_TIMEOUT_MS
      );

      if (error) throw error;
      documents = data || [];
    } catch (err) {
      const error = err as any;
      let classification = "infrastructure_error";
      let retryable = true;

      if (error.message === "timeout") {
        classification = "timeout";
      }

      logger.error(
        "fetch_documents_failed",
        error,
        {
          proposal_id,
          searched_ids_count: cleanIds.length,
          classification,
          retryable,
        },
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

    // 6. Handle no matches
    if (documents.length === 0) {
      logger.info("no_matches_found", {
        proposal_id,
        searched_ids_count: cleanIds.length,
        classification: "expected_error",
      });
      return new Response(
        JSON.stringify({
          status: "ids_not_found_in_db",
          proposal_id,
          searched: cleanIds.length,
          found: 0,
          request_id: requestId,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
        }
      );
    }

    // 7. Create links
    try {
      const linkEntries = documents.map((doc) => ({
        proposal_id,
        document_id: doc.id,
      }));

      await withTimeout(
        supabase
          .from("proposal_targets")
          .upsert(linkEntries, { onConflict: "proposal_id,document_id" }),
        SUPABASE_TIMEOUT_MS
      );

      logger.info("linking_completed", {
        proposal_id,
        searched_ids_count: cleanIds.length,
        found_count: documents.length,
        linked_count: linkEntries.length,
      });

      return new Response(
        JSON.stringify({
          status: "linked",
          proposal_id,
          linked_count: documents.length,
          request_id: requestId,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
        }
      );
    } catch (err) {
      const error = err as any;
      let classification = "infrastructure_error";
      let retryable = true;

      if (error.message === "timeout") {
        classification = "timeout";
      } else if (error.code?.startsWith("23")) {
        // Data integrity
        classification = "data_integrity_error";
        retryable = false;
      }

      logger.error(
        "linking_failed",
        error,
        {
          proposal_id,
          found_count: documents.length,
          classification,
          retryable,
        },
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
  } catch (err) {
    const logger = new Logger("match-and-link-laws");
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