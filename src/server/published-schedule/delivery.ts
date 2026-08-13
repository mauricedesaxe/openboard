import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

import type { AgendaItemId } from "../../shared/agendas";
import type { Database } from "../database/client";
import {
  agendaDeliveryWork,
  agendaPublications,
  calendarSyncStates,
  publishedAgendaItems,
  publishedAgendaSpeakers,
} from "../database/schema";
import { emailFailureIsRetryable } from "../email/transport";

import { renderAgendaCalendarMessage } from "./ical";

const deliveryClaimTimeoutMs = 5 * 60_000;
const defaultDeliveryBatchSize = 25;
const deliveryRetryBaseDelayMs = 30_000;
const deliveryRetryMaximumDelayMs = 60 * 60_000;

type AgendaDeliveryOptions = {
  organizerEmail: string;
  retryStaleClaims?: boolean;
  now?: Date;
  clock?: () => Date;
  limit?: number;
};

export type AgendaCalendarDelivery = {
  workId: string;
  publicationId: string;
  agendaItemId: AgendaItemId;
  recipientKey: string;
  recipientUserId: string | null;
  destination: string;
  action: "publish" | "update" | "cancel" | "restore";
  uid: string;
  sequence: number;
  method: "REQUEST" | "CANCEL";
  subject: string;
  text: string;
  calendar: string;
};

export async function processAgendaDeliveryWork(
  database: Database,
  deliver: (delivery: AgendaCalendarDelivery) => Promise<void>,
  options: AgendaDeliveryOptions,
): Promise<{ delivered: number; failed: number; superseded: number }> {
  const now = currentTime(options);
  const staleClaim = new Date(now.getTime() - deliveryClaimTimeoutMs);
  const work = await database
    .select()
    .from(agendaDeliveryWork)
    .where(
      and(
        inArray(agendaDeliveryWork.status, ["pending", "failed"]),
        or(
          isNull(agendaDeliveryWork.nextAttemptAt),
          lte(agendaDeliveryWork.nextAttemptAt, now),
        ),
        eq(agendaDeliveryWork.retryEligible, true),
        or(
          isNull(agendaDeliveryWork.claimedAt),
          lte(agendaDeliveryWork.claimedAt, staleClaim),
        ),
      ),
    )
    .orderBy(asc(agendaDeliveryWork.createdAt), asc(agendaDeliveryWork.id))
    .limit(options.limit ?? defaultDeliveryBatchSize);

  const result = { delivered: 0, failed: 0, superseded: 0 };
  for (const candidate of work) {
    if (
      options.retryStaleClaims === false &&
      candidate.claimToken &&
      candidate.claimedAt &&
      candidate.claimedAt <= staleClaim
    ) {
      const finished = await finishAttempt(
        database,
        candidate.id,
        candidate.claimToken,
        candidate.attemptCount,
        candidate.claimedAt,
        now,
        {
          status: "failed",
          error: "Previous Cloudflare delivery outcome is unknown",
          retryEligible: false,
          nextAttemptAt: null,
        },
      );
      if (finished) result.failed += 1;
      continue;
    }
    const claimToken = crypto.randomUUID();
    const attemptNumber = candidate.attemptCount + 1;
    const claimedAt = currentTime(options);
    const claimed = await database
      .update(agendaDeliveryWork)
      .set({
        claimedAt,
        claimToken,
        attemptCount: attemptNumber,
      })
      .where(
        and(
          eq(agendaDeliveryWork.id, candidate.id),
          eq(agendaDeliveryWork.status, candidate.status),
          eq(agendaDeliveryWork.attemptCount, candidate.attemptCount),
          candidate.nextAttemptAt
            ? eq(agendaDeliveryWork.nextAttemptAt, candidate.nextAttemptAt)
            : isNull(agendaDeliveryWork.nextAttemptAt),
          candidate.claimedAt
            ? eq(agendaDeliveryWork.claimedAt, candidate.claimedAt)
            : isNull(agendaDeliveryWork.claimedAt),
          candidate.claimToken
            ? eq(agendaDeliveryWork.claimToken, candidate.claimToken)
            : isNull(agendaDeliveryWork.claimToken),
        ),
      );
    if (claimed.meta.changes === 0) continue;

    const startedAt = claimedAt;
    const current = await database
      .select({
        uid: calendarSyncStates.uid,
      })
      .from(calendarSyncStates)
      .where(eq(calendarSyncStates.agendaItemId, candidate.agendaItemId))
      .limit(1);
    if (
      current[0]?.uid !== candidate.calendarUid ||
      !candidate.recipientKey ||
      !candidate.destination ||
      !candidate.recipientName
    ) {
      const finished = await finishAttempt(
        database,
        candidate.id,
        claimToken,
        attemptNumber,
        startedAt,
        currentTime(options),
        {
          status: "superseded",
        },
      );
      if (finished) result.superseded += 1;
      continue;
    }

    const [newerRecipientWork] = await database
      .select({ id: agendaDeliveryWork.id })
      .from(agendaDeliveryWork)
      .where(
        and(
          eq(agendaDeliveryWork.agendaItemId, candidate.agendaItemId),
          eq(agendaDeliveryWork.calendarUid, candidate.calendarUid),
          eq(agendaDeliveryWork.recipientKey, candidate.recipientKey),
          eq(agendaDeliveryWork.destination, candidate.destination),
          gt(agendaDeliveryWork.calendarSequence, candidate.calendarSequence),
        ),
      )
      .limit(1);
    if (newerRecipientWork) {
      const finished = await finishAttempt(
        database,
        candidate.id,
        claimToken,
        attemptNumber,
        startedAt,
        currentTime(options),
        { status: "superseded" },
      );
      if (finished) result.superseded += 1;
      continue;
    }

    try {
      const delivery = await createAgendaCalendarDelivery(
        database,
        candidate,
        options.organizerEmail,
      );
      if (!delivery)
        throw new Error("Calendar publication snapshot is missing");
      await deliver(delivery);
      const finishedAt = currentTime(options);
      const finished = await finishAttempt(
        database,
        candidate.id,
        claimToken,
        attemptNumber,
        startedAt,
        finishedAt,
        {
          status: "completed",
        },
      );
      if (finished) result.delivered += 1;
    } catch (error: unknown) {
      const retryable = emailFailureIsRetryable(error);
      const message =
        error instanceof Error ? error.message : "Unknown delivery failure";
      const finishedAt = currentTime(options);
      const finished = await finishAttempt(
        database,
        candidate.id,
        claimToken,
        attemptNumber,
        startedAt,
        finishedAt,
        {
          status: "failed",
          error: message,
          retryEligible: retryable,
          nextAttemptAt: retryable
            ? nextDeliveryAttemptAt(finishedAt, attemptNumber)
            : null,
        },
      );
      if (finished) result.failed += 1;
    }
  }
  return result;
}

async function createAgendaCalendarDelivery(
  database: Database,
  candidate: typeof agendaDeliveryWork.$inferSelect,
  organizerEmail: string,
): Promise<AgendaCalendarDelivery | undefined> {
  if (
    !candidate.recipientKey ||
    !candidate.destination ||
    !candidate.recipientName
  ) {
    return undefined;
  }
  let [snapshot] = await database
    .select({
      publishedAt: agendaPublications.createdAt,
      eventName: agendaPublications.eventName,
      timezone: agendaPublications.timezone,
      publishedAgendaItemId: publishedAgendaItems.id,
      title: publishedAgendaItems.title,
      abstract: publishedAgendaItems.abstract,
      trackName: publishedAgendaItems.trackName,
      roomName: publishedAgendaItems.roomName,
      startsAt: publishedAgendaItems.startsAt,
      endsAt: publishedAgendaItems.endsAt,
    })
    .from(publishedAgendaItems)
    .innerJoin(
      agendaPublications,
      eq(agendaPublications.id, publishedAgendaItems.publicationId),
    )
    .where(
      and(
        eq(publishedAgendaItems.publicationId, candidate.publicationId),
        eq(publishedAgendaItems.agendaItemId, candidate.agendaItemId),
      ),
    )
    .limit(1);
  if (!snapshot && candidate.action === "cancel") {
    [snapshot] = await database
      .select({
        publishedAt: agendaPublications.createdAt,
        eventName: agendaPublications.eventName,
        timezone: agendaPublications.timezone,
        publishedAgendaItemId: publishedAgendaItems.id,
        title: publishedAgendaItems.title,
        abstract: publishedAgendaItems.abstract,
        trackName: publishedAgendaItems.trackName,
        roomName: publishedAgendaItems.roomName,
        startsAt: publishedAgendaItems.startsAt,
        endsAt: publishedAgendaItems.endsAt,
      })
      .from(publishedAgendaItems)
      .innerJoin(
        agendaPublications,
        eq(agendaPublications.id, publishedAgendaItems.publicationId),
      )
      .where(eq(publishedAgendaItems.agendaItemId, candidate.agendaItemId))
      .orderBy(desc(agendaPublications.revision))
      .limit(1);
  }
  if (!snapshot) return undefined;
  const speakers = await database
    .select({ displayName: publishedAgendaSpeakers.displayName })
    .from(publishedAgendaSpeakers)
    .where(
      eq(
        publishedAgendaSpeakers.publishedAgendaItemId,
        snapshot.publishedAgendaItemId,
      ),
    )
    .orderBy(
      asc(publishedAgendaSpeakers.position),
      asc(publishedAgendaSpeakers.submissionSpeakerId),
    );
  const message = renderAgendaCalendarMessage({
    eventName: snapshot.eventName,
    timezone: snapshot.timezone,
    publishedAt: snapshot.publishedAt.toISOString(),
    destination: candidate.destination,
    recipientName: candidate.recipientName,
    organizerEmail,
    action: candidate.action,
    uid: candidate.calendarUid,
    sequence: candidate.calendarSequence,
    item: {
      title: snapshot.title,
      abstract: snapshot.abstract,
      trackName: snapshot.trackName,
      roomName: snapshot.roomName,
      startsAt: snapshot.startsAt,
      endsAt: snapshot.endsAt,
      speakers: speakers.map((speaker) => speaker.displayName),
    },
  });
  return {
    workId: candidate.id,
    publicationId: candidate.publicationId,
    agendaItemId: candidate.agendaItemId as AgendaItemId,
    recipientKey: candidate.recipientKey,
    recipientUserId: candidate.recipientUserId,
    destination: candidate.destination,
    action: candidate.action,
    uid: candidate.calendarUid,
    sequence: candidate.calendarSequence,
    ...message,
    subject: candidate.subject ?? message.subject,
    text: candidate.body ?? message.text,
  };
}

function currentTime(options: { now?: Date; clock?: () => Date }): Date {
  return options.clock?.() ?? options.now ?? new Date();
}

function nextDeliveryAttemptAt(finishedAt: Date, attemptNumber: number): Date {
  const delay = Math.min(
    deliveryRetryMaximumDelayMs,
    2 ** attemptNumber * deliveryRetryBaseDelayMs,
  );
  return new Date(finishedAt.getTime() + delay);
}

async function finishAttempt(
  database: Database,
  workId: string,
  claimToken: string,
  attemptNumber: number,
  startedAt: Date,
  finishedAt: Date,
  outcome:
    | { status: "completed" | "superseded" }
    | {
        status: "failed";
        error: string;
        retryEligible: boolean;
        nextAttemptAt: Date | null;
      },
): Promise<boolean> {
  const result =
    outcome.status === "completed"
      ? "delivered"
      : outcome.status === "superseded"
        ? "superseded"
        : "failed";
  const error = outcome.status === "failed" ? outcome.error : null;
  const [attempt, completed] = await database.$client.batch([
    database.$client
      .prepare(
        "INSERT INTO agenda_delivery_attempts (id, work_id, attempt_number, started_at, finished_at, latency_ms, result, error) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agenda_delivery_work WHERE id = ? AND claim_token = ? AND attempt_count = ?)",
      )
      .bind(
        crypto.randomUUID(),
        workId,
        attemptNumber,
        startedAt.getTime(),
        finishedAt.getTime(),
        Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        result,
        error,
        workId,
        claimToken,
        attemptNumber,
      ),
    database.$client
      .prepare(
        "UPDATE agenda_delivery_work SET status = ?, claimed_at = NULL, claim_token = NULL, completed_at = ?, superseded_at = ?, next_attempt_at = ?, last_error = ?, retry_eligible = ? WHERE id = ? AND claim_token = ? AND attempt_count = ?",
      )
      .bind(
        outcome.status,
        outcome.status === "completed" ? finishedAt.getTime() : null,
        outcome.status === "superseded" ? finishedAt.getTime() : null,
        outcome.status === "failed"
          ? (outcome.nextAttemptAt?.getTime() ?? null)
          : null,
        error,
        outcome.status === "failed" ? outcome.retryEligible : false,
        workId,
        claimToken,
        attemptNumber,
      ),
  ]);
  return attempt?.meta.changes === 1 && completed?.meta.changes === 1;
}
