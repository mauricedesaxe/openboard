import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  invitationSecretInputSchema,
  inviteEventTeamSchema,
  revokeEventRoleSchema,
  revokeInvitationSchema,
} from "../shared/event-team";
import { eventInputSchema, type UserId } from "../shared/events";

import type { AppConfig } from "./config";
import type { Database } from "./database/client";
import { sendEventInvitation } from "./event-team/delivery";
import {
  acceptInvitation,
  createInvitation,
  declineInvitation,
  findUsableInvitation,
  listEventTeam,
  revokeEventRole,
  revokeInvitation,
} from "./event-team/repository";
import {
  createEvent,
  findEventForUser,
  listEventsForUser,
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

const trpc = initTRPC.context<TrpcContext>().create({ isDev: false });

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
        const event = await findEventForUser(
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
      listEventsForUser(ctx.database, ctx.userId),
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
  eventTeam: trpc.router({
    invite: authenticatedProcedure
      .input(inviteEventTeamSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await createInvitation(ctx.database, ctx.userId, input);
        if (!result.ok) throwInvitationWriteError(result.error);
        if (result.outcome === "already_pending") {
          return {
            outcome: result.outcome,
            id: result.value.id,
            email: result.value.email,
            role: result.value.role,
            expiresAt: result.value.expiresAt.toISOString(),
          };
        }

        try {
          await sendEventInvitation(ctx.config, result.value);
        } catch (error: unknown) {
          console.error(
            JSON.stringify({
              event: "event_invitation_delivery_failed",
              invitationId: result.value.id,
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown email failure",
            }),
          );
          return {
            outcome: "delivery_failed" as const,
            id: result.value.id,
            email: result.value.email,
            role: result.value.role,
            expiresAt: result.value.expiresAt.toISOString(),
          };
        }

        return {
          outcome: "sent" as const,
          id: result.value.id,
          email: result.value.email,
          role: result.value.role,
          expiresAt: result.value.expiresAt.toISOString(),
        };
      }),
    list: authenticatedProcedure
      .input(z.object({ slug: eventInputSchema.shape.slug }))
      .query(async ({ ctx, input }) => {
        const team = await listEventTeam(ctx.database, ctx.userId, input.slug);
        if (!team) throwEventNotFound();
        return team;
      }),
    revokeRole: authenticatedProcedure
      .input(revokeEventRoleSchema)
      .mutation(async ({ ctx, input }) => {
        const revoked = await revokeEventRole(
          ctx.database,
          ctx.userId,
          input.slug,
          input.roleId,
        );
        if (!revoked) throwEventNotFound();
        return { revoked: true };
      }),
    revokeInvitation: authenticatedProcedure
      .input(revokeInvitationSchema)
      .mutation(async ({ ctx, input }) => {
        const revoked = await revokeInvitation(
          ctx.database,
          ctx.userId,
          input.slug,
          input.invitationId,
        );
        if (!revoked) throwEventNotFound();
        return { revoked: true };
      }),
  }),
  invitations: trpc.router({
    get: trpc.procedure
      .input(invitationSecretInputSchema)
      .query(async ({ ctx, input }) => {
        const result = await findUsableInvitation(ctx.database, input.secret);
        if (!result.ok) throwInvitationLookupError(result.error);
        return {
          ...result.value,
          expiresAt: result.value.expiresAt.toISOString(),
        };
      }),
    decline: trpc.procedure
      .input(invitationSecretInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await declineInvitation(ctx.database, input.secret);
        if (!result.ok) throwInvitationLookupError(result.error);
        return { declined: true };
      }),
    accept: authenticatedProcedure
      .input(invitationSecretInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await acceptInvitation(
          ctx.database,
          {
            id: ctx.userId,
            email: ctx.session.user.email,
            emailVerified: ctx.session.user.emailVerified,
          },
          input.secret,
        );
        if (!result.ok) {
          if (result.error === "email_mismatch") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Sign in with the invited email address.",
            });
          }
          if (result.error === "unverified_email") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Verify your email before accepting this invitation.",
            });
          }
          throwInvitationLookupError(result.error);
        }
        return result.value;
      }),
  }),
});

function throwInvitationWriteError(
  error:
    | "event_not_found"
    | "invitation_not_replaceable"
    | "role_already_granted"
    | "persistence_failed",
): never {
  if (error === "event_not_found") throwEventNotFound();
  if (error === "invitation_not_replaceable") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That invitation can no longer be replaced.",
    });
  }
  if (error === "role_already_granted") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That person already has this event role.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The invitation could not be saved.",
  });
}

function throwInvitationLookupError(error: "not_found" | "unavailable"): never {
  throw new TRPCError({
    code: error === "not_found" ? "NOT_FOUND" : "CONFLICT",
    message:
      error === "not_found"
        ? "Invitation not found."
        : "This invitation is no longer available.",
  });
}

function throwEventNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
}

export type AppRouter = typeof appRouter;
