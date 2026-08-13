import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  agendaItemActionSchema,
  moveAgendaItemSchema,
  placeProgramItemSchema,
  placeServiceBlockSchema,
  publishAgendaSchema,
  updateServiceBlockSchema,
} from "../shared/agendas";
import {
  cfpDefinitionInputSchema,
  existingCfpDefinitionInputSchema,
  eventOptionNameSchema,
  type CfpId,
  type TrackId,
} from "../shared/cfps";
import {
  retryCommunicationSchema,
  updateCommunicationTemplateSchema,
} from "../shared/communications";
import {
  invitationSecretInputSchema,
  inviteEventTeamSchema,
  revokeEventRoleSchema,
  revokeInvitationSchema,
} from "../shared/event-team";
import {
  eventInputSchema,
  eventSettingsInputSchema,
  roomIdSchema,
  type UserId,
} from "../shared/events";
import {
  assignmentInputSchema,
  assignmentReasonSchema,
  createTaskAssignmentSchema,
  createTaskDefinitionSchema,
  rejectEvidenceSchema,
  saveOnboardingFormSchema,
  taskFileUploadSchema,
} from "../shared/onboarding";
import {
  decisionPublicationSchema,
  decisionQueueStatusSchema,
  reviewerAssignmentIdSchema,
  saveReviewSchema,
} from "../shared/reviews";
import { saveSpeakerProfileSchema } from "../shared/speaker-profiles";
import {
  addSubmissionSpeakerSchema,
  proposalUpdateSchema,
  removeSubmissionSpeakerSchema,
  resendSubmissionSpeakerInvitationSchema,
  replaceSubmissionSpeakerInvitationSchema,
  submissionIdSchema,
  submitProposalSchema,
  uploadProposalFileSchema,
} from "../shared/submissions";

import {
  getAgendaPublicationStatus,
  getWorkingAgenda,
  moveAgendaItem,
  placeProgramItem,
  placeServiceBlock,
  publishAgenda,
  removeServiceBlock,
  setProgramPlacementCanceled,
  unplaceProgramItem,
  updateServiceBlock,
  type AgendaWriteError,
} from "./agendas/repository";
import {
  createDraftCfp,
  findPublicCfp,
  getCfpSetup,
  saveAndOpenCfp,
  updateDraftCfp,
} from "./cfps/repository";
import {
  listCommunicationFailures,
  listCommunicationTemplates,
  retryCommunication,
  updateCommunicationTemplate,
} from "./communications/repository";
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
  updateEventSettings,
} from "./events/repository";
import { getEventWorkspace } from "./events/workspace";
import type { Auth } from "./identity/auth";
import {
  attachTaskFile,
  cancelTaskAssignment,
  confirmManualTask,
  createTaskAssignment,
  createTaskDefinition,
  getOrganizerOnboardingBoard,
  listOwnOnboardingAssignments,
  overrideTask,
  recordTaskReminder,
  rejectTaskEvidence,
  reopenTaskAssignment,
  saveOnboardingFormDraft,
  submitOnboardingForm,
  waiveTask,
  type OnboardingWriteError,
} from "./onboarding/repository";
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
import { findPublishedSchedule } from "./published-schedule/repository";
import {
  assignReviewer,
  closeReviewRound,
  getOrganizerReviewBoard,
  listOwnReviewAssignments,
  openReviewRound,
  publishDecisions,
  queueDecision,
  reopenReviewRound,
  retryDecisionCommunicationsAndAuditEvents,
  revokeReviewerAssignment,
  saveReview,
  type ReviewWriteError,
} from "./reviews/repository";
import {
  getOwnSpeakerProfileState,
  saveOwnSpeakerProfile,
} from "./speaker-profiles/repository";
import { sendSubmissionSpeakerInvitation } from "./submission-speakers/delivery";
import {
  addSubmissionSpeaker,
  acceptSubmissionSpeakerInvitation,
  declineSubmissionSpeakerInvitation,
  findUsableSubmissionSpeakerInvitation,
  removeSubmissionSpeaker,
  resendSubmissionSpeakerInvitation,
  replaceSubmissionSpeakerInvitation,
  type SubmissionSpeakerInvitationDelivery,
} from "./submission-speakers/repository";
import {
  findAccessibleSubmission,
  uploadProposalFile,
  listAccessibleSubmissions,
  submitProposal,
  updateOwnSubmission,
  withdrawOwnSubmission,
} from "./submissions/repository";

type Context = {
  auth: Auth;
  config: AppConfig;
  database: Database;
  files: R2Bucket;
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
const cfpIdSchema = z.uuid().transform((value) => value as CfpId);
const userIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as UserId);

export const appRouter = trpc.router({
  communications: trpc.router({
    templates: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const templates = await listCommunicationTemplates(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!templates) throwEventNotFound();
        return templates;
      }),
    updateTemplate: authenticatedProcedure
      .input(updateCommunicationTemplateSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await updateCommunicationTemplate(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) {
          throw new TRPCError({
            code: result.error === "not_found" ? "NOT_FOUND" : "CONFLICT",
            message:
              result.error === "invalid_template"
                ? "The template contains an unsupported placeholder."
                : "The communication template changed. Refresh and try again.",
          });
        }
        return result.value;
      }),
    failures: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const failures = await listCommunicationFailures(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!failures) throwEventNotFound();
        return failures;
      }),
    retry: authenticatedProcedure
      .input(retryCommunicationSchema)
      .mutation(async ({ ctx, input }) => {
        const retried = await retryCommunication(
          ctx.database,
          ctx.userId,
          input.slug,
          input.communicationId,
        );
        if (!retried) throwEventNotFound();
        return { retried: true };
      }),
  }),
  agendas: trpc.router({
    working: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const agenda = await getWorkingAgenda(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!agenda) throwEventNotFound();
        return agenda;
      }),
    publicationStatus: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const publication = await getAgendaPublicationStatus(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (publication === undefined) throwEventNotFound();
        return publication;
      }),
    placeProgram: authenticatedProcedure
      .input(placeProgramItemSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await placeProgramItem(ctx.database, ctx.userId, input);
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    placeService: authenticatedProcedure
      .input(placeServiceBlockSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await placeServiceBlock(ctx.database, ctx.userId, input);
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    move: authenticatedProcedure
      .input(moveAgendaItemSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await moveAgendaItem(ctx.database, ctx.userId, input);
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    updateService: authenticatedProcedure
      .input(updateServiceBlockSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await updateServiceBlock(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    unplaceProgram: authenticatedProcedure
      .input(agendaItemActionSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await unplaceProgramItem(
          ctx.database,
          ctx.userId,
          input.slug,
          input.agendaItemId,
        );
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    cancel: authenticatedProcedure
      .input(agendaItemActionSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await setProgramPlacementCanceled(
          ctx.database,
          ctx.userId,
          input.slug,
          input.agendaItemId,
          true,
        );
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    restore: authenticatedProcedure
      .input(agendaItemActionSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await setProgramPlacementCanceled(
          ctx.database,
          ctx.userId,
          input.slug,
          input.agendaItemId,
          false,
        );
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    removeService: authenticatedProcedure
      .input(agendaItemActionSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await removeServiceBlock(
          ctx.database,
          ctx.userId,
          input.slug,
          input.agendaItemId,
        );
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    publish: authenticatedProcedure
      .input(publishAgendaSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await publishAgenda(ctx.database, ctx.userId, input);
        if (!result.ok) throwAgendaWriteError(result.error);
        return result.value;
      }),
    published: trpc.procedure.input(slugInput).query(async ({ ctx, input }) => {
      const schedule = await findPublishedSchedule(
        ctx.database,
        input.slug,
        new URL(ctx.request.url).origin,
      );
      if (!schedule) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This event has no published agenda.",
        });
      }
      return schedule;
    }),
  }),
  events: trpc.router({
    workspace: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const workspace = await getEventWorkspace(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!workspace) throwEventNotFound();
        return workspace;
      }),
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
    updateSettings: authenticatedProcedure
      .input(eventSettingsInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await updateEventSettings(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) {
          if (result.error === "not_found") throwEventNotFound();
          throw new TRPCError({
            code: "CONFLICT",
            message:
              result.error === "revision_conflict"
                ? "These event settings changed elsewhere. Reload and try again."
                : "Move agenda items inside the event dates before changing these settings. The timezone cannot change after agenda placement starts.",
          });
        }
        return result.value;
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
        slugInput.extend(existingCfpDefinitionInputSchema.shape).extend({
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
        slugInput.extend(existingCfpDefinitionInputSchema.shape).extend({
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
    list: authenticatedProcedure.query(({ ctx }) =>
      listAccessibleSubmissions(ctx.database, ctx.userId),
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
          ctx.files,
          ctx.userId,
          ctx.session.user.email,
          input,
        );
        if (!result.ok) throwProposalWriteError(result.error);
        const deliveries = await Promise.all(
          result.invitationDeliveries.map((invitation) =>
            deliverSubmissionSpeakerInvitation(ctx.config, invitation),
          ),
        );
        return {
          ...result.value,
          invitationDeliveryFailed: deliveries.includes("failed"),
        };
      }),
    uploadFile: authenticatedProcedure
      .input(uploadProposalFileSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await uploadProposalFile(
          ctx.database,
          ctx.files,
          ctx.userId,
          input,
        );
        if (!result.ok) throwProposalWriteError(result.error);
        return result.value;
      }),
    get: authenticatedProcedure
      .input(z.object({ submissionId: submissionIdSchema }))
      .query(async ({ ctx, input }) => {
        const submission = await findAccessibleSubmission(
          ctx.database,
          ctx.userId,
          input.submissionId,
        );
        if (!submission) throwSubmissionNotFound();
        return submission;
      }),
    addSpeaker: authenticatedProcedure
      .input(addSubmissionSpeakerSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await addSubmissionSpeaker(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) throwSubmissionSpeakerWriteError(result.error);
        const delivery = await deliverSubmissionSpeakerInvitation(
          ctx.config,
          result.value.delivery,
        );
        return {
          speakerId: result.value.speakerId,
          invitationId: result.value.invitationId,
          delivery,
        };
      }),
    replaceSpeakerInvitation: authenticatedProcedure
      .input(replaceSubmissionSpeakerInvitationSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await replaceSubmissionSpeakerInvitation(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) throwSubmissionSpeakerWriteError(result.error);
        const delivery = await deliverSubmissionSpeakerInvitation(
          ctx.config,
          result.value.delivery,
        );
        return { invitationId: result.value.invitationId, delivery };
      }),
    resendSpeakerInvitation: authenticatedProcedure
      .input(resendSubmissionSpeakerInvitationSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await resendSubmissionSpeakerInvitation(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) throwSubmissionSpeakerWriteError(result.error);
        const delivery = await deliverSubmissionSpeakerInvitation(
          ctx.config,
          result.value.delivery,
        );
        return { invitationId: result.value.invitationId, delivery };
      }),
    removeSpeaker: authenticatedProcedure
      .input(removeSubmissionSpeakerSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await removeSubmissionSpeaker(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) throwSubmissionSpeakerWriteError(result.error);
        return result.value;
      }),
    updateOwn: authenticatedProcedure
      .input(proposalUpdateSchema.extend({ submissionId: submissionIdSchema }))
      .mutation(async ({ ctx, input }) => {
        const result = await updateOwnSubmission(
          ctx.database,
          ctx.files,
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
      .input(slugInput.extend({ allowMissingReviews: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const result = await closeReviewRound(
          ctx.database,
          ctx.userId,
          input.slug,
          input.allowMissingReviews,
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
    retryPublicationRecords: authenticatedProcedure
      .input(slugInput)
      .mutation(async ({ ctx, input }) => {
        const result = await retryDecisionCommunicationsAndAuditEvents(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!result.ok) throwReviewWriteError(result.error);
        return result.value;
      }),
  }),
  submissionSpeakerInvitations: trpc.router({
    get: trpc.procedure
      .input(invitationSecretInputSchema)
      .query(async ({ ctx, input }) => {
        const result = await findUsableSubmissionSpeakerInvitation(
          ctx.database,
          input.secret,
        );
        if (!result.ok) throwInvitationLookupError(result.error);
        return {
          ...result.value,
          expiresAt: result.value.expiresAt.toISOString(),
        };
      }),
    decline: trpc.procedure
      .input(invitationSecretInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await declineSubmissionSpeakerInvitation(
          ctx.database,
          input.secret,
        );
        if (!result.ok) throwInvitationLookupError(result.error);
        return { declined: true };
      }),
    accept: authenticatedProcedure
      .input(invitationSecretInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await acceptSubmissionSpeakerInvitation(
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
  onboarding: trpc.router({
    organizerBoard: authenticatedProcedure
      .input(slugInput)
      .query(async ({ ctx, input }) => {
        const board = await getOrganizerOnboardingBoard(
          ctx.database,
          ctx.userId,
          input.slug,
        );
        if (!board) throwEventNotFound();
        return board;
      }),
    mine: authenticatedProcedure.query(({ ctx }) =>
      listOwnOnboardingAssignments(ctx.database, ctx.userId),
    ),
    createDefinition: authenticatedProcedure
      .input(createTaskDefinitionSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await createTaskDefinition(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    createAssignment: authenticatedProcedure
      .input(createTaskAssignmentSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await createTaskAssignment(
          ctx.database,
          ctx.userId,
          input,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    confirmManual: authenticatedProcedure
      .input(assignmentInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await confirmManualTask(
          ctx.database,
          ctx.userId,
          input.assignmentId,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    saveFormDraft: authenticatedProcedure
      .input(saveOnboardingFormSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await saveOnboardingFormDraft(
          ctx.database,
          ctx.userId,
          input.assignmentId,
          input.answers,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    submitForm: authenticatedProcedure
      .input(assignmentInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await submitOnboardingForm(
          ctx.database,
          ctx.userId,
          input.assignmentId,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    uploadFile: authenticatedProcedure
      .input(taskFileUploadSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await attachTaskFile(
          ctx.database,
          ctx.files,
          ctx.userId,
          input,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    waive: authenticatedProcedure
      .input(assignmentReasonSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await waiveTask(
          ctx.database,
          ctx.userId,
          input.assignmentId,
          input.reason,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    override: authenticatedProcedure
      .input(assignmentReasonSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await overrideTask(
          ctx.database,
          ctx.userId,
          input.assignmentId,
          input.reason,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    rejectEvidence: authenticatedProcedure
      .input(rejectEvidenceSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await rejectTaskEvidence(
          ctx.database,
          ctx.userId,
          input.evidenceId,
          input.reason,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    reopen: authenticatedProcedure
      .input(assignmentReasonSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await reopenTaskAssignment(
          ctx.database,
          ctx.userId,
          input.assignmentId,
          input.reason,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    cancelAssignment: authenticatedProcedure
      .input(assignmentInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await cancelTaskAssignment(
          ctx.database,
          ctx.userId,
          input.assignmentId,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
    recordReminder: authenticatedProcedure
      .input(assignmentInputSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await recordTaskReminder(
          ctx.database,
          ctx.userId,
          input.assignmentId,
        );
        if (!result.ok) throwOnboardingWriteError(result.error);
        return result.value;
      }),
  }),
  speakerProfile: trpc.router({
    getOwn: authenticatedProcedure.query(({ ctx }) =>
      getOwnSpeakerProfileState(ctx.database, ctx.userId),
    ),
    saveOwn: authenticatedProcedure
      .input(saveSpeakerProfileSchema)
      .mutation(async ({ ctx, input }) => {
        const result = await saveOwnSpeakerProfile(
          ctx.database,
          ctx.files,
          ctx.userId,
          input,
        );
        if (!result.ok) {
          throw new TRPCError({
            code:
              result.error === "not_a_speaker"
                ? "FORBIDDEN"
                : result.error === "profile_conflict"
                  ? "CONFLICT"
                  : result.error === "invalid_file"
                    ? "BAD_REQUEST"
                    : "INTERNAL_SERVER_ERROR",
            message:
              result.error === "not_a_speaker"
                ? "Claim a proposed-speaker invitation before creating a profile."
                : result.error === "profile_conflict"
                  ? "The profile changed while this save was in progress. Try again."
                  : result.error === "invalid_file"
                    ? "Choose a valid JPEG, PNG, or WebP image under 10 MB."
                    : "The speaker profile could not be saved.",
          });
        }
        return result.value;
      }),
  }),
});

async function deliverSubmissionSpeakerInvitation(
  config: AppConfig,
  invitation: SubmissionSpeakerInvitationDelivery,
): Promise<"sent" | "failed"> {
  try {
    await sendSubmissionSpeakerInvitation(config, invitation);
    return "sent";
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "submission_speaker_invitation_delivery_failed",
        invitationId: invitation.id,
        error: error instanceof Error ? error.message : "Unknown email failure",
      }),
    );
    return "failed";
  }
}

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
    | "cfp_changed"
    | "deadline_after_event"
    | "deadline_passed"
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
  if (error === "cfp_changed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This call for proposals changed. Reload it before saving.",
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
    | "invalid_file"
    | "invalid_format"
    | "invalid_track"
    | "not_found"
    | "persistence_failed"
    | "submission_changed"
    | "submission_closed",
): never {
  if (error === "not_found") throwSubmissionNotFound();
  if (error === "submission_closed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This proposal can no longer be edited.",
    });
  }
  if (error === "submission_changed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This proposal changed elsewhere. The latest version is shown.",
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
  if (error === "invalid_file") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Choose a file that matches this question's type and size limit.",
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

function throwSubmissionSpeakerWriteError(
  error:
    | "duplicate_speaker"
    | "invitation_not_replaceable"
    | "last_speaker"
    | "not_found"
    | "persistence_failed"
    | "submission_closed",
): never {
  if (error === "not_found") throwSubmissionNotFound();
  if (error === "duplicate_speaker") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That proposed-speaker email is already active.",
    });
  }
  if (error === "submission_closed") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This proposal can no longer be edited.",
    });
  }
  if (error === "last_speaker") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "An active proposal must keep at least one proposed speaker.",
    });
  }
  if (error === "invitation_not_replaceable") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That invitation can no longer be replaced.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The proposed speaker could not be saved.",
  });
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

function throwAgendaWriteError(error: AgendaWriteError): never {
  if (error === "not_found") throwEventNotFound();
  if (error === "agenda_item_not_found") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Agenda item not found.",
    });
  }
  const messages: Partial<Record<AgendaWriteError, string>> = {
    agenda_changed: "The working agenda changed. Reload it before publishing.",
    agenda_item_changed:
      "This agenda item changed. Reload it before saving your changes.",
    archived_reference:
      "Restore or replace archived rooms and tracks before publishing.",
    invalid_time:
      "Every agenda item needs a valid time within the event dates.",
    invalid_time_range: "End time must be after start time.",
    invalid_agenda_item: "Use an agenda item that belongs to this event.",
    missing_room:
      "Assign every scheduled session and room-wide block to a room.",
    program_item_unavailable:
      "Only an unplaced accepted program item can be scheduled.",
    room_conflict: "Resolve every room conflict before publishing.",
    speaker_conflict: "Resolve every speaker conflict before publishing.",
    timezone_ambiguous: "Choose times that occur once in the event timezone.",
  };
  if (error !== "persistence_failed") {
    throw new TRPCError({
      code:
        error === "invalid_time" || error === "invalid_time_range"
          ? "BAD_REQUEST"
          : "CONFLICT",
      message: messages[error] ?? "The agenda cannot be published.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The agenda could not be saved.",
  });
}

function throwOnboardingWriteError(error: OnboardingWriteError): never {
  if (error === "not_found") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
  }
  if (error === "already_rejected") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This evidence was already rejected.",
    });
  }
  if (
    error === "invalid_assignment" ||
    error === "invalid_mechanism" ||
    error === "current_evidence_exists"
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This action does not match the current task assignment.",
    });
  }
  if (error === "invalid_answers") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Complete every required answer before submission.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The onboarding task could not be saved.",
  });
}

function throwReviewWriteError(error: ReviewWriteError): never {
  if (error === "not_found") throwEventNotFound();
  if (error === "invalid_assignment") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Assign an active event reviewer to an active proposal.",
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
