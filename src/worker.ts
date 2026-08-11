import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { parseConfig } from "./server/config";
import { createDatabase } from "./server/database/client";
import type { Environment } from "./server/environment";
import { getCapturedInvitationSecret } from "./server/event-team/delivery";
import {
  createAuth,
  getCapturedAuthenticationCode,
} from "./server/identity/auth";
import { findAccessibleTaskFile } from "./server/onboarding/repository";
import { findPublicSpeakerHeadshot } from "./server/speaker-profiles/repository";
import { appRouter, createTrpcContext } from "./server/trpc";
import type { UserId } from "./shared/events";

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
      const fileId = headshotMatch[1];
      if (!fileId) return new Response("Not found", { status: 404 });
      const file = await findPublicSpeakerHeadshot(database, fileId);
      if (!file) return new Response("Not found", { status: 404 });
      const object = await environment.FILES.get(file.objectKey);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers({
        "Cache-Control": `public, max-age=${IMMUTABLE_CACHE_SECONDS}, immutable`,
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
} satisfies ExportedHandler<Environment>;
