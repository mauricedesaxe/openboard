import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { processCommunicationDeliveryWork } from "./server/communications/delivery";
import { parseConfig } from "./server/config";
import { createDatabase } from "./server/database/client";
import type { Environment } from "./server/environment";
import { getCapturedInvitationSecret } from "./server/event-team/delivery";
import {
  createAuth,
  getCapturedAuthenticationCode,
} from "./server/identity/auth";
import { findAccessibleTaskFile } from "./server/onboarding/repository";
import { processAgendaDeliveryWork } from "./server/published-schedule/delivery";
import { routePublishedSchedule } from "./server/published-schedule/routes";
import { sendAgendaCalendarDelivery } from "./server/published-schedule/transport";
import { repairDecisionCommunicationRecords } from "./server/reviews/repository";
import { findSpeakerHeadshot } from "./server/speaker-profiles/repository";
import { appRouter, createTrpcContext } from "./server/trpc";
import type { UserId } from "./shared/events";
import { storedFileIdSchema } from "./shared/files";

const IMMUTABLE_CACHE_SECONDS = 365 * 24 * 60 * 60;

export default {
  async fetch(request, environment): Promise<Response> {
    const configResult = parseConfig(environment);
    if (!configResult.ok) {
      return Response.json(
        { code: "INVALID_CONFIGURATION", issues: configResult.issues },
        { status: 503 },
      );
    }

    const config = configResult.value;
    const database = createDatabase(environment.DB);
    const auth = createAuth({ config, database });
    const url = new URL(request.url);

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
      if (!session || !fileId)
        return new Response("Not found", { status: 404 });
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
      });
    }

    return environment.ASSETS.fetch(request);
  },
  scheduled(_controller, environment, context): void {
    context.waitUntil(deliverPendingAgendaCalendars(environment));
  },
} satisfies ExportedHandler<Environment>;

async function deliverPendingAgendaCalendars(
  environment: Environment,
): Promise<void> {
  const configResult = parseConfig(environment);
  if (!configResult.ok) {
    console.error(
      JSON.stringify({
        event: "agenda_calendar_worker_configuration_invalid",
        issues: configResult.issues,
      }),
    );
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
  console.log(
    JSON.stringify({
      event: "communication_worker_completed",
      agenda,
      communications,
      repairedDecisionRecords,
    }),
  );
}
