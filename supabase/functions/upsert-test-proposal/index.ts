import * as Sentry from "https://esm.sh/@sentry/deno@7.90.0";
import { Logger } from "../shared/logger.ts";

// Initialize Sentry once at module load
Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  environment: Deno.env.get("DENO_ENV") || "production",
  tracesSampleRate: 0.1,
});

Deno.serve(async (req: Request) => {
  const logger = new Logger(
    "upsert-test-proposal",
    req.headers.get("x-request-id") || undefined
  );
  const requestId = logger.getRequestId();

  try {
    logger.info("test_function_started");

    // Throw error to test Sentry integration
    throw new Error("TEST_ERROR: This is a test error for Sentry integration");

  } catch (err) {
    await logger.fatal(
      "sentry_test_error",
      err as Error,
      { request_id: requestId }
    );

    return new Response(
      JSON.stringify({
        error: "Internal error",
        request_id: requestId,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
      }
    );
  }
});