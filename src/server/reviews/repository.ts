import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";

import type { UserId } from "../../shared/events";
import type {
  DecisionPublicationInput,
  ReviewerAssignmentId,
} from "../../shared/reviews";
import type { SubmissionId } from "../../shared/submissions";
import type { Database } from "../database/client";
import {
  communications,
  cfps,
  decisionPublicationItems,
  decisionPublications,
  decisions,
  eventRoles,
  events,
  programItems,
  reviewAuditEvents,
  reviewerAssignments,
  reviewRounds,
  reviews,
  submissions,
  tracks,
  user,
} from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

type ReviewWriteError =
  | "duplicate_assignment"
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
  const round = await findCurrentRound(database, event.id);
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
  const proposalRows = await database
    .select({
      id: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      status: submissions.status,
      track: tracks.name,
      decisionStatus: decisions.status,
      decisionRevision: decisions.revision,
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

  return {
    round: { id: round.id, name: round.name, status: round.status },
    reviewers: activeReviewers,
    submissions: proposalRows.map((submission) => {
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
) {
  return database
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
        isNull(reviewerAssignments.revokedAt),
        eq(submissions.status, "active"),
      ),
    )
    .orderBy(asc(submissions.title))
    .then((rows) =>
      rows.map((row) => ({
        assignmentId: row.assignmentId,
        roundStatus: row.roundStatus,
        submission: {
          id: row.submissionId,
          title: row.title,
          abstract: row.abstract,
          format: row.format,
          track: row.track,
        },
        review:
          row.score === null
            ? null
            : { score: row.score, comment: row.comment ?? null },
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
      return { ok: false, error: "duplicate_assignment" };
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
  const result = await database
    .update(reviewerAssignments)
    .set({ revokedAt: new Date(), revokedByUserId: actorUserId })
    .where(
      and(
        eq(reviewerAssignments.id, assignmentId),
        eq(reviewerAssignments.eventId, event.id),
        isNull(reviewerAssignments.revokedAt),
      ),
    );
  return result.meta.changes > 0
    ? { ok: true, value: { revoked: true } }
    : { ok: false, error: "not_found" };
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
  const round = await findCurrentRound(database, event.id);
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
  confirmIncomplete: boolean,
): Promise<ReviewWriteResult<{ closed: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const round = await findCurrentRound(database, event.id);
  if (!round || round.status !== "open") {
    return { ok: false, error: "round_not_open" };
  }
  if (!confirmIncomplete) {
    const [incomplete] = await database
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
      )
      .limit(1);
    if (incomplete) return { ok: false, error: "round_incomplete" };
  }
  const now = new Date();
  const result = await database
    .update(reviewRounds)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(and(eq(reviewRounds.id, round.id), eq(reviewRounds.status, "open")));
  return result.meta.changes > 0
    ? { ok: true, value: { closed: true } }
    : { ok: false, error: "round_not_open" };
}

export async function reopenReviewRound(
  database: Database,
  actorUserId: UserId,
  slug: string,
): Promise<ReviewWriteResult<{ reopened: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const round = await findCurrentRound(database, event.id);
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
  const round = await findCurrentRound(database, event.id);
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
  const round = await findCurrentRound(database, event.id);
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
    })
    .from(decisions)
    .innerJoin(submissions, eq(submissions.id, decisions.submissionId))
    .innerJoin(user, eq(user.id, submissions.ownerUserId))
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
      outcome:
        selection.expectedStatus === "accept_queued"
          ? ("accepted" as const)
          : ("declined" as const),
    };
  });
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
          id: crypto.randomUUID(),
          publicationId,
          decisionId: selection.decisionId,
          outcome: selection.outcome,
          expectedRevision: selection.expectedRevision,
          createdAt: now,
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

  try {
    for (const selection of selections) {
      await database.batch([
        database
          .insert(communications)
          .values({
            id: crypto.randomUUID(),
            submissionId: selection.submissionId,
            recipientUserId: selection.ownerUserId,
            destination: selection.ownerEmail,
            purpose:
              selection.outcome === "accepted"
                ? "decision_acceptance"
                : "decision_decline",
            createdAt: now,
          })
          .onConflictDoNothing(),
        database.insert(reviewAuditEvents).values({
          id: crypto.randomUUID(),
          eventId: event.id,
          actorUserId,
          action: `decision_${selection.outcome}`,
          subjectId: selection.submissionId,
          createdAt: now,
        }),
      ]);
    }
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "decision_publication_followup_failed",
        publicationId,
        error:
          error instanceof Error ? error.message : "Unknown database failure",
      }),
    );
  }
  return { ok: true, value: { published: selections.length } };
}

async function findCurrentRound(database: Database, eventId: string) {
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
