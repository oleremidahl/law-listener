import {
  errorResponse,
  getErrorCode,
  getOrCreateRequestId,
  isTimeoutError,
  jsonResponse,
  sanitizeContext,
  withTimeout,
} from "./logger.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("getOrCreateRequestId uses inbound header", () => {
  const req = new Request("https://example.com", {
    headers: {
      "x-request-id": "req-123",
    },
  });

  assert(
    getOrCreateRequestId(req) === "req-123",
    "expected request id from header",
  );
});

Deno.test("getOrCreateRequestId generates when missing", () => {
  const req = new Request("https://example.com");
  const requestId = getOrCreateRequestId(req);

  assert(requestId.length > 0, "expected generated request id");
});

Deno.test("sanitizeContext redacts sensitive keys", () => {
  const sanitized = sanitizeContext({
    api_key: "secret",
    html_body: "<div>hello</div>",
    count: 3,
  });

  assert(sanitized.api_key === "[redacted]", "api_key should be redacted");
  assert(sanitized.html_body === "[redacted]", "html_body should be redacted");
  assert(sanitized.count === 3, "count should remain safe");
});

Deno.test("jsonResponse returns request id header", async () => {
  const res = jsonResponse({ status: "ok" }, 200, "req-456");

  assert(
    res.headers.get("X-Request-ID") === "req-456",
    "missing request id header",
  );
  assert(
    res.headers.get("Content-Type") === "application/json",
    "missing content type",
  );

  const parsed = await res.json();
  assert(parsed.status === "ok", "unexpected body value");
});

Deno.test("errorResponse includes standard shape", async () => {
  const res = errorResponse(500, "Internal error", "req-789", "timeout");
  const parsed = await res.json();

  assert(parsed.error === "Internal error", "missing error message");
  assert(parsed.request_id === "req-789", "missing request id");
  assert(parsed.code === "timeout", "missing error code");
});

Deno.test("withTimeout returns timeout errors", async () => {
  let timedOut = false;
  let pendingTimer: number | undefined;

  try {
    const slowPromise = new Promise((resolve) => {
      pendingTimer = setTimeout(resolve, 100);
    });

    await withTimeout(
      slowPromise,
      10,
    );
  } catch (error) {
    timedOut = isTimeoutError(error);
  } finally {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
    }
  }

  assert(timedOut, "expected timeout error");
});

Deno.test("getErrorCode extracts code fields", () => {
  assert(getErrorCode({ code: "23505" }) === "23505", "expected postgres code");
  assert(
    getErrorCode(new Error("x")) === undefined,
    "unexpected code on plain error",
  );
});
