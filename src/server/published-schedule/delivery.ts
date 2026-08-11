import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import type { AgendaItemId } from "../../shared/agendas";
import type { Database } from "../database/client";
import {
  agendaDeliveryAttempts,
  agendaDeliveryWork,
  agendaPublications,
  calendarSyncStates,
  publishedAgendaItems,
  publishedAgendaSpeakers,
} from "../database/schema";

import { renderAgendaCalendarMessage } from "./ical";

const deliveryClaimTimeoutMs = 5 * 60_000;
const defaultDeliveryBatchSize = 25;
const deliveryRetryBaseDelayMs = 30_000;
const deliveryRetryMaximumDelayMs = 60 * 60_000;
const deliveryTransportTimeoutMs = 60_000;

type AgendaDeliveryOptions = {
  organizerEmail: string;
  now?: Date;
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
  const now = options.now ?? new Date();
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
    const claimToken = crypto.randomUUID();
    const attemptNumber = candidate.attemptCount + 1;
    const claimed = await database
      .update(agendaDeliveryWork)
      .set({
        claimedAt: now,
        claimToken,
        attemptCount: attemptNumber,
      })
      .where(
        and(
          eq(agendaDeliveryWork.id, candidate.id),
          inArray(agendaDeliveryWork.status, ["pending", "failed"]),
          candidate.claimedAt
            ? eq(agendaDeliveryWork.claimedAt, candidate.claimedAt)
            : isNull(agendaDeliveryWork.claimedAt),
        ),
      );
    if (claimed.meta.changes === 0) continue;

    const startedAt = now;
    const current = await database
      .select({
        uid: calendarSyncStates.uid,
        sequence: calendarSyncStates.sequence,
      })
      .from(calendarSyncStates)
      .where(eq(calendarSyncStates.agendaItemId, candidate.agendaItemId))
      .limit(1);
    if (
      current[0]?.uid !== candidate.calendarUid ||
      current[0]?.sequence !== candidate.calendarSequence ||
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

    try {
      const delivery = await createAgendaCalendarDelivery(
        database,
        candidate,
        options.organizerEmail,
      );
      if (!delivery)
        throw new Error("Calendar publication snapshot is missing");
      await deliverBeforeTimeout(deliver(delivery));
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
          nextAttemptAt: nextDeliveryAttemptAt(finishedAt, attemptNumber),
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
  const [snapshot] = await database
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
  };
}

async function deliverBeforeTimeout(delivery: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Calendar transport timed out")),
          deliveryTransportTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function currentTime(options: { now?: Date }): Date {
  return options.now ?? new Date();
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
    | { status: "failed"; error: string; nextAttemptAt: Date },
): Promise<boolean> {
  const result =
    outcome.status === "completed"
      ? "delivered"
      : outcome.status === "superseded"
        ? "superseded"
        : "failed";
  const completed = await database
    .update(agendaDeliveryWork)
    .set({
      status: outcome.status,
      claimedAt: null,
      claimToken: null,
      completedAt: outcome.status === "completed" ? finishedAt : null,
      supersededAt: outcome.status === "superseded" ? finishedAt : null,
      nextAttemptAt: outcome.status === "failed" ? outcome.nextAttemptAt : null,
      lastError: outcome.status === "failed" ? outcome.error : null,
    })
    .where(
      and(
        eq(agendaDeliveryWork.id, workId),
        eq(agendaDeliveryWork.claimToken, claimToken),
        eq(agendaDeliveryWork.attemptCount, attemptNumber),
      ),
    );
  if (completed.meta.changes === 0) return false;
  await database.insert(agendaDeliveryAttempts).values({
    id: crypto.randomUUID(),
    workId,
    attemptNumber,
    startedAt,
    finishedAt,
    latencyMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    result,
    error: outcome.status === "failed" ? outcome.error : null,
  });
  return true;
}
