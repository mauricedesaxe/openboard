import { and, eq, exists, gt, isNull, max, or, sql } from "drizzle-orm";

import type { InvitationId } from "../../shared/event-team";
import type { UserId } from "../../shared/events";
import type { SubmissionSpeakerId } from "../../shared/submissions";
import type { Database } from "../database/client";
import {
  cfps,
  decisions,
  eventRoles,
  events,
  submissionSpeakerInvitations,
  submissionSpeakers,
  submissions,
} from "../database/schema";
import {
  createInvitationSecret,
  hashInvitationSecret,
} from "../invitations/secrets";

const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export type SubmissionSpeakerInvitationDelivery = {
  id: InvitationId;
  email: string;
  eventName: string;
  speakerName: string;
  submissionTitle: string;
  secret: string;
  expiresAt: Date;
};

export async function prepareSubmissionSpeakerInvitation(
  input: {
    submissionSpeakerId: SubmissionSpeakerId;
    email: string;
    eventName: string;
    speakerName: string;
    submissionTitle: string;
    invitedByUserId: UserId;
  },
  now: Date,
): Promise<{
  values: typeof submissionSpeakerInvitations.$inferInsert;
  delivery: SubmissionSpeakerInvitationDelivery;
}> {
  const id = crypto.randomUUID() as InvitationId;
  const secret = createInvitationSecret();
  const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
  return {
    values: {
      id,
      submissionSpeakerId: input.submissionSpeakerId,
      email: input.email,
      secretHash: await hashInvitationSecret(secret),
      status: "pending",
      invitedByUserId: input.invitedByUserId,
      expiresAt,
      createdAt: now,
    },
    delivery: { id, ...input, secret, expiresAt },
  };
}

type SpeakerWriteError =
  | "duplicate_speaker"
  | "invitation_not_replaceable"
  | "last_speaker"
  | "not_found"
  | "persistence_failed"
  | "submission_closed";

type SpeakerWriteResult<T> =
  { ok: true; value: T } | { ok: false; error: SpeakerWriteError };

export async function addSubmissionSpeaker(
  database: Database,
  actorUserId: UserId,
  input: {
    submissionId: string;
    name: string;
    email: string;
  },
): Promise<
  SpeakerWriteResult<{
    speakerId: SubmissionSpeakerId;
    invitationId: InvitationId;
    delivery: SubmissionSpeakerInvitationDelivery;
  }>
> {
  const editable = await findEditableSubmission(
    database,
    actorUserId,
    input.submissionId,
  );
  if (!editable) return { ok: false, error: "not_found" };
  if (!editable.editable) return { ok: false, error: "submission_closed" };
  const [duplicate] = await database
    .select({ id: submissionSpeakers.id })
    .from(submissionSpeakers)
    .where(
      and(
        eq(submissionSpeakers.submissionId, input.submissionId),
        eq(submissionSpeakers.invitedEmail, input.email),
        isNull(submissionSpeakers.removedAt),
      ),
    )
    .limit(1);
  if (duplicate) return { ok: false, error: "duplicate_speaker" };

  const [lastPosition] = await database
    .select({ position: max(submissionSpeakers.position) })
    .from(submissionSpeakers)
    .where(eq(submissionSpeakers.submissionId, input.submissionId));
  const now = new Date();
  const speakerId = crypto.randomUUID() as SubmissionSpeakerId;
  const attempt = await prepareSubmissionSpeakerInvitation(
    {
      submissionSpeakerId: speakerId,
      email: input.email,
      eventName: editable.eventName,
      speakerName: input.name,
      submissionTitle: editable.submissionTitle,
      invitedByUserId: actorUserId,
    },
    now,
  );

  try {
    await database.batch([
      database
        .update(submissions)
        .set({ updatedAt: now })
        .where(eq(submissions.id, input.submissionId)),
      database.insert(submissionSpeakers).values({
        id: speakerId,
        submissionId: input.submissionId,
        invitedName: input.name,
        invitedEmail: input.email,
        position: (lastPosition?.position ?? -1) + 1,
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(submissionSpeakerInvitations).values(attempt.values),
    ]);
  } catch {
    return { ok: false, error: "persistence_failed" };
  }

  return {
    ok: true,
    value: {
      speakerId,
      invitationId: attempt.delivery.id,
      delivery: attempt.delivery,
    },
  };
}

export async function replaceSubmissionSpeakerInvitation(
  database: Database,
  actorUserId: UserId,
  input: {
    submissionId: string;
    speakerId: SubmissionSpeakerId;
    replacesInvitationId: InvitationId;
  },
): Promise<
  SpeakerWriteResult<{
    invitationId: InvitationId;
    delivery: SubmissionSpeakerInvitationDelivery;
  }>
> {
  const editable = await findEditableSubmission(
    database,
    actorUserId,
    input.submissionId,
  );
  if (!editable) return { ok: false, error: "not_found" };
  if (!editable.editable) return { ok: false, error: "submission_closed" };
  const [speaker] = await database
    .select({
      id: submissionSpeakers.id,
      email: submissionSpeakers.invitedEmail,
      name: submissionSpeakers.invitedName,
    })
    .from(submissionSpeakers)
    .where(
      and(
        eq(submissionSpeakers.id, input.speakerId),
        eq(submissionSpeakers.submissionId, input.submissionId),
        isNull(submissionSpeakers.removedAt),
        isNull(submissionSpeakers.claimedUserId),
      ),
    )
    .limit(1);
  const [replaced] = await database
    .select({ id: submissionSpeakerInvitations.id })
    .from(submissionSpeakerInvitations)
    .where(
      and(
        eq(submissionSpeakerInvitations.id, input.replacesInvitationId),
        eq(submissionSpeakerInvitations.submissionSpeakerId, input.speakerId),
        eq(submissionSpeakerInvitations.status, "pending"),
      ),
    )
    .limit(1);
  if (!speaker || !replaced) {
    return { ok: false, error: "invitation_not_replaceable" };
  }

  const now = new Date();
  const attempt = await prepareSubmissionSpeakerInvitation(
    {
      submissionSpeakerId: speaker.id as SubmissionSpeakerId,
      email: speaker.email,
      eventName: editable.eventName,
      speakerName: speaker.name,
      submissionTitle: editable.submissionTitle,
      invitedByUserId: actorUserId,
    },
    now,
  );
  const revokeReplaced = database
    .update(submissionSpeakerInvitations)
    .set({ status: "revoked", resolvedAt: now })
    .where(
      and(
        eq(submissionSpeakerInvitations.id, input.replacesInvitationId),
        eq(submissionSpeakerInvitations.status, "pending"),
      ),
    );
  const insertReplacement = database
    .insert(submissionSpeakerInvitations)
    .select(
      database
        .select({
          id: sql<string>`${attempt.delivery.id}`.as("id"),
          submissionSpeakerId: submissionSpeakerInvitations.submissionSpeakerId,
          email: sql<string>`${speaker.email}`.as("email"),
          secretHash: sql<string>`${attempt.values.secretHash}`.as(
            "secret_hash",
          ),
          status: sql<"pending">`'pending'`.as("status"),
          invitedByUserId: sql<string>`${actorUserId}`.as("invited_by_user_id"),
          replacementForInvitationId: submissionSpeakerInvitations.id,
          acceptedByUserId: sql<null>`NULL`.as("accepted_by_user_id"),
          expiresAt: sql<number>`${attempt.delivery.expiresAt.getTime()}`.as(
            "expires_at",
          ),
          resolvedAt: sql<null>`NULL`.as("resolved_at"),
          createdAt: sql<number>`${now.getTime()}`.as("created_at"),
        })
        .from(submissionSpeakerInvitations)
        .where(
          and(
            eq(submissionSpeakerInvitations.id, input.replacesInvitationId),
            eq(submissionSpeakerInvitations.status, "revoked"),
            eq(submissionSpeakerInvitations.resolvedAt, now),
          ),
        ),
    );
  try {
    const [revoked, inserted] = await database.batch([
      revokeReplaced,
      insertReplacement,
    ]);
    if (revoked.meta.changes !== 1 || inserted.meta.changes !== 1) {
      return { ok: false, error: "invitation_not_replaceable" };
    }
  } catch {
    return { ok: false, error: "invitation_not_replaceable" };
  }
  return {
    ok: true,
    value: { invitationId: attempt.delivery.id, delivery: attempt.delivery },
  };
}

export async function resendSubmissionSpeakerInvitation(
  database: Database,
  actorUserId: UserId,
  input: { submissionId: string; speakerId: SubmissionSpeakerId },
): Promise<
  SpeakerWriteResult<{
    invitationId: InvitationId;
    delivery: SubmissionSpeakerInvitationDelivery;
  }>
> {
  const editable = await findEditableSubmission(
    database,
    actorUserId,
    input.submissionId,
  );
  if (!editable) return { ok: false, error: "not_found" };
  if (!editable.editable) return { ok: false, error: "submission_closed" };
  const [speaker] = await database
    .select({
      id: submissionSpeakers.id,
      email: submissionSpeakers.invitedEmail,
      name: submissionSpeakers.invitedName,
    })
    .from(submissionSpeakers)
    .where(
      and(
        eq(submissionSpeakers.id, input.speakerId),
        eq(submissionSpeakers.submissionId, input.submissionId),
        isNull(submissionSpeakers.removedAt),
        isNull(submissionSpeakers.claimedUserId),
      ),
    )
    .limit(1);
  if (!speaker) return { ok: false, error: "not_found" };
  const [pending] = await database
    .select({ id: submissionSpeakerInvitations.id })
    .from(submissionSpeakerInvitations)
    .where(
      and(
        eq(submissionSpeakerInvitations.submissionSpeakerId, speaker.id),
        eq(submissionSpeakerInvitations.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) return { ok: false, error: "invitation_not_replaceable" };

  const now = new Date();
  const attempt = await prepareSubmissionSpeakerInvitation(
    {
      submissionSpeakerId: speaker.id as SubmissionSpeakerId,
      email: speaker.email,
      eventName: editable.eventName,
      speakerName: speaker.name,
      submissionTitle: editable.submissionTitle,
      invitedByUserId: actorUserId,
    },
    now,
  );
  try {
    await database.insert(submissionSpeakerInvitations).values(attempt.values);
  } catch {
    return { ok: false, error: "invitation_not_replaceable" };
  }
  return {
    ok: true,
    value: { invitationId: attempt.delivery.id, delivery: attempt.delivery },
  };
}

export async function removeSubmissionSpeaker(
  database: Database,
  actorUserId: UserId,
  input: { submissionId: string; speakerId: SubmissionSpeakerId },
): Promise<SpeakerWriteResult<{ removed: true }>> {
  const editable = await findEditableSubmission(
    database,
    actorUserId,
    input.submissionId,
  );
  if (!editable) return { ok: false, error: "not_found" };
  if (!editable.editable) return { ok: false, error: "submission_closed" };

  const now = new Date();
  try {
    const [, removed] = await database.batch([
      database
        .update(submissions)
        .set({ updatedAt: now })
        .where(eq(submissions.id, input.submissionId)),
      database
        .update(submissionSpeakers)
        .set({ removedAt: now, updatedAt: now })
        .where(
          and(
            eq(submissionSpeakers.id, input.speakerId),
            eq(submissionSpeakers.submissionId, input.submissionId),
            isNull(submissionSpeakers.removedAt),
          ),
        ),
      database
        .update(submissionSpeakerInvitations)
        .set({ status: "revoked", resolvedAt: now })
        .where(
          and(
            eq(
              submissionSpeakerInvitations.submissionSpeakerId,
              input.speakerId,
            ),
            eq(submissionSpeakerInvitations.status, "pending"),
            exists(
              database
                .select({ id: submissionSpeakers.id })
                .from(submissionSpeakers)
                .where(
                  and(
                    eq(
                      submissionSpeakers.id,
                      submissionSpeakerInvitations.submissionSpeakerId,
                    ),
                    eq(submissionSpeakers.submissionId, input.submissionId),
                    eq(submissionSpeakers.removedAt, now),
                  ),
                ),
            ),
          ),
        ),
    ]);
    return removed.meta.changes === 1
      ? { ok: true, value: { removed: true } }
      : { ok: false, error: "not_found" };
  } catch (error: unknown) {
    return String(error).includes("last_submission_speaker")
      ? { ok: false, error: "last_speaker" }
      : { ok: false, error: "persistence_failed" };
  }
}

async function findEditableSubmission(
  database: Database,
  actorUserId: UserId,
  submissionId: string,
) {
  const [submission] = await database
    .select({
      eventName: events.name,
      submissionTitle: submissions.title,
      status: submissions.status,
      decisionStatus: decisions.status,
      cfpStatus: cfps.status,
      deadline: cfps.deadline,
    })
    .from(submissions)
    .innerJoin(events, eq(events.id, submissions.eventId))
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .innerJoin(cfps, eq(cfps.id, submissions.cfpId))
    .where(
      and(
        eq(submissions.id, submissionId),
        or(
          eq(submissions.ownerUserId, actorUserId),
          eq(events.ownerUserId, actorUserId),
          exists(
            database
              .select({ id: eventRoles.id })
              .from(eventRoles)
              .where(
                and(
                  eq(eventRoles.eventId, submissions.eventId),
                  eq(eventRoles.userId, actorUserId),
                  eq(eventRoles.role, "organizer"),
                  isNull(eventRoles.revokedAt),
                ),
              ),
          ),
        ),
      ),
    )
    .limit(1);
  if (!submission) return undefined;
  return {
    ...submission,
    editable:
      submission.status === "active" &&
      !["accepted", "declined"].includes(submission.decisionStatus) &&
      submission.cfpStatus === "open" &&
      new Date(submission.deadline) > new Date(),
  };
}

type InvitationLookupValue = {
  id: InvitationId;
  submissionSpeakerId: SubmissionSpeakerId;
  submissionId: string;
  email: string;
  eventName: string;
  speakerName: string;
  submissionTitle: string;
  expiresAt: Date;
};

type InvitationLookupResult =
  | { ok: true; value: InvitationLookupValue }
  | { ok: false; error: "not_found" | "unavailable" };

export async function findUsableSubmissionSpeakerInvitation(
  database: Database,
  secret: string,
): Promise<InvitationLookupResult> {
  const secretHash = await hashInvitationSecret(secret);
  const [invitation] = await database
    .select({
      id: submissionSpeakerInvitations.id,
      submissionSpeakerId: submissionSpeakers.id,
      submissionId: submissions.id,
      email: submissionSpeakerInvitations.email,
      eventName: events.name,
      speakerName: submissionSpeakers.invitedName,
      submissionTitle: submissions.title,
      status: submissionSpeakerInvitations.status,
      expiresAt: submissionSpeakerInvitations.expiresAt,
      removedAt: submissionSpeakers.removedAt,
    })
    .from(submissionSpeakerInvitations)
    .innerJoin(
      submissionSpeakers,
      eq(
        submissionSpeakers.id,
        submissionSpeakerInvitations.submissionSpeakerId,
      ),
    )
    .innerJoin(submissions, eq(submissions.id, submissionSpeakers.submissionId))
    .innerJoin(events, eq(events.id, submissions.eventId))
    .where(eq(submissionSpeakerInvitations.secretHash, secretHash))
    .limit(1);
  if (!invitation) return { ok: false, error: "not_found" };
  if (
    invitation.status !== "pending" ||
    invitation.expiresAt.getTime() <= Date.now() ||
    invitation.removedAt !== null
  ) {
    return { ok: false, error: "unavailable" };
  }
  return {
    ok: true,
    value: {
      ...invitation,
      id: invitation.id as InvitationId,
      submissionSpeakerId:
        invitation.submissionSpeakerId as SubmissionSpeakerId,
    },
  };
}

export async function declineSubmissionSpeakerInvitation(
  database: Database,
  secret: string,
): Promise<InvitationLookupResult> {
  const invitation = await findUsableSubmissionSpeakerInvitation(
    database,
    secret,
  );
  if (!invitation.ok) return invitation;
  const result = await database
    .update(submissionSpeakerInvitations)
    .set({ status: "declined", resolvedAt: new Date() })
    .where(
      and(
        eq(submissionSpeakerInvitations.id, invitation.value.id),
        eq(submissionSpeakerInvitations.status, "pending"),
        gt(submissionSpeakerInvitations.expiresAt, new Date()),
      ),
    );
  return result.meta.changes === 1
    ? invitation
    : { ok: false, error: "unavailable" };
}

type AcceptInvitationResult =
  | { ok: true; value: { submissionId: string } }
  | {
      ok: false;
      error:
        "not_found" | "unavailable" | "email_mismatch" | "unverified_email";
    };

export async function acceptSubmissionSpeakerInvitation(
  database: Database,
  recipient: { id: UserId; email: string; emailVerified: boolean },
  secret: string,
): Promise<AcceptInvitationResult> {
  if (!recipient.emailVerified) return { ok: false, error: "unverified_email" };
  const invitation = await findUsableSubmissionSpeakerInvitation(
    database,
    secret,
  );
  if (!invitation.ok) return invitation;
  if (invitation.value.email !== recipient.email.trim().toLowerCase()) {
    return { ok: false, error: "email_mismatch" };
  }

  const now = new Date();
  const claim = database
    .update(submissionSpeakers)
    .set({ claimedUserId: recipient.id, updatedAt: now })
    .where(
      and(
        eq(submissionSpeakers.id, invitation.value.submissionSpeakerId),
        isNull(submissionSpeakers.claimedUserId),
        isNull(submissionSpeakers.removedAt),
      ),
    );
  const accept = database
    .update(submissionSpeakerInvitations)
    .set({
      status: "accepted",
      acceptedByUserId: recipient.id,
      resolvedAt: now,
    })
    .where(
      and(
        eq(submissionSpeakerInvitations.id, invitation.value.id),
        eq(submissionSpeakerInvitations.status, "pending"),
        gt(submissionSpeakerInvitations.expiresAt, now),
        exists(
          database
            .select({ id: submissionSpeakers.id })
            .from(submissionSpeakers)
            .where(
              and(
                eq(
                  submissionSpeakers.id,
                  submissionSpeakerInvitations.submissionSpeakerId,
                ),
                eq(submissionSpeakers.claimedUserId, recipient.id),
                isNull(submissionSpeakers.removedAt),
              ),
            ),
        ),
      ),
    );

  try {
    const [, accepted] = await database.batch([claim, accept]);
    if (accepted.meta.changes !== 1) {
      return { ok: false, error: "unavailable" };
    }
  } catch {
    return { ok: false, error: "unavailable" };
  }

  return {
    ok: true,
    value: { submissionId: invitation.value.submissionId },
  };
}
