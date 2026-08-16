import { instrument } from "@microlabs/otel-cf-workers";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { processCommunicationDeliveryWork } from "./server/communications/delivery";
import { parseConfig } from "./server/config";
import { createDatabase } from "./server/database/client";
import type { Environment } from "./server/environment";
import { getCapturedInvitationSecret } from "./server/event-team/delivery";
import {
  checkProductionHealth,
  productionUnavailableResponse,
} from "./server/health";
import { reportScheduledWorkLiveness } from "./server/heartbeats";
import {
  createAuth,
  getCapturedAuthenticationCode,
} from "./server/identity/auth";
import {
  createTraceConfig,
  reportOperationalFailure,
  traceRootOperation,
} from "./server/observability";
import { findAccessibleTaskFile } from "./server/onboarding/repository";
import { processAgendaDeliveryWork } from "./server/published-schedule/delivery";
import { routePublishedSchedule } from "./server/published-schedule/routes";
import { sendAgendaCalendarDelivery } from "./server/published-schedule/transport";
import { repairDecisionCommunicationRecords } from "./server/reviews/repository";
import { findSpeakerHeadshot } from "./server/speaker-profiles/repository";
import { findAccessibleSubmissionFile } from "./server/submissions/repository";
import { appRouter, createTrpcContext } from "./server/trpc";
import type { UserId } from "./shared/events";
import { storedFileIdSchema } from "./shared/files";

const IMMUTABLE_CACHE_SECONDS = 365 * 24 * 60 * 60;

const handler = {
  async fetch(request, environment): Promise<Response> {
    const url = new URL(request.url);
    return traceRootOperation(
      "request",
      "request.application",
      {
        "http.request.method": request.method,
        "http.route": requestRoute(url.pathname),
      },
      () => handleRequest(request, environment, url),
    );
  },
  async scheduled(controller, environment): Promise<void> {
    await traceRootOperation(
      "cron",
      "scheduled.delivery_work",
      { "scheduled.cron": controller.cron },
      () => processPendingDeliveryWork(environment),
    );
  },
} satisfies ExportedHandler<Environment>;

export default instrument(handler, createTraceConfig) as Required<
  Pick<ExportedHandler<Environment>, "fetch" | "scheduled">
>;

async function handleRequest(
  request: Request,
  environment: Environment,
  url: URL,
): Promise<Response> {
  const configResult = parseConfig(environment);
  if (!configResult.ok) {
    reportOperationalFailure("worker_configuration_invalid", {
      "error.type": "ConfigurationError",
    });
    if (url.pathname === "/api/health") {
      return productionUnavailableResponse();
    }
    return Response.json(
      { code: "INVALID_CONFIGURATION", issues: configResult.issues },
      { status: 503 },
    );
  }

  const config = configResult.value;
  if (url.pathname === "/api/health") {
    return checkProductionHealth(environment.DB);
  }

  const database = createDatabase(environment.DB);
  const auth = createAuth({ config, database });

  const publishedScheduleResponse = await routePublishedSchedule(
    request,
    database,
  );
  if (publishedScheduleResponse) return publishedScheduleResponse;

  if (url.pathname.startsWith("/api/auth/")) {
    return auth.handler(request);
  }

  if (url.pathname === "/api/dev/auth-code") {
    if (config.appEnv !== "local" && config.appEnv !== "test") {
      return new Response("Not found", { status: 404 });
    }

    const email = url.searchParams.get("email");
    const code = email
      ? getCapturedAuthenticationCode(config, email)
      : undefined;
    return code
      ? Response.json({ code })
      : Response.json({ code: "CODE_NOT_FOUND" }, { status: 404 });
  }

  if (url.pathname === "/api/dev/invitation-secret") {
    if (config.appEnv !== "local" && config.appEnv !== "test") {
      return new Response("Not found", { status: 404 });
    }

    const email = url.searchParams.get("email");
    const secret = email
      ? getCapturedInvitationSecret(config, email)
      : undefined;
    return secret
      ? Response.json({ secret })
      : Response.json({ code: "SECRET_NOT_FOUND" }, { status: 404 });
  }

  const taskFileMatch = url.pathname.match(/^\/api\/task-files\/([^/]+)$/);
  if (taskFileMatch) {
    const session = await auth.api.getSession({ headers: request.headers });
    const fileId = taskFileMatch[1];
    if (!session || !fileId) return new Response("Not found", { status: 404 });
    const file = await findAccessibleTaskFile(
      database,
      session.user.id as UserId,
      fileId,
    );
    if (!file) return new Response("Not found", { status: 404 });
    const object = await environment.FILES.get(file.objectKey);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "Content-Type": file.contentType,
      ETag: object.httpEtag,
    });
    return new Response(object.body, { headers });
  }

  const submissionFileMatch = url.pathname.match(
    /^\/api\/submission-files\/([^/]+)$/,
  );
  if (submissionFileMatch) {
    const session = await auth.api.getSession({ headers: request.headers });
    const fileId = storedFileIdSchema.safeParse(submissionFileMatch[1]);
    if (!session || !fileId.success) {
      return new Response("Not found", { status: 404 });
    }
    const file = await findAccessibleSubmissionFile(
      database,
      session.user.id as UserId,
      fileId.data,
    );
    if (!file) return new Response("Not found", { status: 404 });
    const object = await environment.FILES.get(file.objectKey);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "Content-Type": file.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const headshotMatch = url.pathname.match(
    /^\/api\/speaker-headshots\/([^/]+)$/,
  );
  if (headshotMatch) {
    const fileId = storedFileIdSchema.safeParse(headshotMatch[1]);
    if (!fileId.success) return new Response("Not found", { status: 404 });
    const file = await findSpeakerHeadshot(database, fileId.data);
    if (!file) return new Response("Not found", { status: 404 });
    if (file.access === "owner") {
      const session = await auth.api.getSession({ headers: request.headers });
      if (session?.user.id !== file.ownerUserId) {
        return new Response("Not found", { status: 404 });
      }
    }
    const object = await environment.FILES.get(file.objectKey);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "Cache-Control":
        file.access === "public"
          ? `public, max-age=${IMMUTABLE_CACHE_SECONDS}, immutable`
          : "private, no-store",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "Content-Type": file.contentType,
      ETag: object.httpEtag,
      "X-Content-Type-Options": "nosniff",
    });
    return new Response(object.body, { headers });
  }

  if (url.pathname.startsWith("/api/trpc")) {
    return fetchRequestHandler({
      endpoint: "/api/trpc",
      req: request,
      router: appRouter,
      createContext: () =>
        createTrpcContext({
          auth,
          config,
          database,
          files: environment.FILES,
          request,
        }),
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          reportOperationalFailure(
            "trpc_request_failed",
            { "http.route": `/api/trpc/${path ?? "unknown"}` },
            error.cause ?? error,
          );
        }
      },
    });
  }

  return environment.ASSETS.fetch(request);
}

function requestRoute(pathname: string): string {
  if (pathname.startsWith("/api/trpc")) return "/api/trpc";
  if (pathname.startsWith("/api/auth/")) return "/api/auth/*";
  if (pathname.startsWith("/api/task-files/")) return "/api/task-files/:id";
  if (pathname.startsWith("/api/submission-files/")) {
    return "/api/submission-files/:id";
  }
  if (pathname.startsWith("/api/speaker-headshots/")) {
    return "/api/speaker-headshots/:id";
  }
  if (pathname.startsWith("/api/v1/events/")) return "/api/v1/events/:slug/*";
  if (pathname.startsWith("/api/dev/")) return "/api/dev/*";
  return "/*";
}

async function processPendingDeliveryWork(
  environment: Environment,
): Promise<void> {
  const configResult = parseConfig(environment);
  if (!configResult.ok) {
    reportOperationalFailure("delivery_worker_configuration_invalid", {
      "error.type": "ConfigurationError",
    });
    return;
  }
  const database = createDatabase(environment.DB);
  const repairedDecisionRecords =
    await repairDecisionCommunicationRecords(database);
  const [agenda, communications] = await Promise.all([
    processAgendaDeliveryWork(
      database,
      (delivery) => sendAgendaCalendarDelivery(configResult.value, delivery),
      {
        organizerEmail:
          configResult.value.email.type === "capture"
            ? `calendar@${new URL(configResult.value.appUrl).hostname}`
            : configResult.value.email.from,
        retryStaleClaims: configResult.value.email.type !== "cloudflare",
      },
    ),
    processCommunicationDeliveryWork(database, configResult.value),
  ]);
  console.log({
    event: "delivery_worker_completed",
    agenda,
    communications,
    repairedDecisionRecords,
  });
  await reportScheduledWorkLiveness(configResult.value);
}
