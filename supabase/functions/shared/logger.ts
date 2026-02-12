import * as Sentry from "https://esm.sh/@sentry/deno@7.90.0";

export interface LogContext {
  [key: string]: unknown;
}

export interface FailedItem {
  stortinget_id?: string;
  code: string;
  message_safe: string;
  retryable: boolean;
}

export interface ErrorBody {
  error: string;
  request_id: string;
  code?: string;
}

type LogLevel = "debug" | "info" | "warn" | "error";

type ErrorLike = {
  message?: unknown;
  name?: unknown;
  stack?: unknown;
  code?: unknown;
};

const REQUEST_ID_HEADER = "x-request-id";
const RESPONSE_REQUEST_ID_HEADER = "X-Request-ID";
const LOG_LEVEL_ENV = "LOG_LEVEL";
const STRING_MAX_LENGTH = 512;
const SAFE_SENSITIVE_SUFFIX_PATTERN = /(?:_|-)(type|length|count)$/i;

const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|authorization|cookie|api[-_]?key|private[-_]?key|dsn|payload|body|html|content|text)/i;

const GLOBAL_STATE = globalThis as typeof globalThis & {
  __LAW_LISTENER_UNHANDLED_INSTALLED__?: boolean;
  __LAW_LISTENER_SENTRY_INIT__?: boolean;
};

function sanitizeString(value: string): string {
  if (value.length <= STRING_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, STRING_MAX_LENGTH)}...[truncated]`;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(sanitizeString(error));
  }

  if (error && typeof error === "object") {
    const candidate = error as ErrorLike;
    if (typeof candidate.message === "string") {
      return new Error(sanitizeString(candidate.message));
    }
  }

  return new Error("unknown_error");
}

export function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as ErrorLike;
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

export function isTimeoutError(error: unknown): boolean {
  return toError(error).message === "timeout";
}

function sanitizeValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }

  if (value instanceof Error) {
    return `${value.name}: ${sanitizeString(value.message)}`;
  }

  if (typeof value === "object") {
    return "[object]";
  }

  return String(value);
}

export function sanitizeContext(
  context: LogContext = {},
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(context)) {
    if (rawValue === undefined) {
      continue;
    }

    if (
      SENSITIVE_KEY_PATTERN.test(key) &&
      !SAFE_SENSITIVE_SUFFIX_PATTERN.test(key)
    ) {
      sanitized[key] = "[redacted]";
      continue;
    }

    sanitized[key] = sanitizeValue(rawValue);
  }

  return sanitized;
}

function getEnvironment(): string {
  return (
    Deno.env.get("DENO_ENV") ??
      Deno.env.get("SUPABASE_ENV") ??
      Deno.env.get("ENV") ??
      "production"
  );
}

function sentryEnabled(): boolean {
  const dsn = Deno.env.get("SENTRY_DSN");
  return typeof dsn === "string" && dsn.trim().length > 0;
}

function getSentry(): typeof Sentry | null {
  if (!sentryEnabled()) {
    return null;
  }

  if (!GLOBAL_STATE.__LAW_LISTENER_SENTRY_INIT__) {
    try {
      Sentry.init({
        dsn: Deno.env.get("SENTRY_DSN"),
        environment: getEnvironment(),
        tracesSampleRate: 0.1,
      });
      GLOBAL_STATE.__LAW_LISTENER_SENTRY_INIT__ = true;
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "sentry_init_failed",
          function: "edge-runtime",
          request_id: "global",
          duration_ms: 0,
          error_message: toError(error).message,
        }),
      );
      return null;
    }
  }

  return Sentry;
}

async function captureSentry(
  level: "error" | "fatal",
  functionName: string,
  requestId: string,
  error: Error,
  context: LogContext,
  flush: boolean,
): Promise<void> {
  const sentry = getSentry();
  if (!sentry) {
    return;
  }

  try {
    sentry.captureException(error, {
      level,
      tags: {
        function: functionName,
        request_id: requestId,
      },
      contexts: {
        metadata: sanitizeContext(context),
      },
    });

    if (flush) {
      await sentry.flush(2000);
    }
  } catch {
    // Fail-open: never break request flow because of monitoring.
  }
}

function registerGlobalUnhandledHandlers(): void {
  if (GLOBAL_STATE.__LAW_LISTENER_UNHANDLED_INSTALLED__) {
    return;
  }

  GLOBAL_STATE.__LAW_LISTENER_UNHANDLED_INSTALLED__ = true;

  globalThis.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const error = toError(event.reason);
      const payload = {
        timestamp: new Date().toISOString(),
        level: "error",
        event: "unhandled_rejection",
        request_id: "global",
        function: "edge-runtime",
        duration_ms: 0,
        error_name: error.name,
        error_message: error.message,
        classification: "unexpected_error",
      };

      console.error(JSON.stringify(payload));
      void captureSentry(
        "fatal",
        "edge-runtime",
        "global",
        error,
        { classification: "unexpected_error", source: "unhandledrejection" },
        false,
      );
    },
  );

  globalThis.addEventListener("error", (event: ErrorEvent) => {
    const error = toError(event.error ?? event.message);
    const payload = {
      timestamp: new Date().toISOString(),
      level: "error",
      event: "unhandled_error",
      request_id: "global",
      function: "edge-runtime",
      duration_ms: 0,
      error_name: error.name,
      error_message: error.message,
      classification: "unexpected_error",
    };

    console.error(JSON.stringify(payload));
    void captureSentry(
      "fatal",
      "edge-runtime",
      "global",
      error,
      { classification: "unexpected_error", source: "error" },
      false,
    );
  });
}

export class Logger {
  private readonly requestId: string;
  private readonly functionName: string;
  private readonly startTime: number;
  private readonly debugEnabled: boolean;

  constructor(functionName: string, requestId?: string) {
    this.functionName = functionName;
    this.requestId = requestId ?? crypto.randomUUID();
    this.startTime = Date.now();
    this.debugEnabled =
      (Deno.env.get(LOG_LEVEL_ENV) ?? "info").toLowerCase() === "debug";

    registerGlobalUnhandledHandlers();
  }

  getRequestId(): string {
    return this.requestId;
  }

  private write(
    level: LogLevel,
    event: string,
    context: LogContext = {},
  ): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      request_id: this.requestId,
      function: this.functionName,
      duration_ms: Date.now() - this.startTime,
      ...sanitizeContext(context),
    };

    const serialized = JSON.stringify(payload);

    if (level === "error") {
      console.error(serialized);
      return;
    }

    if (level === "warn") {
      console.warn(serialized);
      return;
    }

    console.log(serialized);
  }

  debug(event: string, context?: LogContext): void {
    if (!this.debugEnabled) {
      return;
    }

    this.write("debug", event, context);
  }

  info(event: string, context?: LogContext): void {
    this.write("info", event, context);
  }

  warn(event: string, context?: LogContext): void {
    this.write("warn", event, context);
  }

  error(event: string, error?: unknown, context: LogContext = {}): void {
    const normalized = error ? toError(error) : undefined;
    const merged = {
      ...context,
      error_name: normalized?.name,
      error_message: normalized?.message,
      error_code: getErrorCode(error),
    };

    this.write("error", event, merged);

    if (normalized) {
      void captureSentry(
        "error",
        this.functionName,
        this.requestId,
        normalized,
        merged,
        false,
      );
    }
  }

  async fatal(
    event: string,
    error?: unknown,
    context: LogContext = {},
  ): Promise<void> {
    const normalized = error ? toError(error) : new Error(event);
    const merged = {
      ...context,
      error_name: normalized.name,
      error_message: normalized.message,
      error_code: getErrorCode(error),
      severity: "fatal",
    };

    this.write("error", event, merged);

    await captureSentry(
      "fatal",
      this.functionName,
      this.requestId,
      normalized,
      merged,
      true,
    );
  }
}

export function getOrCreateRequestId(req: Request): string {
  const incoming = req.headers.get(REQUEST_ID_HEADER)?.trim();
  if (incoming && incoming.length > 0) {
    return incoming;
  }

  return crypto.randomUUID();
}

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  initHeaders?: HeadersInit,
): Response {
  const headers = new Headers(initHeaders);
  headers.set("Content-Type", "application/json");
  headers.set(RESPONSE_REQUEST_ID_HEADER, requestId);

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function errorResponse(
  status: number,
  error: string,
  requestId: string,
  code?: string,
): Response {
  const body: ErrorBody = {
    error,
    request_id: requestId,
  };

  if (code) {
    body.code = code;
  }

  return jsonResponse(body, status, requestId);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: number | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
