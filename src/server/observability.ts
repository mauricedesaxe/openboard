import {
  type ExporterConfig,
  OTLPExporter,
  type PostProcessorFn,
  type TraceConfig,
} from "@microlabs/otel-cf-workers";
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  createContextKey,
  context,
  trace,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";

import type { Environment } from "./environment";

type OperationKind = "cron" | "delivery" | "external" | "request";

type AttributeValue = boolean | number | string;

type ObservabilityAttributes = Partial<
  Record<
    | "delivery.action"
    | "delivery.attempt"
    | "delivery.provider"
    | "delivery.retryable"
    | "delivery.work_id"
    | "error.type"
    | "event.id"
    | "file.id"
    | "http.request.method"
    | "http.route"
    | "invitation.id"
    | "publication.id"
    | "scheduled.cron",
    AttributeValue
  >
>;

const tracer = trace.getTracer("openboard-worker");
const traceScope = createContextKey("openboard.trace-scope");
type TraceScope = { continuedSpanExports: Set<Promise<void>> };
const continuedSpanExportWaiters = new Map<string, () => void>();
const traceEndpoint =
  "https://s2678347.eu-central-1a.betterstackdata.com/v1/traces";
const disabledTraceExporter: ExporterConfig = {
  export(_spans, callback) {
    callback({ code: 0 });
  },
  shutdown: () => Promise.resolve(),
};
const privateTraceAttributes = new Set([
  "db.statement",
  "http.url",
  "net.asn",
  "net.colo",
  "net.country",
  "net.tcp_rtt",
  "url.full",
  "url.path",
  "url.query",
  "user_agent.original",
]);

export function traceRootOperation<T>(
  kind: "cron" | "request",
  name: string,
  attributes: ObservabilityAttributes,
  operation: () => Promise<T>,
): Promise<T> {
  const scope: TraceScope = { continuedSpanExports: new Set() };
  return context.with(
    context.active().setValue(traceScope, scope),
    async () => {
      try {
        return await recordOperation(
          kind,
          name,
          attributes,
          operation,
          kind === "request"
            ? "worker_request_failed"
            : "worker_scheduled_failed",
        );
      } finally {
        await flushContinuedTraces(scope);
      }
    },
  );
}

export async function traceOperation<T>(
  kind: OperationKind,
  name: string,
  attributes: ObservabilityAttributes,
  operation: () => Promise<T>,
): Promise<T> {
  return recordOperation(kind, name, attributes, operation, null);
}

async function recordOperation<T>(
  kind: OperationKind,
  name: string,
  attributes: ObservabilityAttributes,
  operation: () => Promise<T>,
  failureEvent: string | null,
  onSpanStart?: (spanContext: SpanContext) => void,
): Promise<T> {
  if (context.active().getValue(traceScope) === undefined) {
    return operation();
  }

  return tracer.startActiveSpan(
    name,
    {
      attributes,
      kind: spanKind(kind),
    },
    async (span) => {
      const startedAt = performance.now();
      onSpanStart?.(span.spanContext());
      span.setAttribute("operation.outcome", "ok");

      try {
        return await operation();
      } catch (error) {
        span.setAttribute("operation.outcome", "error");
        span.setAttribute("error.type", errorType(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (failureEvent !== null) {
          reportOperationalFailure(failureEvent, attributes, error);
        }
        throw error;
      } finally {
        span.setAttribute(
          "openboard.duration_ms",
          Math.round(performance.now() - startedAt),
        );
        span.end();
      }
    },
  );
}

export async function continueTraceOperation<T>(
  traceContext: string | null,
  kind: OperationKind,
  name: string,
  attributes: ObservabilityAttributes,
  operation: () => Promise<T>,
): Promise<T> {
  const continuedTrace = parseTraceContext(traceContext);
  if (continuedTrace === null) {
    return traceOperation(kind, name, attributes, operation);
  }

  const scope = context.active().getValue(traceScope) as TraceScope | undefined;
  return context.with(continuedTrace.context, () =>
    recordOperation(kind, name, attributes, operation, null, (spanContext) => {
      if (
        scope !== undefined &&
        (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0
      ) {
        trackContinuedSpan(scope, spanContext.spanId);
      }
    }),
  );
}

export function currentTraceContext(): string | null {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) {
    return null;
  }

  const flags = (spanContext.traceFlags & TraceFlags.SAMPLED)
    .toString(16)
    .padStart(2, "0");
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

export function reportOperationalFailure(
  event: string,
  attributes: ObservabilityAttributes,
  error?: unknown,
): void {
  const safeAttributes: ObservabilityAttributes = {
    ...attributes,
    ...(error === undefined ? {} : { "error.type": errorType(error) }),
  };
  const span = trace.getActiveSpan();
  span?.addEvent(event, { ...safeAttributes, "openboard.event": event });
  span?.setAttribute("operation.outcome", "error");
  span?.setStatus({ code: SpanStatusCode.ERROR });
  console.error({ event, severity: "error", ...safeAttributes });
}

export const redactTraceAttributes: PostProcessorFn = (spans) => {
  for (const span of spans) {
    for (const attribute of privateTraceAttributes) {
      delete span.attributes[attribute];
    }
    for (const event of span.events) {
      if (event.name === "exception" && event.attributes !== undefined) {
        delete event.attributes["exception.message"];
        if (span.parentSpanContext !== undefined) {
          delete event.attributes["exception.stacktrace"];
        } else {
          const stacktrace = event.attributes["exception.stacktrace"];
          if (typeof stacktrace === "string") {
            const frames = stacktrace
              .split("\n")
              .filter((line) => /^\s*at /.test(line))
              .join("\n");
            if (frames) {
              event.attributes["exception.stacktrace"] = frames;
            } else {
              delete event.attributes["exception.stacktrace"];
            }
          }
        }
      }
    }
  }
  return spans;
};

export function createTraceConfig(environment: Environment): TraceConfig {
  const token = environment.BETTERSTACK_SOURCE_TOKEN?.trim() ?? "";
  const enabled = environment.APP_ENV === "production" && token.length > 0;

  return {
    exporter: createTraceExporter(enabled, token),
    fetch: { includeTraceContext: false },
    handlers: { fetch: { acceptTraceContext: false } },
    sampling: {
      headSampler: { acceptRemote: false, ratio: enabled ? 1 : 0 },
      tailSampler: () => enabled,
    },
    service: {
      name: "openboard-worker",
      ...(environment.VERSION?.id ? { version: environment.VERSION.id } : {}),
    },
  };
}

function spanKind(kind: OperationKind): SpanKind {
  switch (kind) {
    case "request":
      return SpanKind.SERVER;
    case "delivery":
      return SpanKind.CONSUMER;
    case "external":
      return SpanKind.CLIENT;
    case "cron":
      return SpanKind.INTERNAL;
  }
}

function parseTraceContext(
  traceContext: string | null,
): { context: Context; traceId: string } | null {
  if (traceContext === null) {
    return null;
  }

  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    traceContext,
  );
  if (match === null) {
    return null;
  }
  const [, traceId, spanId, flags] = match;
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    return null;
  }

  const spanContext: SpanContext = {
    isRemote: true,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
    traceId,
  };
  if (!trace.isSpanContextValid(spanContext)) {
    return null;
  }

  return {
    context: trace.setSpanContext(context.active(), spanContext),
    traceId,
  };
}

async function flushContinuedTraces(scope: TraceScope): Promise<void> {
  await Promise.all(scope.continuedSpanExports);
}

function trackContinuedSpan(scope: TraceScope, spanId: string): void {
  const completed = new Promise<void>((resolve) => {
    continuedSpanExportWaiters.set(spanId, resolve);
  });
  scope.continuedSpanExports.add(completed);
}

export function createTraceExporter(
  enabled: boolean,
  token: string,
  configuredExporter?: Pick<OTLPExporter, "export" | "shutdown">,
): ExporterConfig {
  if (!enabled) {
    return disabledTraceExporter;
  }

  const exporter =
    configuredExporter ??
    new OTLPExporter({
      headers: { Authorization: `Bearer ${token}` },
      url: traceEndpoint,
    });
  return {
    export(spans, callback) {
      exporter.export(redactTraceAttributes(spans), (result) => {
        const failed = result.code !== (0 as typeof result.code);
        if (failed) {
          console.error({
            event: "telemetry_export_failed",
            severity: "error",
          });
        }
        callback(
          failed
            ? { code: result.code, error: new Error("Trace export failed") }
            : result,
        );
        for (const span of spans) {
          const spanId = span.spanContext().spanId;
          continuedSpanExportWaiters.get(spanId)?.();
          continuedSpanExportWaiters.delete(spanId);
        }
      });
    },
    shutdown: () => exporter.shutdown(),
  };
}

function errorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}
