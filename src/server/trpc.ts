import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  cfpDefinitionInputSchema,
  eventOptionNameSchema,
  type CfpId,
  type RoomId,
  type TrackId,
} from "../shared/cfps";
import {
  invitationSecretInputSchema,
  inviteEventTeamSchema,
  revokeEventRoleSchema,
  revokeInvitationSchema,
} from "../shared/event-team";
import { eventInputSchema, type UserId } from "../shared/events";
import {
  decisionPublicationSchema,
  decisionQueueStatusSchema,
  reviewerAssignmentIdSchema,
  saveReviewSchema,
} from "../shared/reviews";
import {
  proposalContentSchema,
  submissionIdSchema,
  submitProposalSchema,
} from "../shared/submissions";

import {
  createDraftCfp,
  findPublicCfp,
  getCfpSetup,
  saveAndOpenCfp,
  updateDraftCfp,
} from "./cfps/repository";
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
import {
  archiveRoom,
  archiveTrack,
  createRoom,
  createTrack,
  listRooms,
  listTracks,
  reorderRooms,
  reorderTracks,
  updateRoom,
  updateTrack,
} from "./program-setup/repository";
import {
  assignReviewer,
  closeReviewRound,
  getOrganizerReviewBoard,
  listOwnReviewAssignments,
  openReviewRound,
  publishDecisions,
  queueDecision,
  reopenReviewRound,
  retryDecisionPublicationFollowups,
  revokeReviewerAssignment,
  saveReview,
} from "./reviews/repository";
import {
  findOwnSubmission,
  listOwnSubmissions,
  submitProposal,
  updateOwnSubmission,
  withdrawOwnSubmission,
} from "./submissions/repository";

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

const slugInput = z.object({ slug: eventInputSchema.shape.slug });
const optionNameInput = slugInput.extend({
  name: eventOptionNameSchema,
});
const trackIdSchema = z.uuid().transform((value) => value as TrackId);
const roomIdSchema = z.uuid().transform((value) => value as RoomId);
const cfpIdSchema = z.uuid().transform((value) => value as CfpId);
const userIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as UserId);

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
  tracks: trpc.router({
    list: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const result = await listTracks(ctx.database, ctx.userId, input.slug);
        if (!result) throwCfpItemNotFound();
        return result;
      }),
    create: authenticatedProcedure
      .input(optionNameInput)
      .mutation(async ({ ctx, input }) => {
        const result = await createTrack(
          ctx.database,
          ctx.userId,
          input.slug,
          input.name,
        );
        return unwrapOptionMutation(result);
      }),
    update: authenticatedProcedure
      .input(optionNameInput.extend({ trackId: trackIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const result = await updateTrack(
          ctx.database,
          ctx.userId,
          input.slug,
          input.trackId,
          input.name,
        );
        return unwrapOptionMutation(result);
      }),
    archive: authenticatedProcedure
      .input(slugInput.extend({ trackId: trackIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const result = await archiveTrack(
          ctx.database,
          ctx.userId,
          input.slug,
          input.trackId,
        );
        return unwrapOptionMutation(result);
      }),
    reorder: authenticatedProcedure
      .input(
        slugInput.extend({
          orderedIds: z
            .array(trackIdSchema)
            .refine((ids) => new Set(ids).size === ids.length),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await reorderTracks(
          ctx.database,
          ctx.userId,
          input.slug,
          input.orderedIds,
        );
        handleTrackReorderResult(result);
        return { reordered: true as const };
      }),
  }),
  rooms: trpc.router({
    list: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const result = await listRooms(ctx.database, ctx.userId, input.slug);
        if (!result) throwCfpItemNotFound();
        return result;
      }),
    create: authenticatedProcedure
      .input(optionNameInput)
      .mutation(async ({ ctx, input }) => {
        const result = await createRoom(
          ctx.database,
          ctx.userId,
          input.slug,
          input.name,
        );
        return unwrapOptionMutation(result);
      }),
    update: authenticatedProcedure
      .input(optionNameInput.extend({ roomId: roomIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const result = await updateRoom(
          ctx.database,
          ctx.userId,
          input.slug,
          input.roomId,
          input.name,
        );
        return unwrapOptionMutation(result);
      }),
    archive: authenticatedProcedure
      .input(slugInput.extend({ roomId: roomIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const archived = await archiveRoom(
          ctx.database,
          ctx.userId,
          input.slug,
          input.roomId,
        );
        if (!archived) throwCfpItemNotFound();
        return { archived: true as const };
      }),
    reorder: authenticatedProcedure
      .input(
        slugInput.extend({
          orderedIds: z
            .array(roomIdSchema)
            .refine((ids) => new Set(ids).size === ids.length),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await reorderRooms(
          ctx.database,
          ctx.userId,
          input.slug,
          input.orderedIds,
        );
        handleReorderResult(result);
        return { reordered: true as const };
      }),
  }),
  cfps: trpc.router({
    getSetup: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const result = await getCfpSetup(ctx.database, ctx.userId, input.slug);
        if (result === undefined) throwCfpItemNotFound();
        return result;
      }),
    createDraft: authenticatedProcedure
      .input(slugInput.extend(cfpDefinitionInputSchema.shape))
      .mutation(async ({ ctx, input }) => {
        const result = await createDraftCfp(
          ctx.database,
          ctx.userId,
          input.slug,
          input,
        );
        if (!result.ok) throwCfpWriteError(result.error);
        return result.value;
      }),
    updateDraft: authenticatedProcedure
      .input(
        slugInput.extend(cfpDefinitionInputSchema.shape).extend({
          cfpId: cfpIdSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await updateDraftCfp(
          ctx.database,
          ctx.userId,
          input.slug,
          input.cfpId,
          input,
        );
        if (!result.ok) throwCfpWriteError(result.error);
        return result.value;
      }),
    open: authenticatedProcedure
      .input(
        slugInput.extend(cfpDefinitionInputSchema.shape).extend({
          cfpId: cfpIdSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await saveAndOpenCfp(
          ctx.database,
          ctx.userId,
          input.slug,
          input.cfpId,
          input,
        );
        if (!result.ok) throwCfpWriteError(result.error);
        return result.value;
      }),
    publicByEventSlug: trpc.procedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const result = await findPublicCfp(ctx.database, input.slug);
        if (!result) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This call for proposals is not open.",
          });
        }
        return result;
      }),
  }),
  submissions: trpc.router({
    listOwn: authenticatedProcedure.query(({ ctx }) =>
      listOwnSubmissions(ctx.database, ctx.userId),
    ),
    submit: authenticatedProcedure
      .input(submitProposalSchema)
      .mutation(async ({ ctx, input }) => {
        if (!ctx.session.user.emailVerified) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Verify your email before submitting a proposal.",
          });
        }
        const result = await submitProposal(
          ctx.database,
          ctx.userId,
          ctx.session.user.email,
          input,
        );
        if (!result.ok) throwProposalWriteError(result.error);
        return result.value;
      }),
    getOwn: authenticatedProcedure
      .input(z.object({ submissionId: submissionIdSchema }))
      .query(async ({ ctx, input }) => {
        const submission = await findOwnSubmission(
          ctx.database,
          ctx.userId,
          input.submissionId,
        );
        if (!submission) throwSubmissionNotFound();
        return submission;
      }),
    updateOwn: authenticatedProcedure
      .input(proposalContentSchema.extend({ submissionId: submissionIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const result = await updateOwnSubmission(
          ctx.database,
          ctx.userId,
          input.submissionId,
          input,
        );
        if (!result.ok) throwProposalWriteError(result.error);
        return result.value;
      }),
    withdrawOwn: authenticatedProcedure
      .input(z.object({ submissionId: submissionIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const result = await withdrawOwnSubmission(
          ctx.database,
          ctx.userId,
          input.submissionId,
        );
        if (!result.ok) throwProposalWriteError(result.error);
        return result.value;
      }),
  }),
  reviews: trpc.router({
    organizerBoard: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const board = await getOrganizerReviewBoard(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!board) throwEventNotFound();
        return board;
      }),
    mine: authenticatedProcedure
      .input(slugInput)
      .query(({ ctx, input }) =>
        listOwnReviewAssignments(ctx.database, ctx.userId, input.slug),
      ),
    assign: authenticatedProcedure
      .input(
        slugInput.extend({
          submissionId: submissionIdSchema,
          reviewerUserId: userIdSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await assignReviewer(
          ctx.database,
          ctx.userId,
          input.slug,
          input.submissionId,
          input.reviewerUserId,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
    revokeAssignment: authenticatedProcedure
      .input(slugInput.extend({ assignmentId: reviewerAssignmentIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const result = await revokeReviewerAssignment(
          ctx.database,
          ctx.userId,
          input.slug,
          input.assignmentId,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
    save: authenticatedProcedure
      .input(saveReviewSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await saveReview(ctx.database, ctx.userId, input);
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
    openRound: authenticatedProcedure
      .input(slugInput)
      .mutation(async ({ ctx, input }) => {
        const result = await openReviewRound(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
    closeRound: authenticatedProcedure
      .input(slugInput.extend({ confirmIncomplete: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const result = await closeReviewRound(
          ctx.database,
          ctx.userId,
          input.slug,
          input.confirmIncomplete,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
    reopenRound: authenticatedProcedure
      .input(slugInput)
      .mutation(async ({ ctx, input }) => {
        const result = await reopenReviewRound(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
  }),
  decisions: trpc.router({
    queue: authenticatedProcedure
      .input(
        slugInput.extend({
          submissionId: submissionIdSchema,
          status: decisionQueueStatusSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await queueDecision(
          ctx.database,
          ctx.userId,
          input.slug,
          input.submissionId,
          input.status,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
    publish: authenticatedProcedure
      .input(decisionPublicationSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await publishDecisions(ctx.database, ctx.userId, input);
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
    retryFollowups: authenticatedProcedure
      .input(slugInput)
      .mutation(async ({ ctx, input }) => {
        const result = await retryDecisionPublicationFollowups(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
  }),
});

function throwCfpItemNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Event item not found." });
}

function handleReorderResult(
  result: "ok" | "not_found" | "invalid_order",
): void {
  if (result === "not_found") throwCfpItemNotFound();
  if (result === "invalid_order") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The order must contain every active item once.",
    });
  }
}

function handleTrackReorderResult(
  result: "ok" | "not_found" | "invalid_order" | "structure_locked",
): void {
  if (result === "structure_locked") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Tracks are locked after a proposal is submitted.",
    });
  }
  handleReorderResult(result);
}

function unwrapOptionMutation<T>(
  result:
    | { ok: true; value: T }
    | {
        ok: false;
        error:
          | "duplicate_name"
          | "last_open_track"
          | "not_found"
          | "persistence_failed"
          | "structure_locked";
      },
): T {
  if (result.ok) return result.value;
  if (result.error === "not_found") throwCfpItemNotFound();
  if (result.error === "duplicate_name") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Use a name that is not already active for this event.",
    });
  }
  if (result.error === "last_open_track") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "An open call for proposals must keep at least one track.",
    });
  }
  if (result.error === "persistence_failed") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The room or track could not be saved. Try again.",
    });
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "Tracks are locked after a proposal is submitted.",
  });
}

function throwCfpWriteError(
  error:
    | "already_draft"
    | "already_open"
    | "deadline_after_event"
    | "deadline_passed"
    | "file_fields_unsupported"
    | "missing_track"
    | "not_found"
    | "persistence_failed"
    | "structure_locked",
): never {
  if (error === "not_found") throwCfpItemNotFound();
  if (error === "already_open") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This event already has an open call for proposals.",
    });
  }
  if (error === "already_draft") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This event already has a draft call for proposals.",
    });
  }
  if (error === "missing_track") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Add at least one track before opening the call for proposals.",
    });
  }
  if (error === "deadline_passed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a deadline in the future.",
    });
  }
  if (error === "deadline_after_event") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a deadline on or before the event end date.",
    });
  }
  if (error === "file_fields_unsupported") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "File questions need stored-file support before this CFP opens.",
    });
  }
  if (error === "structure_locked") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The form structure is locked after the first submission.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The call for proposals could not be saved.",
  });
}

function throwProposalWriteError(
  error:
    | "cfp_unavailable"
    | "cfp_changed"
    | "deadline_passed"
    | "invalid_answers"
    | "invalid_format"
    | "invalid_track"
    | "not_found"
    | "persistence_failed"
    | "submission_closed",
): never {
  if (error === "not_found") throwSubmissionNotFound();
  if (error === "submission_closed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This proposal can no longer be edited.",
    });
  }
  if (error === "cfp_unavailable" || error === "deadline_passed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This call for proposals is no longer accepting submissions.",
    });
  }
  if (error === "cfp_changed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The proposal form changed. Reload it before submitting.",
    });
  }
  if (error === "invalid_track") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose an active track for this event.",
    });
  }
  if (error === "invalid_format") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a format offered by this call for proposals.",
    });
  }
  if (error === "invalid_answers") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check the answers required by the current proposal form.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The proposal could not be saved.",
  });
}

function throwSubmissionNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found." });
}

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

function throwReviewWriteError(
  error:
    | "duplicate_assignment"
    | "invalid_assignment"
    | "not_found"
    | "persistence_failed"
    | "published_outcome_exists"
    | "round_incomplete"
    | "round_not_closed"
    | "round_not_open"
    | "stale_queue"
    | "submission_closed",
): never {
  if (error === "not_found") throwEventNotFound();
  if (error === "invalid_assignment") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Assign an active event reviewer to an active proposal.",
    });
  }
  if (error === "duplicate_assignment") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That reviewer is already assigned to this proposal.",
    });
  }
  if (error === "round_not_open") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The review round must be open for this action.",
    });
  }
  if (error === "round_not_closed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Close the review round before publishing decisions.",
    });
  }
  if (error === "round_incomplete") {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Some active assignments have no review. Confirm to close anyway.",
    });
  }
  if (error === "published_outcome_exists") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A round with published outcomes cannot be reopened.",
    });
  }
  if (error === "stale_queue") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The decision queue changed. Reload it before publishing.",
    });
  }
  if (error === "submission_closed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This proposal is no longer available for a queued decision.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The review workflow could not be saved.",
  });
}

export type AppRouter = typeof appRouter;
