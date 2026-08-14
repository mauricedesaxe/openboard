import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";

import type { UserId } from "../../shared/events";
import type {
  DecisionPublicationInput,
  ReviewerAssignmentId,
} from "../../shared/reviews";
import type { SubmissionId } from "../../shared/submissions";
import {
  communicationInsertStatements,
  prepareCommunication,
  type CommunicationRecipient,
} from "../communications/repository";
import type { Database } from "../database/client";
import {
  cfps,
  communications,
  decisionPublicationItems,
  decisionPublications,
  decisions,
  eventRoles,
  events,
  formResponseAttachments,
  formResponses,
  programItems,
  reviewAuditEvents,
  reviewerAssignments,
  reviewRounds,
  reviews,
  submissions,
  submissionSpeakerInvitations,
  submissionSpeakers,
  tracks,
  storedFiles,
  user,
} from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

export type ReviewWriteError =
  | "invalid_assignment"
  | "not_found"
  | "persistence_failed"
  | "published_outcome_exists"
  | "round_incomplete"
  | "round_not_closed"
  | "round_not_open"
  | "stale_queue"
  | "submission_closed";

type ReviewWriteResult<T> =
  { ok: true; value: T } | { ok: false; error: ReviewWriteError };

export async function getOrganizerReviewBoard(
  database: Database,
  userId: UserId,
  slug: string,
) {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return undefined;
  const round = await findOpenOrLatestReviewRound(database, event.id);
  if (!round) return undefined;

  const activeReviewers = await database
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
    })
    .from(eventRoles)
    .innerJoin(user, eq(user.id, eventRoles.userId))
    .where(
      and(
        eq(eventRoles.eventId, event.id),
        eq(eventRoles.role, "reviewer"),
        isNull(eventRoles.revokedAt),
      ),
    )
    .orderBy(asc(user.email));
  const submissionRows = await database
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      status: submissions.status,
      track: tracks.name,
      decisionStatus: decisions.status,
      decisionRevision: decisions.revision,
      published: sql<number>`EXISTS (
        SELECT 1
        FROM ${decisionPublications}
        WHERE ${decisionPublications.reviewRoundId} = ${round.id}
      )`,
    })
    .from(submissions)
    .innerJoin(tracks, eq(tracks.id, submissions.trackId))
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .where(eq(submissions.cfpId, round.cfpId))
    .orderBy(asc(submissions.createdAt), asc(submissions.id));
  const assignmentRows = await database
    .select({
      id: reviewerAssignments.id,
      submissionId: reviewerAssignments.submissionId,
      reviewerUserId: reviewerAssignments.reviewerUserId,
      reviewerName: user.name,
      reviewerEmail: user.email,
      score: reviews.score,
      comment: reviews.comment,
    })
    .from(reviewerAssignments)
    .innerJoin(user, eq(user.id, reviewerAssignments.reviewerUserId))
    .leftJoin(reviews, eq(reviews.assignmentId, reviewerAssignments.id))
    .where(
      and(
        eq(reviewerAssignments.reviewRoundId, round.id),
        isNull(reviewerAssignments.revokedAt),
      ),
    )
    .orderBy(asc(user.name));
  const fileRows = await listSubmissionFiles(
    database,
    submissionRows.map(({ id }) => id),
  );

  return {
    round: {
      id: round.id,
      name: round.name,
      state: submissionRows.some(({ published }) => published)
        ? ("published-lock" as const)
        : round.status,
    },
    reviewers: activeReviewers.map((reviewer) => {
      const assignments = assignmentRows.filter(
        (assignment) => assignment.reviewerUserId === reviewer.id,
      );
      return {
        ...reviewer,
        assigned: assignments.length,
        completed: assignments.filter((assignment) => assignment.score !== null)
          .length,
      };
    }),
    submissions: submissionRows.map((submission) => {
      const assignments = assignmentRows.filter(
        (assignment) => assignment.submissionId === submission.id,
      );
      const scores = assignments.flatMap((assignment) =>
        assignment.score === null ? [] : [assignment.score],
      );
      return {
        id: submission.id,
        title: submission.title,
        abstract: submission.abstract,
        format: submission.format,
        track: submission.track,
        status: submission.status,
        fileAnswers: fileRows.filter(
          (file) => file.submissionId === submission.id,
        ),
        decision: {
          status: submission.decisionStatus,
          revision: submission.decisionRevision,
        },
        review: {
          assigned: assignments.length,
          completed: scores.length,
          average:
            scores.length === 0
              ? null
              : scores.reduce((sum, score) => sum + score, 0) / scores.length,
          assignments: assignments.map((assignment) => ({
            id: assignment.id,
            reviewerUserId: assignment.reviewerUserId,
            reviewerName: assignment.reviewerName,
            reviewerEmail: assignment.reviewerEmail,
            score: assignment.score,
            comment: assignment.comment,
          })),
        },
      };
    }),
  };
}

export async function listOwnReviewAssignments(
  database: Database,
  userId: UserId,
  slug: string,
  reviewRoundId?: string,
) {
  const rows = await database
    .select({
      assignmentId: reviewerAssignments.id,
      roundStatus: reviewRounds.status,
      submissionId: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      track: tracks.name,
      score: reviews.score,
      comment: reviews.comment,
      published: sql<number>`EXISTS (
        SELECT 1
        FROM ${decisionPublications}
        WHERE ${decisionPublications.reviewRoundId} = ${reviewerAssignments.reviewRoundId}
      )`,
    })
    .from(reviewerAssignments)
    .innerJoin(
      reviewRounds,
      eq(reviewRounds.id, reviewerAssignments.reviewRoundId),
    )
    .innerJoin(events, eq(events.id, reviewerAssignments.eventId))
    .innerJoin(
      submissions,
      eq(submissions.id, reviewerAssignments.submissionId),
    )
    .innerJoin(tracks, eq(tracks.id, submissions.trackId))
    .innerJoin(
      eventRoles,
      and(
        eq(eventRoles.eventId, reviewerAssignments.eventId),
        eq(eventRoles.userId, userId),
        eq(eventRoles.role, "reviewer"),
        isNull(eventRoles.revokedAt),
      ),
    )
    .leftJoin(reviews, eq(reviews.assignmentId, reviewerAssignments.id))
    .where(
      and(
        eq(events.slug, slug),
        eq(reviewerAssignments.reviewerUserId, userId),
        reviewRoundId
          ? eq(reviewerAssignments.reviewRoundId, reviewRoundId)
          : undefined,
        isNull(reviewerAssignments.revokedAt),
        eq(submissions.status, "active"),
      ),
    )
    .orderBy(asc(submissions.title));
  const files = await listSubmissionFiles(
    database,
    rows.map(({ submissionId }) => submissionId),
  );
  return rows.map((row) => ({
    assignmentId: row.assignmentId,
    roundState: row.published ? ("published-lock" as const) : row.roundStatus,
    submission: {
      id: row.submissionId,
      title: row.title,
      abstract: row.abstract,
      format: row.format,
      track: row.track,
      fileAnswers: files.filter(
        (file) => file.submissionId === row.submissionId,
      ),
    },
    review:
      row.score === null
        ? null
        : { score: row.score, comment: row.comment ?? null },
  }));
}

async function listSubmissionFiles(
  database: Database,
  submissionIds: string[],
) {
  if (submissionIds.length === 0) return [];
  return database
    .select({
      submissionId: formResponses.submissionId,
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
    .where(inArray(formResponses.submissionId, submissionIds))
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        url: `/api/submission-files/${row.id}`,
      })),
    );
}

export async function assignReviewer(
  database: Database,
  actorUserId: UserId,
  slug: string,
  submissionId: SubmissionId,
  reviewerUserId: UserId,
): Promise<ReviewWriteResult<{ id: ReviewerAssignmentId }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const [target] = await database
    .select({ roundId: reviewRounds.id })
    .from(submissions)
    .innerJoin(reviewRounds, eq(reviewRounds.cfpId, submissions.cfpId))
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.eventId, event.id),
        eq(submissions.status, "active"),
        inArray(reviewRounds.status, ["draft", "open"]),
      ),
    )
    .limit(1);
  if (!target) return { ok: false, error: "invalid_assignment" };
  const [reviewerRole] = await database
    .select({ id: eventRoles.id })
    .from(eventRoles)
    .where(
      and(
        eq(eventRoles.eventId, event.id),
        eq(eventRoles.userId, reviewerUserId),
        eq(eventRoles.role, "reviewer"),
        isNull(eventRoles.revokedAt),
      ),
    )
    .limit(1);
  if (!reviewerRole) return { ok: false, error: "invalid_assignment" };
  const [existing] = await database
    .select({ id: reviewerAssignments.id })
    .from(reviewerAssignments)
    .where(
      and(
        eq(reviewerAssignments.reviewRoundId, target.roundId),
        eq(reviewerAssignments.submissionId, submissionId),
        eq(reviewerAssignments.reviewerUserId, reviewerUserId),
        isNull(reviewerAssignments.revokedAt),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      ok: true,
      value: { id: existing.id as ReviewerAssignmentId },
    };
  }

  const id = crypto.randomUUID() as ReviewerAssignmentId;
  try {
    await database.insert(reviewerAssignments).values({
      id,
      eventId: event.id,
      reviewRoundId: target.roundId,
      submissionId,
      reviewerUserId,
      assignedByUserId: actorUserId,
      createdAt: new Date(),
    });
  } catch (error: unknown) {
    if (String(error).includes("invalid_reviewer_assignment")) {
      return { ok: false, error: "invalid_assignment" };
    }
    if (String(error).includes("UNIQUE constraint failed")) {
      const [raced] = await database
        .select({ id: reviewerAssignments.id })
        .from(reviewerAssignments)
        .where(
          and(
            eq(reviewerAssignments.reviewRoundId, target.roundId),
            eq(reviewerAssignments.submissionId, submissionId),
            eq(reviewerAssignments.reviewerUserId, reviewerUserId),
            isNull(reviewerAssignments.revokedAt),
          ),
        )
        .limit(1);
      return raced
        ? {
            ok: true,
            value: { id: raced.id as ReviewerAssignmentId },
          }
        : { ok: false, error: "persistence_failed" };
    }
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { id } };
}

export async function revokeReviewerAssignment(
  database: Database,
  actorUserId: UserId,
  slug: string,
  assignmentId: ReviewerAssignmentId,
): Promise<ReviewWriteResult<{ revoked: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const [assignment] = await database
    .select({ roundStatus: reviewRounds.status })
    .from(reviewerAssignments)
    .innerJoin(
      reviewRounds,
      eq(reviewRounds.id, reviewerAssignments.reviewRoundId),
    )
    .where(
      and(
        eq(reviewerAssignments.id, assignmentId),
        eq(reviewerAssignments.eventId, event.id),
        isNull(reviewerAssignments.revokedAt),
      ),
    )
    .limit(1);
  if (!assignment) return { ok: false, error: "not_found" };
  if (assignment.roundStatus === "closed") {
    return { ok: false, error: "round_not_open" };
  }
  const result = await database
    .update(reviewerAssignments)
    .set({ revokedAt: new Date(), revokedByUserId: actorUserId })
    .where(
      and(
        eq(reviewerAssignments.id, assignmentId),
        eq(reviewerAssignments.eventId, event.id),
        isNull(reviewerAssignments.revokedAt),
        inArray(
          reviewerAssignments.reviewRoundId,
          database
            .select({ id: reviewRounds.id })
            .from(reviewRounds)
            .where(inArray(reviewRounds.status, ["draft", "open"])),
        ),
      ),
    );
  if (result.meta.changes > 0) {
    return { ok: true, value: { revoked: true } };
  }
  const [latestRound] = await database
    .select({ status: reviewRounds.status })
    .from(reviewRounds)
    .innerJoin(
      reviewerAssignments,
      eq(reviewerAssignments.reviewRoundId, reviewRounds.id),
    )
    .where(eq(reviewerAssignments.id, assignmentId))
    .limit(1);
  return {
    ok: false,
    error: latestRound?.status === "closed" ? "round_not_open" : "not_found",
  };
}

export async function saveReview(
  database: Database,
  reviewerUserId: UserId,
  input: {
    assignmentId: ReviewerAssignmentId;
    score: number;
    comment: string | null;
  },
): Promise<ReviewWriteResult<{ saved: true }>> {
  const [assignment] = await database
    .select({
      id: reviewerAssignments.id,
      roundStatus: reviewRounds.status,
      submissionStatus: submissions.status,
    })
    .from(reviewerAssignments)
    .innerJoin(
      reviewRounds,
      eq(reviewRounds.id, reviewerAssignments.reviewRoundId),
    )
    .innerJoin(
      submissions,
      eq(submissions.id, reviewerAssignments.submissionId),
    )
    .where(
      and(
        eq(reviewerAssignments.id, input.assignmentId),
        eq(reviewerAssignments.reviewerUserId, reviewerUserId),
        isNull(reviewerAssignments.revokedAt),
      ),
    )
    .limit(1);
  if (!assignment) return { ok: false, error: "not_found" };
  if (assignment.roundStatus !== "open") {
    return { ok: false, error: "round_not_open" };
  }
  if (assignment.submissionStatus !== "active") {
    return { ok: false, error: "submission_closed" };
  }
  const now = new Date();
  try {
    await database
      .insert(reviews)
      .values({
        id: crypto.randomUUID(),
        assignmentId: input.assignmentId,
        score: input.score,
        comment: input.comment,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: reviews.assignmentId,
        set: { score: input.score, comment: input.comment, updatedAt: now },
      });
  } catch (error: unknown) {
    if (String(error).includes("review_round_not_open")) {
      return { ok: false, error: "round_not_open" };
    }
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { saved: true } };
}

export async function openReviewRound(
  database: Database,
  actorUserId: UserId,
  slug: string,
): Promise<ReviewWriteResult<{ opened: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const round = await findOpenOrLatestReviewRound(database, event.id);
  if (!round || round.status !== "draft") {
    return { ok: false, error: "round_not_open" };
  }
  const now = new Date();
  const result = await database
    .update(reviewRounds)
    .set({ status: "open", openedAt: now, closedAt: null, updatedAt: now })
    .where(
      and(eq(reviewRounds.id, round.id), eq(reviewRounds.status, "draft")),
    );
  return result.meta.changes > 0
    ? { ok: true, value: { opened: true } }
    : { ok: false, error: "round_not_open" };
}

export async function closeReviewRound(
  database: Database,
  actorUserId: UserId,
  slug: string,
  allowMissingReviews: boolean,
): Promise<ReviewWriteResult<{ closed: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const round = await findOpenOrLatestReviewRound(database, event.id);
  if (!round || round.status !== "open") {
    return { ok: false, error: "round_not_open" };
  }
  const incompleteAssignments = database
    .select({ id: reviewerAssignments.id })
    .from(reviewerAssignments)
    .leftJoin(reviews, eq(reviews.assignmentId, reviewerAssignments.id))
    .innerJoin(
      submissions,
      eq(submissions.id, reviewerAssignments.submissionId),
    )
    .where(
      and(
        eq(reviewerAssignments.reviewRoundId, round.id),
        isNull(reviewerAssignments.revokedAt),
        isNull(reviews.id),
        eq(submissions.status, "active"),
      ),
    );
  const now = new Date();
  const result = await database
    .update(reviewRounds)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(reviewRounds.id, round.id),
        eq(reviewRounds.status, "open"),
        allowMissingReviews ? undefined : notExists(incompleteAssignments),
      ),
    );
  if (result.meta.changes > 0) {
    return { ok: true, value: { closed: true } };
  }
  if (!allowMissingReviews) {
    const [incomplete] = await incompleteAssignments.limit(1);
    if (incomplete) return { ok: false, error: "round_incomplete" };
  }
  return { ok: false, error: "round_not_open" };
}

export async function reopenReviewRound(
  database: Database,
  actorUserId: UserId,
  slug: string,
): Promise<ReviewWriteResult<{ reopened: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const round = await findOpenOrLatestReviewRound(database, event.id);
  if (!round || round.status !== "closed") {
    return { ok: false, error: "round_not_closed" };
  }
  const now = new Date();
  try {
    const [roundResult] = await database.batch([
      database
        .update(reviewRounds)
        .set({ status: "open", closedAt: null, updatedAt: now })
        .where(
          and(eq(reviewRounds.id, round.id), eq(reviewRounds.status, "closed")),
        ),
      database
        .update(decisions)
        .set({
          status: "pending",
          revision: sql`${decisions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(decisions.status, ["accept_queued", "decline_queued"]),
            inArray(
              decisions.submissionId,
              database
                .select({ id: submissions.id })
                .from(submissions)
                .where(eq(submissions.cfpId, round.cfpId)),
            ),
          ),
        ),
    ]);
    if (roundResult.meta.changes === 0) {
      return { ok: false, error: "round_not_closed" };
    }
  } catch (error: unknown) {
    if (String(error).includes("published_outcome_exists")) {
      return { ok: false, error: "published_outcome_exists" };
    }
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { reopened: true } };
}

export async function queueDecision(
  database: Database,
  actorUserId: UserId,
  slug: string,
  submissionId: SubmissionId,
  status: "pending" | "accept_queued" | "decline_queued",
): Promise<ReviewWriteResult<{ queued: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const round = await findOpenOrLatestReviewRound(database, event.id);
  if (!round) return { ok: false, error: "not_found" };
  const result = await database
    .update(decisions)
    .set({
      status,
      revision: sql`${decisions.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(decisions.submissionId, submissionId),
        notInArray(decisions.status, ["accepted", "declined"]),
        inArray(
          decisions.submissionId,
          database
            .select({ id: submissions.id })
            .from(submissions)
            .where(
              and(
                eq(submissions.id, submissionId),
                eq(submissions.eventId, event.id),
                eq(submissions.cfpId, round.cfpId),
                eq(submissions.status, "active"),
              ),
            ),
        ),
      ),
    );
  return result.meta.changes > 0
    ? { ok: true, value: { queued: true } }
    : { ok: false, error: "submission_closed" };
}

export async function publishDecisions(
  database: Database,
  actorUserId: UserId,
  input: DecisionPublicationInput,
): Promise<ReviewWriteResult<{ published: number }>> {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false, error: "not_found" };
  const round = await findOpenOrLatestReviewRound(database, event.id);
  if (!round || round.status !== "closed") {
    return { ok: false, error: "round_not_closed" };
  }
  const selectedIds = input.selections.map(
    (selection) => selection.submissionId,
  );
  const selectedRows = await database
    .select({
      decisionId: decisions.id,
      submissionId: submissions.id,
      ownerUserId: submissions.ownerUserId,
      ownerEmail: user.email,
      ownerName: user.name,
      eventName: events.name,
      submissionTitle: submissions.title,
    })
    .from(decisions)
    .innerJoin(submissions, eq(submissions.id, decisions.submissionId))
    .innerJoin(user, eq(user.id, submissions.ownerUserId))
    .innerJoin(events, eq(events.id, submissions.eventId))
    .where(
      and(
        inArray(submissions.id, selectedIds),
        eq(submissions.eventId, event.id),
        eq(submissions.cfpId, round.cfpId),
      ),
    );
  if (selectedRows.length !== input.selections.length) {
    return { ok: false, error: "stale_queue" };
  }

  const publicationId = crypto.randomUUID();
  const now = new Date();
  const selections = input.selections.map((selection) => {
    const row = selectedRows.find(
      (candidate) => candidate.submissionId === selection.submissionId,
    );
    if (!row) throw new Error("Selected decision disappeared.");
    return {
      ...selection,
      ...row,
      publicationItemId: crypto.randomUUID(),
      outcome:
        selection.expectedStatus === "accept_queued"
          ? ("accepted" as const)
          : ("declined" as const),
    };
  });
  let communicationRecords: Awaited<
    ReturnType<typeof prepareDecisionCommunicationRecords>
  >;
  try {
    communicationRecords = await prepareDecisionCommunicationRecords(
      database,
      event.id,
      selections.map((selection) => ({
        publicationItemId: selection.publicationItemId,
        actorUserId,
        outcome: selection.outcome,
        submissionId: selection.submissionId,
        ownerUserId: selection.ownerUserId,
        ownerEmail: selection.ownerEmail,
        ownerName: selection.ownerName,
        eventName: selection.eventName,
        submissionTitle: selection.submissionTitle,
      })),
      now,
    );
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  try {
    await database.batch([
      database.insert(decisionPublications).values({
        id: publicationId,
        eventId: event.id,
        reviewRoundId: round.id,
        publishedByUserId: actorUserId,
        createdAt: now,
      }),
      database.insert(decisionPublicationItems).values(
        selections.map((selection) => ({
          id: selection.publicationItemId,
          publicationId,
          decisionId: selection.decisionId,
          outcome: selection.outcome,
          expectedRevision: selection.expectedRevision,
        })),
      ),
      ...selections.map((selection) =>
        database
          .update(decisions)
          .set({
            status: selection.outcome,
            revision: sql`${decisions.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(decisions.id, selection.decisionId),
              eq(decisions.status, selection.expectedStatus),
              eq(decisions.revision, selection.expectedRevision),
            ),
          ),
      ),
      ...selections.flatMap((selection) =>
        selection.outcome === "accepted"
          ? [
              database.insert(programItems).values({
                id: crypto.randomUUID(),
                eventId: event.id,
                submissionId: selection.submissionId,
                createdAt: now,
              }),
            ]
          : [],
      ),
      ...communicationRecords.flatMap((record) =>
        record.communications.flatMap((communication) =>
          communicationInsertStatements(database, communication),
        ),
      ),
      ...communicationRecords.map((record) =>
        database.insert(reviewAuditEvents).values({
          id: crypto.randomUUID(),
          eventId: event.id,
          actorUserId: record.source.actorUserId,
          publicationItemId: record.source.publicationItemId,
          action: `decision_${record.source.outcome}`,
          createdAt: now,
        }),
      ),
    ]);
  } catch (error: unknown) {
    if (
      String(error).includes("stale_decision_publication") ||
      String(error).includes("UNIQUE constraint failed")
    ) {
      return { ok: false, error: "stale_queue" };
    }
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { published: selections.length } };
}

export async function retryDecisionCommunicationsAndAuditEvents(
  database: Database,
  actorUserId: UserId,
  slug: string,
): Promise<ReviewWriteResult<{ recorded: number }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  try {
    const recorded = await recordDecisionCommunicationsAndAuditEvents(
      database,
      event.id,
    );
    return { ok: true, value: { recorded } };
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
}

export async function repairDecisionCommunicationRecords(
  database: Database,
): Promise<number> {
  const eventRows = await database
    .selectDistinct({ eventId: decisionPublications.eventId })
    .from(decisionPublications)
    .innerJoin(
      decisionPublicationItems,
      eq(decisionPublicationItems.publicationId, decisionPublications.id),
    )
    .leftJoin(
      reviewAuditEvents,
      eq(reviewAuditEvents.publicationItemId, decisionPublicationItems.id),
    )
    .where(isNull(reviewAuditEvents.id));
  let recorded = 0;
  for (const row of eventRows) {
    recorded += await recordDecisionCommunicationsAndAuditEvents(
      database,
      row.eventId,
    );
  }
  return recorded;
}

async function recordDecisionCommunicationsAndAuditEvents(
  database: Database,
  eventId: string,
  publicationId?: string,
): Promise<number> {
  const rows = await database
    .select({
      publicationItemId: decisionPublicationItems.id,
      actorUserId: decisionPublications.publishedByUserId,
      outcome: decisionPublicationItems.outcome,
      submissionId: submissions.id,
      ownerUserId: submissions.ownerUserId,
      ownerEmail: user.email,
      ownerName: user.name,
      eventName: events.name,
      submissionTitle: submissions.title,
    })
    .from(decisionPublicationItems)
    .innerJoin(
      decisionPublications,
      eq(decisionPublications.id, decisionPublicationItems.publicationId),
    )
    .innerJoin(decisions, eq(decisions.id, decisionPublicationItems.decisionId))
    .innerJoin(submissions, eq(submissions.id, decisions.submissionId))
    .innerJoin(user, eq(user.id, submissions.ownerUserId))
    .innerJoin(events, eq(events.id, submissions.eventId))
    .where(
      and(
        eq(decisionPublications.eventId, eventId),
        publicationId ? eq(decisionPublications.id, publicationId) : undefined,
      ),
    );
  const now = new Date();
  const records = await prepareDecisionCommunicationRecords(
    database,
    eventId,
    rows,
    now,
  );
  for (const record of records) {
    await database.batch([
      database
        .insert(reviewAuditEvents)
        .values({
          id: crypto.randomUUID(),
          eventId,
          actorUserId: record.source.actorUserId,
          publicationItemId: record.source.publicationItemId,
          action: `decision_${record.source.outcome}`,
          createdAt: now,
        })
        .onConflictDoNothing(),
      ...record.communications.flatMap((communication) =>
        communicationInsertStatements(database, communication),
      ),
    ]);
  }
  return rows.length;
}

type DecisionCommunicationSource = {
  publicationItemId: string;
  actorUserId: string;
  outcome: "accepted" | "declined";
  submissionId: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerName: string;
  eventName: string;
  submissionTitle: string;
};

async function prepareDecisionCommunicationRecords(
  database: Database,
  eventId: string,
  rows: DecisionCommunicationSource[],
  now: Date,
) {
  return Promise.all(
    rows.map(async (row) => {
      const speakerRows = await database
        .select({
          id: submissionSpeakers.id,
          invitationId: submissionSpeakerInvitations.id,
          claimedUserId: submissionSpeakers.claimedUserId,
          invitedEmail: submissionSpeakers.invitedEmail,
          invitedName: submissionSpeakers.invitedName,
        })
        .from(submissionSpeakers)
        .leftJoin(
          submissionSpeakerInvitations,
          and(
            eq(
              submissionSpeakerInvitations.submissionSpeakerId,
              submissionSpeakers.id,
            ),
            eq(submissionSpeakerInvitations.status, "pending"),
          ),
        )
        .where(
          and(
            eq(submissionSpeakers.submissionId, row.submissionId),
            isNull(submissionSpeakers.removedAt),
          ),
        );
      const claimedUserIds = speakerRows.flatMap((speaker) =>
        speaker.claimedUserId ? [speaker.claimedUserId] : [],
      );
      const claimedUsers =
        claimedUserIds.length === 0
          ? []
          : await database
              .select({ id: user.id, email: user.email, name: user.name })
              .from(user)
              .where(inArray(user.id, claimedUserIds));
      const recipients = new Map<string, CommunicationRecipient>([
        [
          `user:${row.ownerUserId}`,
          {
            key: `user:${row.ownerUserId}`,
            userId: row.ownerUserId,
            invitationId: null,
            destination: row.ownerEmail,
            name: row.ownerName,
          },
        ] as const,
      ]);
      for (const speaker of speakerRows) {
        const claimed = claimedUsers.find(
          (candidate) => candidate.id === speaker.claimedUserId,
        );
        const recipient = claimed
          ? {
              key: `user:${claimed.id}`,
              userId: claimed.id,
              invitationId: null,
              destination: claimed.email,
              name: claimed.name,
            }
          : speaker.invitationId
            ? {
                key: `invitation:${speaker.invitationId}`,
                userId: null,
                invitationId: speaker.invitationId,
                destination: speaker.invitedEmail,
                name: speaker.invitedName,
              }
            : {
                key: `speaker:${speaker.id}`,
                userId: null,
                invitationId: null,
                destination: speaker.invitedEmail,
                name: speaker.invitedName,
              };
        recipients.set(recipient.key, recipient);
      }
      const purpose =
        row.outcome === "accepted" ? "decision_acceptance" : "decision_decline";
      const existing = await database
        .select({ recipientKey: communications.recipientKey })
        .from(communications)
        .where(
          and(
            eq(communications.submissionId, row.submissionId),
            eq(communications.purpose, purpose),
          ),
        );
      const existingKeys = new Set(
        existing.map((message) => message.recipientKey),
      );
      const prepared = await Promise.all(
        [...recipients.values()]
          .filter((recipient) => !existingKeys.has(recipient.key))
          .map((recipient) =>
            prepareCommunication(database, {
              eventId,
              submissionId: row.submissionId,
              purpose,
              recipient,
              variables: {
                eventName: row.eventName,
                submissionTitle: row.submissionTitle,
                recipientName: recipient.name,
              },
              context: { publicationItemId: row.publicationItemId },
              now,
            }),
          ),
      );
      return { source: row, communications: prepared };
    }),
  );
}

async function findOpenOrLatestReviewRound(
  database: Database,
  eventId: string,
) {
  const [round] = await database
    .select({
      id: reviewRounds.id,
      eventId: reviewRounds.eventId,
      cfpId: reviewRounds.cfpId,
      name: reviewRounds.name,
      status: reviewRounds.status,
      openedAt: reviewRounds.openedAt,
      closedAt: reviewRounds.closedAt,
      createdAt: reviewRounds.createdAt,
      updatedAt: reviewRounds.updatedAt,
    })
    .from(reviewRounds)
    .innerJoin(cfps, eq(cfps.id, reviewRounds.cfpId))
    .where(eq(reviewRounds.eventId, eventId))
    .orderBy(
      sql`CASE ${cfps.status} WHEN 'open' THEN 0 ELSE 1 END`,
      desc(reviewRounds.createdAt),
    )
    .limit(1);
  return round;
}
