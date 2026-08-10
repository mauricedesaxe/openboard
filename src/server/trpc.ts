import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import { eventInputSchema, type UserId } from "../shared/events";

import type { AppConfig } from "./config";
import type { Database } from "./database/client";
import {
  createEvent,
  findOwnedEvent,
  listOwnedEvents,
  renameOwnedEvent,
} from "./events/repository";
import type { Auth } from "./identity/auth";

type Context = {
  auth: Auth;
  config: AppConfig;
  database: Database;
  request: Request;
};

export async function createTrpcContext(context: Context) {
  const session = await context.auth.api.getSession({
    headers: context.request.headers,
  });
  return { ...context, session };
}

type TrpcContext = Awaited<ReturnType<typeof createTrpcContext>>;

const trpc = initTRPC.context<TrpcContext>().create();

const authenticatedProcedure = trpc.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      userId: ctx.session.user.id as UserId,
    },
  });
});

export const appRouter = trpc.router({
  events: trpc.router({
    create: authenticatedProcedure
      .input(eventInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await createEvent(ctx.database, ctx.userId, input);
        if (!result.ok) {
          throw new TRPCError({
            code:
              result.error === "duplicate_slug"
                ? "CONFLICT"
                : "INTERNAL_SERVER_ERROR",
            message:
              result.error === "duplicate_slug"
                ? "That event slug is already in use."
                : "The event could not be created.",
          });
        }

        return result.value;
      }),
    get: authenticatedProcedure
      .input(z.object({ slug: eventInputSchema.shape.slug }))
      .query(async ({ ctx, input }) => {
        const event = await findOwnedEvent(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!event) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Event not found.",
          });
        }

        return event;
      }),
    list: authenticatedProcedure.query(({ ctx }) =>
      listOwnedEvents(ctx.database, ctx.userId),
    ),
    rename: authenticatedProcedure
      .input(
        z.object({
          slug: eventInputSchema.shape.slug,
          name: eventInputSchema.shape.name,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const event = await renameOwnedEvent(
          ctx.database,
          ctx.userId,
          input.slug,
          input.name,
        );
        if (!event) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Event not found.",
          });
        }

        return event;
      }),
  }),
});

export type AppRouter = typeof appRouter;
