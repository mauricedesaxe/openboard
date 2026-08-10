import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { parseConfig } from "./server/config";
import { createDatabase } from "./server/database/client";
import type { Environment } from "./server/environment";
import { getCapturedInvitationSecret } from "./server/event-team/delivery";
import {
  createAuth,
  getCapturedAuthenticationCode,
} from "./server/identity/auth";
import { appRouter, createTrpcContext } from "./server/trpc";

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

    if (url.pathname.startsWith("/api/trpc")) {
      return fetchRequestHandler({
        endpoint: "/api/trpc",
        req: request,
        router: appRouter,
        createContext: () =>
          createTrpcContext({ auth, config, database, request }),
      });
    }

    return environment.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Environment>;
