import { instrument, type OTLPExporter } from "@microlabs/otel-cf-workers";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { describe, expect, test, vi } from "vitest";

import type { Environment } from "../src/server/environment";
import {
  continueTraceOperation,
  createTraceConfig,
  createTraceExporter,
  redactTraceAttributes,
  reportOperationalFailure,
  traceOperation,
  traceRootOperation,
} from "../src/server/observability";

type ExportResult = Parameters<Parameters<OTLPExporter["export"]>[1]>[0];

describe("production observability", () => {
  test("does not change operation behavior when tracing is disabled", async () => {
    await expect(
      traceOperation("external", "test.success", {}, () =>
        Promise.resolve("result"),
      ),
    ).resolves.toBe("result");
    await expect(
      traceOperation("external", "test.failure", {}, () =>
        Promise.reject(new TypeError("private failure detail")),
      ),
    ).rejects.toThrow("private failure detail");
  });

  test("removes private fields before trace export", () => {
    const spans = [
      {
        attributes: {
          "db.statement": "select private_value from users",
          "http.request.method": "GET",
          "url.full": "https://openboard.example.com/api?secret=value",
          "url.path": "/api/events/private-event/files/private-file-id",
          "user_agent.original": "private browser details",
        },
        events: [
          {
            attributes: {
              "exception.message": "private failure detail",
              "exception.stacktrace": "private nested stack",
              "exception.type": "TypeError",
            },
            name: "exception",
          },
        ],
        parentSpanContext: {
          spanId: "2222222222222222",
          traceFlags: 1,
          traceId: "11111111111111111111111111111111",
        },
      },
      {
        attributes: {},
        events: [
          {
            attributes: {
              "exception.message": "unhandled failure",
              "exception.stacktrace":
                "TypeError: private failure detail\n    at handleRequest (worker.js:1:2)",
              "exception.type": "TypeError",
            },
            name: "exception",
          },
        ],
      },
    ] as unknown as Parameters<typeof redactTraceAttributes>[0];

    expect(redactTraceAttributes(spans)[0]?.attributes).toEqual({
      "http.request.method": "GET",
    });
    expect(redactTraceAttributes(spans)[0]?.events[0]?.attributes).toEqual({
      "exception.type": "TypeError",
    });
    expect(redactTraceAttributes(spans)[1]?.events[0]?.attributes).toEqual({
      "exception.stacktrace": "    at handleRequest (worker.js:1:2)",
      "exception.type": "TypeError",
    });
  });

  test("reports rejected exports after redacting their payload", async () => {
    let completeExport: (() => void) | undefined;
    const exportResult = new Promise<ExportResult>((resolve) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const delegate: Pick<OTLPExporter, "export" | "shutdown"> = {
        export(spans, callback) {
          const exportedSpans = spans as unknown as Parameters<
            typeof redactTraceAttributes
          >[0];
          expect(exportedSpans[0]?.attributes).toEqual({
            "http.request.method": "GET",
          });
          completeExport = () => {
            callback({ code: 1, error: new Error("private exporter detail") });
            expect(consoleError).toHaveBeenCalledWith({
              event: "telemetry_export_failed",
              severity: "error",
            });
            consoleError.mockRestore();
          };
        },
        shutdown: () => Promise.resolve(),
      };
      const exporter = createTraceExporter(true, "token", delegate);
      if (!("export" in exporter)) throw new Error("Expected span exporter");
      exporter.export(
        [
          {
            attributes: {
              "http.request.method": "GET",
              "url.full": "https://openboard.example.com/?secret=value",
            },
            events: [],
            spanContext: () => ({
              spanId: "2222222222222222",
              traceFlags: 1,
              traceId: "11111111111111111111111111111111",
            }),
          },
        ] as unknown as Parameters<typeof exporter.export>[0],
        resolve,
      );
    });

    await Promise.resolve();
    expect(completeExport).toBeTypeOf("function");
    completeExport?.();
    await expect(exportResult).resolves.toMatchObject({
      code: 1,
      error: new Error("Trace export failed"),
    });
  });

  test("reports a code-only rejection as a stable export failure", async () => {
    let completeExport: (() => void) | undefined;
    const exportResult = new Promise<ExportResult>((resolve) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const delegate: Pick<OTLPExporter, "export" | "shutdown"> = {
        export(_spans, callback) {
          completeExport = () => {
            callback({ code: 1 });
            expect(consoleError).toHaveBeenCalledWith({
              event: "telemetry_export_failed",
              severity: "error",
            });
            consoleError.mockRestore();
          };
        },
        shutdown: () => Promise.resolve(),
      };
      const exporter = createTraceExporter(true, "token", delegate);
      if (!("export" in exporter)) throw new Error("Expected span exporter");
      exporter.export(
        [
          {
            attributes: {},
            events: [],
            spanContext: () => ({
              spanId: "aaaaaaaaaaaaaaaa",
              traceFlags: 1,
              traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            }),
          },
        ] as unknown as Parameters<typeof exporter.export>[0],
        resolve,
      );
    });

    await Promise.resolve();
    expect(completeExport).toBeTypeOf("function");
    completeExport?.();
    await expect(exportResult).resolves.toMatchObject({
      code: 1,
      error: new Error("Trace export failed"),
    });
  });

  test("enables full tracing only for configured production", () => {
    const environment = {
      APP_ENV: "production",
      BETTERSTACK_SOURCE_TOKEN: " source-token ",
    } as Environment;

    expect(createTraceConfig(environment).sampling).toMatchObject({
      headSampler: { acceptRemote: false, ratio: 1 },
    });
    expect(
      createTraceConfig({ ...environment, APP_ENV: "test" }).sampling,
    ).toMatchObject({ headSampler: { acceptRemote: false, ratio: 0 } });
    expect(
      createTraceConfig({
        ...environment,
        BETTERSTACK_SOURCE_TOKEN: "   ",
      }).sampling,
    ).toMatchObject({ headSampler: { acceptRemote: false, ratio: 0 } });
  });

  test("continues stored contexts and awaits their natural exports", async () => {
    const exportedSpans: Parameters<typeof redactTraceAttributes>[0] = [];
    const waits: Promise<unknown>[] = [];
    const completeContinuedExports: Array<() => void> = [];
    let exportStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      exportStarted = resolve;
    });
    const config = createTraceConfig({
      APP_ENV: "production",
      BETTERSTACK_SOURCE_TOKEN: "source-token",
    } as Environment);
    const tracedHandler = instrument(
      {
        scheduled: () =>
          traceRootOperation("cron", "test.scheduled", {}, async () => {
            await Promise.all([
              continueTraceOperation(
                "00-11111111111111111111111111111111-2222222222222222-01",
                "delivery",
                "test.continued_delivery.one",
                {},
                () => Promise.resolve(),
              ),
              continueTraceOperation(
                "00-33333333333333333333333333333333-4444444444444444-01",
                "delivery",
                "test.continued_delivery.two",
                {},
                () => Promise.resolve(),
              ),
            ]);
          }),
      } satisfies ExportedHandler,
      {
        ...config,
        exporter: createTraceExporter(true, "source-token", {
          export(spans, callback) {
            const readableSpans = spans as unknown as Parameters<
              typeof redactTraceAttributes
            >[0];
            exportedSpans.push(...readableSpans);
            if (
              readableSpans.some((span) =>
                span.name.startsWith("test.continued_delivery"),
              )
            ) {
              completeContinuedExports.push(() => callback({ code: 0 }));
              if (completeContinuedExports.length === 2) exportStarted?.();
            } else {
              callback({ code: 0 });
            }
          },
          shutdown: () => Promise.resolve(),
        }),
      },
    );
    const executionContext = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise);
      },
    } as ExecutionContext;
    const scheduled = tracedHandler.scheduled;
    if (typeof scheduled !== "function") {
      throw new Error("Expected scheduled handler");
    }

    let scheduledCompleted = false;
    const scheduledWork = (async () => {
      await scheduled(
        {
          cron: "* * * * *",
          noRetry() {},
          scheduledTime: Date.now(),
        },
        {},
        executionContext,
      );
      scheduledCompleted = true;
    })();
    await started;

    const firstContinuedSpan = exportedSpans.find(
      (span) => span.name === "test.continued_delivery.one",
    );
    const secondContinuedSpan = exportedSpans.find(
      (span) => span.name === "test.continued_delivery.two",
    );
    expect(firstContinuedSpan?.spanContext().traceId).toBe(
      "11111111111111111111111111111111",
    );
    expect(secondContinuedSpan?.spanContext().traceId).toBe(
      "33333333333333333333333333333333",
    );
    expect(completeContinuedExports).toHaveLength(2);
    expect(scheduledCompleted).toBe(false);
    completeContinuedExports[0]?.();
    await Promise.resolve();
    expect(scheduledCompleted).toBe(false);
    completeContinuedExports[1]?.();
    await scheduledWork;
    expect(scheduledCompleted).toBe(true);

    let exportCompleted = false;
    const completed = Promise.all(waits).then(() => {
      exportCompleted = true;
    });
    await Promise.resolve();
    expect(exportCompleted).toBe(false);
    await completed;
    expect(exportCompleted).toBe(true);
  });

  test("does not wait for an unsampled continued span", async () => {
    const config = createTraceConfig({
      APP_ENV: "test",
      BETTERSTACK_SOURCE_TOKEN: "source-token",
    } as Environment);
    const tracedHandler = instrument(
      {
        scheduled: () =>
          traceRootOperation("cron", "test.unsampled_scheduled", {}, () =>
            continueTraceOperation(
              "00-55555555555555555555555555555555-6666666666666666-01",
              "delivery",
              "test.unsampled_delivery",
              {},
              () => Promise.resolve(),
            ),
          ),
      } satisfies ExportedHandler,
      config,
    );
    const scheduled = tracedHandler.scheduled;
    if (typeof scheduled !== "function") {
      throw new Error("Expected scheduled handler");
    }

    await scheduled(
      {
        cron: "* * * * *",
        noRetry() {},
        scheduledTime: Date.now(),
      },
      {},
      {
        passThroughOnException() {},
        props: {},
        waitUntil() {},
      } as unknown as ExecutionContext,
    );
  });

  test("reports stable failure codes with safe domain context", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    reportOperationalFailure("agenda_delivery_failed", {
      "delivery.attempt": 2,
      "delivery.retryable": true,
      "delivery.work_id": "work-1",
    });

    expect(consoleError).toHaveBeenCalledWith({
      event: "agenda_delivery_failed",
      severity: "error",
      "delivery.attempt": 2,
      "delivery.retryable": true,
      "delivery.work_id": "work-1",
    });
    consoleError.mockRestore();
  });

  test("flips the active span to ERROR when reporting an operational failure", async () => {
    const config = createTraceConfig({
      APP_ENV: "production",
      BETTERSTACK_SOURCE_TOKEN: "source-token",
    } as Environment);
    const tracedHandler = instrument(
      {
        scheduled: () =>
          traceRootOperation("cron", "test.scheduled", {}, () =>
            traceOperation(
              "delivery",
              "agenda.delivery.work",
              { "delivery.work_id": "work-1" },
              () => {
                const span = trace.getActiveSpan();
                reportOperationalFailure("agenda_delivery_failed", {
                  "delivery.attempt": 2,
                  "delivery.retryable": true,
                  "delivery.work_id": "work-1",
                });
                if (span === undefined) {
                  throw new Error("expected an active span");
                }
                expect(span.isRecording()).toBe(true);
                const recorded = span as unknown as {
                  status: { code: number };
                  attributes: Record<string, unknown>;
                  events: Array<{
                    name: string;
                    attributes?: Record<string, unknown>;
                  }>;
                };
                expect(recorded.status.code).toBe(SpanStatusCode.ERROR);
                expect(recorded.attributes["operation.outcome"]).toBe("error");
                expect(recorded.attributes["delivery.work_id"]).toBe("work-1");
                const failureEvent = recorded.events.find(
                  (event) => event.name === "agenda_delivery_failed",
                );
                expect(failureEvent).toBeDefined();
                expect(failureEvent?.attributes?.["openboard.event"]).toBe(
                  "agenda_delivery_failed",
                );
                expect(failureEvent?.attributes?.["delivery.attempt"]).toBe(2);
                expect(failureEvent?.attributes?.["delivery.retryable"]).toBe(
                  true,
                );
                expect(failureEvent?.attributes?.["delivery.work_id"]).toBe(
                  "work-1",
                );
                return Promise.resolve();
              },
            ),
          ),
      } satisfies ExportedHandler,
      config,
    );

    const scheduled = tracedHandler.scheduled;
    if (typeof scheduled !== "function") {
      throw new Error("Expected scheduled handler");
    }

    await scheduled(
      {
        cron: "* * * * *",
        noRetry() {},
        scheduledTime: Date.now(),
      },
      {},
      {
        passThroughOnException() {},
        props: {},
        waitUntil: () => undefined,
      } as unknown as ExecutionContext,
    );
  });
});
