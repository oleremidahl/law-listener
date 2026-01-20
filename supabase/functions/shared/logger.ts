// supabase/functions/shared/logger.ts
// Structured logging utility for all edge functions with Sentry integration

import * as Sentry from "https://esm.sh/@sentry/deno@7.90.0";

export interface LogContext {
  requestId?: string;
  functionName?: string;
  elapsed_ms?: number;
  proposalId?: string;
  batchSize?: number;
  [key: string]: unknown;
}

export interface FailedItem {
  stortinget_id?: string;
  id?: string;
  code: string;
  message_safe: string;
  retryable: boolean;
}

type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  private requestId: string;
  private startTime: number;
  private functionName: string;

  constructor(functionName: string, requestId?: string) {
    this.requestId = requestId || crypto.randomUUID();
    this.startTime = Date.now();
    this.functionName = functionName;

    // Set up global unhandled error handlers
    this.setupGlobalHandlers();
  }

  private setupGlobalHandlers() {
    globalThis.addEventListener("unhandledrejection", (event) => {
      this.error("unhandled_rejection", new Error(String(event.reason)), {
        handled: false,
        error_class: "UnhandledRejection",
      });

      // Send to Sentry with fire-and-forget flush
      Sentry.captureException(event.reason, {
        tags: { function: this.functionName, request_id: this.requestId },
        level: "fatal",
      });
      Sentry.flush(2000).catch(() => {});
    });

    globalThis.addEventListener("error", (event) => {
      this.error("unhandled_error", event.error || new Error(event.message), {
        handled: false,
        error_class: "UnhandledError",
      });

      // Send to Sentry with fire-and-forget flush
      Sentry.captureException(event.error, {
        tags: { function: this.functionName, request_id: this.requestId },
        level: "fatal",
      });
      Sentry.flush(2000).catch(() => {});
    });
  }

  private isDebugEnabled(): boolean {
    return Deno.env.get("LOG_LEVEL") === "debug";
  }

  private formatLog(level: LogLevel, message: string, data?: LogContext) {
    const elapsed_ms = Date.now() - this.startTime;
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      functionName: this.functionName,
      requestId: this.requestId,
      elapsed_ms,
      ...data,
    });
  }

  debug(message: string, data?: LogContext) {
    if (!this.isDebugEnabled()) return;
    console.log(this.formatLog("debug", message, data));
  }

  info(message: string, data?: LogContext) {
    console.log(this.formatLog("info", message, data));
  }

  warn(
    message: string,
    data?: LogContext,
    shouldSendToSentry = false
  ): Promise<void> | void {
    const formatted = this.formatLog("warn", message, data);
    console.log(formatted);

    if (shouldSendToSentry) {
      Sentry.captureMessage(message, "warning");
      return Sentry.flush(2000).catch(() => {});
    }
  }

  error(
    message: string,
    err?: Error,
    data?: LogContext,
    shouldFlush = false
  ): Promise<void> | void {
    const formatted = this.formatLog("error", message, {
      error_message: err?.message,
      error_stack: err?.stack,
      ...data,
    });
    console.error(formatted);

    // Always send to Sentry
    Sentry.captureException(err || new Error(message), {
      tags: {
        function: this.functionName,
        request_id: this.requestId,
      },
      level: "error",
      contexts: {
        additional: data,
      },
    });

    // Optionally flush for critical errors
    if (shouldFlush) {
      return Sentry.flush(2000).catch(() => {});
    }
  }

  async fatal(message: string, err?: Error, data?: LogContext): Promise<void> {
    const formatted = this.formatLog("error", message, {
      error_message: err?.message,
      error_stack: err?.stack,
      severity: "fatal",
      ...data,
    });
    console.error(formatted);

    // Always send and flush fatal errors to Sentry
    Sentry.captureException(err || new Error(message), {
      tags: {
        function: this.functionName,
        request_id: this.requestId,
      },
      level: "fatal",
      contexts: {
        additional: data,
      },
    });
    await Sentry.flush(2000).catch(() => {});
  }

  getRequestId(): string {
    return this.requestId;
  }
}
