import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  customFieldsSchema,
  visibleCustomFields,
  type CustomField,
} from "../../shared/cfps";
import type { UserId } from "../../shared/events";
import type { StoredFileId } from "../../shared/files";
import {
  proposalAnswersSchema,
  submissionSchema,
  type ProposalContent,
  type ProposalUpdate,
  type Submission,
  type SubmissionId,
  type SubmissionSpeakerId,
  type SubmitProposalInput,
  type UploadProposalFileInput,
} from "../../shared/submissions";
import {
  communicationInsertStatements,
  prepareCommunication,
} from "../communications/repository";
import type { Database } from "../database/client";
import {
  cfps,
  communications,
  decisions,
  eventRoles,
  events,
  formResponses,
  formResponseAttachments,
  reviewerAssignments,
  submissions,
  submissionSpeakerInvitations,
  submissionSpeakers,
  submissionFileUploads,
  storedFiles,
  tracks,
} from "../database/schema";
import {
  compensateStoredFile,
  matchesStoredFileContentType,
  putStoredFile,
} from "../files/repository";
import { reportOperationalFailure } from "../observability";
import {
  prepareSubmissionSpeakerInvitation,
  type SubmissionSpeakerInvitationDelivery,
} from "../submission-speakers/repository";

type ProposalWriteError =
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
  | "submission_closed";

type ProposalWriteResult =
  { ok: true; value: Submission } | { ok: false; error: ProposalWriteError };

type ValidatedProposalInput = Pick<
  ProposalContent,
  "abstract" | "customAnswers" | "fileAnswers" | "format" | "title" | "trackId"
> & { ownerUserId: UserId; clientDraftId: string };

type SubmitProposalResult =
  | {
      ok: true;
      value: Submission;
      invitationDeliveries: SubmissionSpeakerInvitationDelivery[];
    }
  | { ok: false; error: ProposalWriteError };

export async function submitProposal(
  database: Database,
  files: R2Bucket,
  ownerUserId: UserId,
  ownerEmail: string,
  input: SubmitProposalInput,
): Promise<SubmitProposalResult> {
  const [existing] = await database
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.cfpId, input.cfpId),
        eq(submissions.ownerUserId, ownerUserId),
        eq(submissions.clientDraftId, input.clientDraftId),
      ),
    )
    .limit(1);
  if (existing) {
    const submission = await findAccessibleSubmission(
      database,
      ownerUserId,
      existing.id as SubmissionId,
    );
    return submission
      ? { ok: true, value: submission, invitationDeliveries: [] }
      : { ok: false, error: "persistence_failed" };
  }

  const validated = await validateProposal(database, input.slug, input.cfpId, {
    ...input,
    ownerUserId,
    clientDraftId: input.clientDraftId,
  });
  if (!validated.ok) return validated;
  const pendingFiles = await listPendingProposalFiles(
    database,
    ownerUserId,
    input.cfpId,
    input.clientDraftId,
  );

  const submissionId = crypto.randomUUID() as SubmissionId;
  const formResponseId = crypto.randomUUID();
  const writeToken = crypto.randomUUID();
  const now = new Date();
  const speakerRows = input.proposedSpeakers.map((speaker, position) => ({
    id: crypto.randomUUID() as SubmissionSpeakerId,
    submissionId,
    invitedName: speaker.name,
    invitedEmail: speaker.email,
    claimedUserId:
      speaker.email === ownerEmail.trim().toLowerCase()
        ? ownerUserId
        : undefined,
    position,
    createdAt: now,
    updatedAt: now,
  }));
  const invitationAttempts = await Promise.all(
    speakerRows
      .filter((speaker) => speaker.claimedUserId === undefined)
      .map((speaker) =>
        prepareSubmissionSpeakerInvitation(
          {
            submissionSpeakerId: speaker.id,
            email: speaker.invitedEmail,
            eventName: validated.eventName,
            speakerName: speaker.invitedName,
            submissionTitle: input.title,
            invitedByUserId: ownerUserId,
          },
          now,
        ),
      ),
  );
  let confirmation: Awaited<ReturnType<typeof prepareCommunication>>;
  try {
    confirmation = await prepareCommunication(database, {
      eventId: validated.eventId,
      submissionId,
      purpose: "submission_confirmation",
      recipient: {
        key: `user:${ownerUserId}`,
        userId: ownerUserId,
        invitationId: null,
        destination: ownerEmail,
        name: ownerEmail,
      },
      variables: {
        eventName: validated.eventName,
        submissionTitle: input.title,
        recipientName: ownerEmail,
      },
      context: { submissionId, cfpId: input.cfpId },
      now,
    });
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  try {
    await database.batch([
      database.insert(submissions).values({
        id: submissionId,
        eventId: validated.eventId,
        cfpId: input.cfpId,
        cfpRevision: validated.revision,
        ownerUserId,
        clientDraftId: input.clientDraftId,
        trackId: input.trackId,
        title: input.title,
        abstract: input.abstract,
        format: input.format,
        status: "active",
        writeToken,
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(decisions).values({
        id: crypto.randomUUID(),
        submissionId,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(submissionSpeakers).values(speakerRows),
      ...(invitationAttempts.length > 0
        ? [
            database
              .insert(submissionSpeakerInvitations)
              .values(invitationAttempts.map((attempt) => attempt.values)),
          ]
        : []),
      database.insert(formResponses).values({
        id: formResponseId,
        cfpId: input.cfpId,
        submissionId,
        answersJson: JSON.stringify(validated.answers),
        writeToken,
        createdAt: now,
        updatedAt: now,
      }),
      ...(validated.attachments.length > 0
        ? [
            database.insert(formResponseAttachments).values(
              validated.attachments.map((attachment) => ({
                id: crypto.randomUUID(),
                formResponseId,
                fieldKey: attachment.fieldKey,
                storedFileId: attachment.storedFileId,
                createdAt: now,
              })),
            ),
          ]
        : []),
      database
        .delete(submissionFileUploads)
        .where(
          and(
            eq(submissionFileUploads.cfpId, input.cfpId),
            eq(submissionFileUploads.ownerUserId, ownerUserId),
            eq(submissionFileUploads.clientDraftId, input.clientDraftId),
          ),
        ),
      ...communicationInsertStatements(database, confirmation),
      database
        .update(cfps)
        .set({ structureLockedAt: now, updatedAt: now })
        .where(eq(cfps.id, input.cfpId)),
    ]);
  } catch (error: unknown) {
    if (String(error).includes("stale_cfp")) {
      return { ok: false, error: "cfp_changed" };
    }
    if (String(error).includes("UNIQUE constraint failed")) {
      const [raced] = await database
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.cfpId, input.cfpId),
            eq(submissions.ownerUserId, ownerUserId),
            eq(submissions.clientDraftId, input.clientDraftId),
          ),
        )
        .limit(1);
      const submission = raced
        ? await findAccessibleSubmission(
            database,
            ownerUserId,
            raced.id as SubmissionId,
          )
        : undefined;
      return submission
        ? { ok: true, value: submission, invitationDeliveries: [] }
        : { ok: false, error: "persistence_failed" };
    }
    return { ok: false, error: "persistence_failed" };
  }

  await removeUnusedProposalFiles(
    database,
    files,
    pendingFiles,
    new Set(validated.attachments.map(({ storedFileId }) => storedFileId)),
  );

  const submission = await findAccessibleSubmission(
    database,
    ownerUserId,
    submissionId,
  );
  return submission
    ? {
        ok: true,
        value: submission,
        invitationDeliveries: invitationAttempts.map(
          (attempt) => attempt.delivery,
        ),
      }
    : { ok: false, error: "persistence_failed" };
}

export async function findAccessibleSubmission(
  database: Database,
  viewerUserId: UserId,
  submissionId: SubmissionId,
): Promise<Submission | undefined> {
  const [row] = await database
    .select({
      id: submissions.id,
      status: submissions.status,
      revision: submissions.revision,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      eventName: events.name,
      eventSlug: events.slug,
      cfpId: cfps.id,
      cfpName: cfps.name,
      cfpStatus: cfps.status,
      deadline: cfps.deadline,
      formatsJson: cfps.formatsJson,
      customFieldsJson: cfps.customFieldsJson,
      eventId: events.id,
      trackId: tracks.id,
      trackName: tracks.name,
      answersJson: formResponses.answersJson,
      decisionStatus: decisions.status,
      formResponseId: formResponses.id,
      communicationId: communications.id,
      submissionOwnerUserId: submissions.ownerUserId,
      eventOwnerUserId: events.ownerUserId,
    })
    .from(submissions)
    .innerJoin(events, eq(events.id, submissions.eventId))
    .innerJoin(cfps, eq(cfps.id, submissions.cfpId))
    .innerJoin(tracks, eq(tracks.id, submissions.trackId))
    .innerJoin(formResponses, eq(formResponses.submissionId, submissions.id))
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .innerJoin(
      communications,
      and(
        eq(communications.submissionId, submissions.id),
        eq(communications.purpose, "submission_confirmation"),
      ),
    )
    .where(
      and(
        eq(submissions.id, submissionId),
        accessibleSubmissionWhere(database, viewerUserId),
      ),
    )
    .limit(1);
  if (!row) return undefined;

  const [organizerRole] = await database
    .select({ id: eventRoles.id })
    .from(eventRoles)
    .where(
      and(
        eq(eventRoles.eventId, row.eventId),
        eq(eventRoles.userId, viewerUserId),
        eq(eventRoles.role, "organizer"),
        isNull(eventRoles.revokedAt),
      ),
    )
    .limit(1);
  const fileAnswers = await listFormResponseFiles(database, submissionId);

  const speakers = await database
    .select({
      id: submissionSpeakers.id,
      name: submissionSpeakers.invitedName,
      email: submissionSpeakers.invitedEmail,
      claimedUserId: submissionSpeakers.claimedUserId,
    })
    .from(submissionSpeakers)
    .where(
      and(
        eq(submissionSpeakers.submissionId, submissionId),
        isNull(submissionSpeakers.removedAt),
      ),
    )
    .orderBy(submissionSpeakers.position);
  const invitationHistory = speakers.length
    ? await database
        .select({
          id: submissionSpeakerInvitations.id,
          speakerId: submissionSpeakerInvitations.submissionSpeakerId,
          status: submissionSpeakerInvitations.status,
          expiresAt: submissionSpeakerInvitations.expiresAt,
          createdAt: submissionSpeakerInvitations.createdAt,
        })
        .from(submissionSpeakerInvitations)
        .where(
          inArray(
            submissionSpeakerInvitations.submissionSpeakerId,
            speakers.map((speaker) => speaker.id),
          ),
        )
        .orderBy(desc(submissionSpeakerInvitations.createdAt))
    : [];
  const latestInvitationBySpeaker = new Map<
    string,
    (typeof invitationHistory)[number]
  >();
  for (const invitation of invitationHistory) {
    if (!latestInvitationBySpeaker.has(invitation.speakerId)) {
      latestInvitationBySpeaker.set(invitation.speakerId, invitation);
    }
  }
  const formTracks = await database
    .select({
      id: tracks.id,
      name: tracks.name,
      archivedAt: tracks.archivedAt,
    })
    .from(tracks)
    .where(
      and(
        eq(tracks.eventId, row.eventId),
        or(isNull(tracks.archivedAt), eq(tracks.id, row.trackId)),
      ),
    )
    .orderBy(tracks.position);
  const published = isPublished(row.decisionStatus);
  const active = row.status === "active";
  const editingOpen =
    active &&
    !published &&
    row.cfpStatus === "open" &&
    new Date(row.deadline) > new Date();
  const managesSubmission =
    row.submissionOwnerUserId === viewerUserId ||
    row.eventOwnerUserId === viewerUserId ||
    organizerRole !== undefined;
  const canManageSpeakers = managesSubmission && editingOpen;

  return submissionSchema.parse({
    id: row.id,
    status: row.status,
    revision: row.revision,
    event: { name: row.eventName, slug: row.eventSlug },
    cfp: { id: row.cfpId, name: row.cfpName },
    title: row.title,
    abstract: row.abstract,
    format: row.format,
    track: { id: row.trackId, name: row.trackName },
    form: {
      deadline: row.deadline,
      formats: JSON.parse(row.formatsJson) as unknown,
      tracks: formTracks.map((track) => ({
        id: track.id,
        name: track.name,
        archived: track.archivedAt !== null,
      })),
      customFields: JSON.parse(row.customFieldsJson) as unknown,
    },
    proposedSpeakers: speakers.map((speaker) => {
      const invitation = latestInvitationBySpeaker.get(speaker.id);
      const canSeeContact =
        managesSubmission || speaker.claimedUserId === viewerUserId;
      return {
        id: speaker.id,
        name: speaker.name,
        email: canSeeContact ? speaker.email : null,
        claimed: speaker.claimedUserId !== null,
        invitation:
          invitation && canSeeContact
            ? {
                id: invitation.id,
                status: invitation.status,
                expiresAt: invitation.expiresAt.toISOString(),
                usable:
                  invitation.status === "pending" &&
                  invitation.expiresAt.getTime() > Date.now(),
              }
            : null,
      };
    }),
    customAnswers: JSON.parse(row.answersJson) as unknown,
    fileAnswers,
    decision: { status: publicDecisionStatus(row.decisionStatus) },
    confirmation: { status: row.communicationId ? "recorded" : undefined },
    permissions: {
      canEdit: row.submissionOwnerUserId === viewerUserId && editingOpen,
      canManageSpeakers,
      canWithdraw:
        row.submissionOwnerUserId === viewerUserId && active && !published,
    },
  });
}

export async function listAccessibleSubmissions(
  database: Database,
  userId: UserId,
): Promise<Submission[]> {
  const rows = await database
    .selectDistinct({ id: submissions.id })
    .from(submissions)
    .innerJoin(events, eq(events.id, submissions.eventId))
    .where(accessibleSubmissionWhere(database, userId))
    .orderBy(desc(submissions.updatedAt));
  const accessible = await Promise.all(
    rows.map(({ id }) =>
      findAccessibleSubmission(database, userId, id as SubmissionId),
    ),
  );
  return accessible.filter((submission) => submission !== undefined);
}

function accessibleSubmissionWhere(database: Database, userId: UserId) {
  return or(
    eq(submissions.ownerUserId, userId),
    eq(events.ownerUserId, userId),
    exists(
      database
        .select({ id: submissionSpeakers.id })
        .from(submissionSpeakers)
        .where(
          and(
            eq(submissionSpeakers.submissionId, submissions.id),
            eq(submissionSpeakers.claimedUserId, userId),
            isNull(submissionSpeakers.removedAt),
          ),
        ),
    ),
    exists(
      database
        .select({ id: eventRoles.id })
        .from(eventRoles)
        .where(
          and(
            eq(eventRoles.eventId, submissions.eventId),
            eq(eventRoles.userId, userId),
            eq(eventRoles.role, "organizer"),
            isNull(eventRoles.revokedAt),
          ),
        ),
    ),
  );
}

export async function updateOwnSubmission(
  database: Database,
  files: R2Bucket,
  ownerUserId: UserId,
  submissionId: SubmissionId,
  input: ProposalUpdate,
): Promise<ProposalWriteResult> {
  const [current] = await database
    .select({
      status: submissions.status,
      slug: events.slug,
      cfpId: submissions.cfpId,
      decisionStatus: decisions.status,
      formResponseId: formResponses.id,
    })
    .from(submissions)
    .innerJoin(events, eq(events.id, submissions.eventId))
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .innerJoin(formResponses, eq(formResponses.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, error: "not_found" };
  if (current.status !== "active" || isPublished(current.decisionStatus)) {
    return { ok: false, error: "submission_closed" };
  }
  const validated = await validateProposal(
    database,
    current.slug,
    current.cfpId,
    { ...input, ownerUserId, clientDraftId: submissionId },
  );
  if (!validated.ok) return validated;
  const staleFiles = await listProposalWriteFiles(
    database,
    ownerUserId,
    current.formResponseId,
    current.cfpId,
    submissionId,
  );

  const now = new Date();
  const writeToken = crypto.randomUUID();
  try {
    const [submissionUpdateResult] = await database.batch([
      database
        .update(submissions)
        .set({
          trackId: input.trackId,
          title: input.title,
          abstract: input.abstract,
          format: input.format,
          revision: sql`${submissions.revision} + 1`,
          writeToken,
          updatedAt: now,
        })
        .where(
          and(
            eq(submissions.id, submissionId),
            eq(submissions.ownerUserId, ownerUserId),
            eq(submissions.status, "active"),
            eq(submissions.revision, input.expectedRevision),
            exists(
              database
                .select({ id: decisions.id })
                .from(decisions)
                .where(
                  and(
                    eq(decisions.submissionId, submissionId),
                    notInArray(decisions.status, ["accepted", "declined"]),
                  ),
                ),
            ),
            exists(
              database
                .select({ id: cfps.id })
                .from(cfps)
                .innerJoin(
                  tracks,
                  and(
                    eq(tracks.id, input.trackId),
                    eq(tracks.eventId, cfps.eventId),
                    isNull(tracks.archivedAt),
                  ),
                )
                .where(
                  and(
                    eq(cfps.id, current.cfpId),
                    eq(cfps.status, "open"),
                    eq(cfps.updatedAt, validated.revision),
                    sql`julianday(${cfps.deadline}) > julianday('now')`,
                  ),
                ),
            ),
          ),
        ),
      database
        .update(formResponses)
        .set({
          answersJson: JSON.stringify(validated.answers),
          writeToken,
          updatedAt: now,
        })
        .where(eq(formResponses.submissionId, submissionId)),
      database
        .delete(formResponseAttachments)
        .where(
          inArray(
            formResponseAttachments.formResponseId,
            database
              .select({ id: formResponses.id })
              .from(formResponses)
              .where(eq(formResponses.submissionId, submissionId)),
          ),
        ),
      ...(validated.attachments.length > 0
        ? [
            database.insert(formResponseAttachments).values(
              validated.attachments.map((attachment) => ({
                id: crypto.randomUUID(),
                formResponseId: current.formResponseId,
                fieldKey: attachment.fieldKey,
                storedFileId: attachment.storedFileId,
                createdAt: now,
              })),
            ),
          ]
        : []),
      database
        .delete(submissionFileUploads)
        .where(
          and(
            eq(submissionFileUploads.cfpId, current.cfpId),
            eq(submissionFileUploads.ownerUserId, ownerUserId),
            eq(submissionFileUploads.clientDraftId, submissionId),
          ),
        ),
    ]);
    if (submissionUpdateResult.meta.changes === 0) {
      return { ok: false, error: "submission_closed" };
    }
  } catch (error: unknown) {
    if (String(error).includes("submission_closed")) {
      const latest = await findSubmissionWriteState(
        database,
        ownerUserId,
        submissionId,
      );
      if (
        latest?.status === "active" &&
        !isPublished(latest.decisionStatus) &&
        latest.revision !== input.expectedRevision
      ) {
        return { ok: false, error: "submission_changed" };
      }
      return { ok: false, error: "submission_closed" };
    }
    return { ok: false, error: "persistence_failed" };
  }

  await removeUnusedProposalFiles(
    database,
    files,
    staleFiles,
    new Set(validated.attachments.map(({ storedFileId }) => storedFileId)),
  );

  const submission = await findAccessibleSubmission(
    database,
    ownerUserId,
    submissionId,
  );
  return submission
    ? { ok: true, value: submission }
    : { ok: false, error: "persistence_failed" };
}

async function findSubmissionWriteState(
  database: Database,
  ownerUserId: UserId,
  submissionId: SubmissionId,
) {
  const [state] = await database
    .select({
      status: submissions.status,
      revision: submissions.revision,
      decisionStatus: decisions.status,
    })
    .from(submissions)
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  return state;
}

export async function withdrawOwnSubmission(
  database: Database,
  ownerUserId: UserId,
  submissionId: SubmissionId,
): Promise<ProposalWriteResult> {
  const [current] = await database
    .select({ status: submissions.status, decisionStatus: decisions.status })
    .from(submissions)
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, error: "not_found" };
  if (current.status !== "active" || isPublished(current.decisionStatus)) {
    return { ok: false, error: "submission_closed" };
  }

  const now = new Date();
  let submissionUpdateResult;
  try {
    [submissionUpdateResult] = await database.batch([
      database
        .update(submissions)
        .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
        .where(
          and(
            eq(submissions.id, submissionId),
            eq(submissions.ownerUserId, ownerUserId),
            eq(submissions.status, "active"),
            exists(
              database
                .select({ id: decisions.id })
                .from(decisions)
                .where(
                  and(
                    eq(decisions.submissionId, submissionId),
                    notInArray(decisions.status, ["accepted", "declined"]),
                  ),
                ),
            ),
          ),
        ),
      database
        .update(decisions)
        .set({ status: "pending", updatedAt: now })
        .where(
          and(
            eq(decisions.submissionId, submissionId),
            inArray(decisions.status, ["accept_queued", "decline_queued"]),
            exists(
              database
                .select({ id: submissions.id })
                .from(submissions)
                .where(
                  and(
                    eq(submissions.id, submissionId),
                    eq(submissions.ownerUserId, ownerUserId),
                    eq(submissions.status, "withdrawn"),
                    eq(submissions.updatedAt, now),
                  ),
                ),
            ),
          ),
        ),
      database
        .update(reviewerAssignments)
        .set({ revokedAt: now, revokedByUserId: ownerUserId })
        .where(
          and(
            eq(reviewerAssignments.submissionId, submissionId),
            isNull(reviewerAssignments.revokedAt),
          ),
        ),
    ]);
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  if (submissionUpdateResult.meta.changes === 0) {
    return { ok: false, error: "submission_closed" };
  }

  const submission = await findAccessibleSubmission(
    database,
    ownerUserId,
    submissionId,
  );
  return submission
    ? { ok: true, value: submission }
    : { ok: false, error: "persistence_failed" };
}

async function validateProposal(
  database: Database,
  slug: string,
  cfpId: string,
  input: ValidatedProposalInput,
): Promise<
  | {
      ok: true;
      eventId: string;
      eventName: string;
      revision: Date;
      answers: Record<string, string>;
      attachments: Array<{
        fieldKey: string;
        storedFileId: string;
        uploadId: string | null;
      }>;
    }
  | { ok: false; error: ProposalWriteError }
> {
  const [definition] = await database
    .select({
      eventId: events.id,
      eventName: events.name,
      deadline: cfps.deadline,
      formatsJson: cfps.formatsJson,
      customFieldsJson: cfps.customFieldsJson,
      updatedAt: cfps.updatedAt,
      trackId: tracks.id,
    })
    .from(cfps)
    .innerJoin(events, eq(events.id, cfps.eventId))
    .leftJoin(
      tracks,
      and(
        eq(tracks.id, input.trackId),
        eq(tracks.eventId, events.id),
        isNull(tracks.archivedAt),
      ),
    )
    .where(
      and(eq(cfps.id, cfpId), eq(events.slug, slug), eq(cfps.status, "open")),
    )
    .limit(1);
  if (!definition) return { ok: false, error: "cfp_unavailable" };
  if (new Date(definition.deadline) <= new Date()) {
    return { ok: false, error: "deadline_passed" };
  }
  if (!definition.trackId) return { ok: false, error: "invalid_track" };

  const formats = parseStringArray(
    JSON.parse(definition.formatsJson) as unknown,
  );
  if (!formats?.includes(input.format)) {
    return { ok: false, error: "invalid_format" };
  }

  const fields = customFieldsSchema.safeParse(
    JSON.parse(definition.customFieldsJson) as unknown,
  );
  const answers = proposalAnswersSchema.safeParse(input.customAnswers);
  if (!fields.success || !answers.success) {
    return { ok: false, error: "invalid_answers" };
  }

  const fieldKeys = new Set(fields.data.map((field) => field.key));
  const currentAnswers = Object.fromEntries(
    Object.entries(answers.data)
      .filter(([key]) => fieldKeys.has(key))
      .map(([key, value]) => [key, value.trim()]),
  );
  const visible = visibleCustomFields(fields.data, currentAnswers);
  const attachments = await resolveFileAnswers(
    database,
    input.ownerUserId,
    cfpId,
    input.clientDraftId,
    input.fileAnswers,
  );
  if (
    !attachments ||
    visible.some((field) =>
      field.type === "file"
        ? !validFileAnswer(
            field,
            attachments.find(({ fieldKey }) => fieldKey === field.key),
          )
        : !validAnswer(field, currentAnswers[field.key]),
    )
  ) {
    return { ok: false, error: "invalid_answers" };
  }
  const visibleKeys = new Set(visible.map((field) => field.key));

  return {
    ok: true,
    eventId: definition.eventId,
    eventName: definition.eventName,
    revision: definition.updatedAt,
    attachments: attachments.filter(({ fieldKey }) =>
      visibleKeys.has(fieldKey),
    ),
    answers: Object.fromEntries(
      visible.flatMap((field) => {
        if (field.type === "file") return [];
        const value = currentAnswers[field.key];
        return value ? [[field.key, value]] : [];
      }),
    ),
  };
}

export async function uploadProposalFile(
  database: Database,
  files: R2Bucket,
  ownerUserId: UserId,
  input: UploadProposalFileInput,
): Promise<
  | {
      ok: true;
      value: {
        id: StoredFileId;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        url: string;
      };
    }
  | { ok: false; error: ProposalWriteError }
> {
  const existing = await findProposalUpload(
    database,
    ownerUserId,
    input.uploadId,
  );
  if (existing) return { ok: true, value: existing };

  const [definition] = await database
    .select({
      deadline: cfps.deadline,
      customFieldsJson: cfps.customFieldsJson,
    })
    .from(cfps)
    .innerJoin(events, eq(events.id, cfps.eventId))
    .where(
      and(
        eq(cfps.id, input.cfpId),
        eq(events.slug, input.slug),
        eq(cfps.status, "open"),
      ),
    )
    .limit(1);
  if (!definition || new Date(definition.deadline) <= new Date()) {
    return { ok: false, error: "cfp_unavailable" };
  }
  const fields = customFieldsSchema.safeParse(
    JSON.parse(definition.customFieldsJson) as unknown,
  );
  const answers = proposalAnswersSchema.safeParse(input.customAnswers);
  if (!fields.success || !answers.success) {
    return { ok: false, error: "invalid_answers" };
  }
  const field = visibleCustomFields(fields.data, answers.data).find(
    (candidate) =>
      candidate.key === input.fieldKey && candidate.type === "file",
  );
  if (
    field?.type !== "file" ||
    !acceptedContentType(field.acceptedTypes, input.contentType)
  ) {
    return { ok: false, error: "invalid_file" };
  }

  const stored = await putStoredFile(
    files,
    ownerUserId,
    `proposal-files/${input.cfpId}`,
    input,
    (bytes, contentType) =>
      bytes.byteLength <= field.maxSizeMb * 1_000_000 &&
      acceptedContentType(field.acceptedTypes, contentType) &&
      matchesStoredFileContentType(bytes, contentType),
  );
  if (!stored.ok) return { ok: false, error: "invalid_file" };

  try {
    await database.batch([
      database.insert(storedFiles).values(stored.value.record),
      database.insert(submissionFileUploads).values({
        id: input.uploadId,
        cfpId: input.cfpId,
        clientDraftId: input.clientDraftId,
        fieldKey: input.fieldKey,
        ownerUserId,
        storedFileId: stored.value.record.id,
        createdAt: stored.value.record.createdAt,
      }),
    ]);
  } catch {
    await compensateStoredFile(
      files,
      stored.value.record.objectKey,
      "proposal_file_upload_compensation_failed",
    );
    const raced = await findProposalUpload(
      database,
      ownerUserId,
      input.uploadId,
    );
    return raced
      ? { ok: true, value: raced }
      : { ok: false, error: "persistence_failed" };
  }
  return {
    ok: true,
    value: storedFileValue(stored.value.record),
  };
}

export async function findAccessibleSubmissionFile(
  database: Database,
  viewerUserId: UserId,
  fileId: StoredFileId,
) {
  const [file] = await database
    .select({
      objectKey: storedFiles.objectKey,
      fileName: storedFiles.fileName,
      contentType: storedFiles.contentType,
    })
    .from(storedFiles)
    .innerJoin(
      formResponseAttachments,
      eq(formResponseAttachments.storedFileId, storedFiles.id),
    )
    .innerJoin(
      formResponses,
      eq(formResponses.id, formResponseAttachments.formResponseId),
    )
    .innerJoin(submissions, eq(submissions.id, formResponses.submissionId))
    .innerJoin(events, eq(events.id, submissions.eventId))
    .where(
      and(
        eq(storedFiles.id, fileId),
        or(
          accessibleSubmissionWhere(database, viewerUserId),
          exists(
            database
              .select({ id: reviewerAssignments.id })
              .from(reviewerAssignments)
              .where(
                and(
                  eq(reviewerAssignments.submissionId, submissions.id),
                  eq(reviewerAssignments.reviewerUserId, viewerUserId),
                  isNull(reviewerAssignments.revokedAt),
                ),
              ),
          ),
        ),
      ),
    )
    .limit(1);
  return file;
}

async function resolveFileAnswers(
  database: Database,
  ownerUserId: UserId,
  cfpId: string,
  clientDraftId: string,
  answers: Record<string, StoredFileId>,
) {
  const entries = Object.entries(answers);
  if (entries.length === 0) return [];
  const ids = entries.map(([, id]) => id);
  const uploads = await database
    .select({
      uploadId: submissionFileUploads.id,
      fieldKey: submissionFileUploads.fieldKey,
      storedFileId: submissionFileUploads.storedFileId,
      contentType: storedFiles.contentType,
      sizeBytes: storedFiles.sizeBytes,
    })
    .from(submissionFileUploads)
    .innerJoin(
      storedFiles,
      eq(storedFiles.id, submissionFileUploads.storedFileId),
    )
    .where(
      and(
        eq(submissionFileUploads.ownerUserId, ownerUserId),
        eq(submissionFileUploads.cfpId, cfpId),
        eq(submissionFileUploads.clientDraftId, clientDraftId),
        inArray(submissionFileUploads.storedFileId, ids),
      ),
    );
  const attached = await database
    .select({
      uploadId: sql<null>`NULL`,
      fieldKey: formResponseAttachments.fieldKey,
      storedFileId: formResponseAttachments.storedFileId,
      contentType: storedFiles.contentType,
      sizeBytes: storedFiles.sizeBytes,
    })
    .from(formResponseAttachments)
    .innerJoin(
      formResponses,
      eq(formResponses.id, formResponseAttachments.formResponseId),
    )
    .innerJoin(submissions, eq(submissions.id, formResponses.submissionId))
    .innerJoin(
      storedFiles,
      eq(storedFiles.id, formResponseAttachments.storedFileId),
    )
    .where(
      and(
        eq(submissions.id, clientDraftId),
        eq(submissions.ownerUserId, ownerUserId),
        eq(submissions.cfpId, cfpId),
        inArray(formResponseAttachments.storedFileId, ids),
      ),
    );
  const resolved = entries.flatMap(([fieldKey, storedFileId]) => {
    const match = [...uploads, ...attached].find(
      (candidate) =>
        candidate.fieldKey === fieldKey &&
        candidate.storedFileId === storedFileId,
    );
    return match ? [match] : [];
  });
  return resolved.length === entries.length ? resolved : undefined;
}

function validFileAnswer(
  field: Extract<CustomField, { type: "file" }>,
  file: { contentType: string; sizeBytes: number } | undefined,
) {
  if (!file) return !field.required;
  return (
    file.sizeBytes <= field.maxSizeMb * 1_000_000 &&
    acceptedContentType(field.acceptedTypes, file.contentType)
  );
}

async function listFormResponseFiles(database: Database, submissionId: string) {
  const rows = await database
    .select({
      fieldKey: formResponseAttachments.fieldKey,
      id: storedFiles.id,
      fileName: storedFiles.fileName,
      contentType: storedFiles.contentType,
      sizeBytes: storedFiles.sizeBytes,
    })
    .from(formResponseAttachments)
    .innerJoin(
      formResponses,
      eq(formResponses.id, formResponseAttachments.formResponseId),
    )
    .innerJoin(
      storedFiles,
      eq(storedFiles.id, formResponseAttachments.storedFileId),
    )
    .where(eq(formResponses.submissionId, submissionId));
  return Object.fromEntries(
    rows.map((row) => [row.fieldKey, storedFileValue(row)]),
  );
}

async function findProposalUpload(
  database: Database,
  ownerUserId: UserId,
  uploadId: string,
) {
  const [row] = await database
    .select({
      id: storedFiles.id,
      fileName: storedFiles.fileName,
      contentType: storedFiles.contentType,
      sizeBytes: storedFiles.sizeBytes,
    })
    .from(submissionFileUploads)
    .innerJoin(
      storedFiles,
      eq(storedFiles.id, submissionFileUploads.storedFileId),
    )
    .where(
      and(
        eq(submissionFileUploads.id, uploadId),
        eq(submissionFileUploads.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  return row ? storedFileValue(row) : undefined;
}

type ProposalFileCleanupCandidate = {
  id: string;
  objectKey: string;
};

async function listPendingProposalFiles(
  database: Database,
  ownerUserId: UserId,
  cfpId: string,
  clientDraftId: string,
): Promise<ProposalFileCleanupCandidate[]> {
  return database
    .select({ id: storedFiles.id, objectKey: storedFiles.objectKey })
    .from(submissionFileUploads)
    .innerJoin(
      storedFiles,
      eq(storedFiles.id, submissionFileUploads.storedFileId),
    )
    .where(
      and(
        eq(submissionFileUploads.ownerUserId, ownerUserId),
        eq(submissionFileUploads.cfpId, cfpId),
        eq(submissionFileUploads.clientDraftId, clientDraftId),
      ),
    );
}

async function listProposalWriteFiles(
  database: Database,
  ownerUserId: UserId,
  formResponseId: string,
  cfpId: string,
  clientDraftId: string,
): Promise<ProposalFileCleanupCandidate[]> {
  const [attached, pending] = await Promise.all([
    database
      .select({ id: storedFiles.id, objectKey: storedFiles.objectKey })
      .from(formResponseAttachments)
      .innerJoin(
        storedFiles,
        eq(storedFiles.id, formResponseAttachments.storedFileId),
      )
      .where(eq(formResponseAttachments.formResponseId, formResponseId)),
    listPendingProposalFiles(database, ownerUserId, cfpId, clientDraftId),
  ]);
  return [...attached, ...pending];
}

async function removeUnusedProposalFiles(
  database: Database,
  files: R2Bucket,
  candidates: ProposalFileCleanupCandidate[],
  retainedIds: Set<string>,
): Promise<void> {
  for (const file of candidates) {
    if (retainedIds.has(file.id)) continue;
    try {
      await files.delete(file.objectKey);
      await database.delete(storedFiles).where(eq(storedFiles.id, file.id));
    } catch (error: unknown) {
      reportOperationalFailure(
        "proposal_file_cleanup_failed",
        {
          "file.id": file.id,
        },
        error,
      );
    }
  }
}

function storedFileValue(file: {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}) {
  return {
    ...file,
    id: file.id as StoredFileId,
    url: `/api/submission-files/${file.id}`,
  };
}

function acceptedContentType(acceptedTypes: string[], contentType: string) {
  const normalized = contentType.toLowerCase();
  return acceptedTypes.some(
    (accepted) =>
      accepted === normalized ||
      (accepted.endsWith("/*") && normalized.startsWith(accepted.slice(0, -1))),
  );
}

function isPublished(status: typeof decisions.$inferSelect.status): boolean {
  return status === "accepted" || status === "declined";
}

function publicDecisionStatus(
  status: typeof decisions.$inferSelect.status,
): "pending" | "accepted" | "declined" {
  return status === "accepted" || status === "declined" ? status : "pending";
}

function validAnswer(field: CustomField, value: string | undefined): boolean {
  const answer = value?.trim() ?? "";
  if (!answer) return !field.required;
  return field.type !== "single_select" || field.options.includes(answer);
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
