import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import type { Database } from "../database/client";
import {
  agendaDeliveryAttempts,
  agendaDeliveryWork,
  calendarSyncStates,
} from "../database/schema";

export type AgendaCalendarDelivery = {
  workId: string;
  publicationId: string;
  agendaItemId: string;
  action: "publish" | "update" | "cancel" | "restore";
  uid: string;
  sequence: number;
};

export async function processAgendaDeliveryWork(
  database: Database,
  deliver: (delivery: AgendaCalendarDelivery) => Promise<void>,
  options: { now?: Date; limit?: number } = {},
): Promise<{ delivered: number; failed: number; superseded: number }> {
  const now = options.now ?? new Date();
  const staleClaim = new Date(now.getTime() - 5 * 60_000);
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
    .limit(options.limit ?? 25);

  const result = { delivered: 0, failed: 0, superseded: 0 };
  for (const candidate of work) {
    const claimed = await database
      .update(agendaDeliveryWork)
      .set({ claimedAt: now })
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

    const attemptNumber = candidate.attemptCount + 1;
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
      current[0]?.sequence !== candidate.calendarSequence
    ) {
      await finishAttempt(
        database,
        candidate.id,
        attemptNumber,
        startedAt,
        now,
        {
          status: "superseded",
        },
      );
      result.superseded += 1;
      continue;
    }

    try {
      await deliver({
        workId: candidate.id,
        publicationId: candidate.publicationId,
        agendaItemId: candidate.agendaItemId,
        action: candidate.action,
        uid: candidate.calendarUid,
        sequence: candidate.calendarSequence,
      });
      await finishAttempt(
        database,
        candidate.id,
        attemptNumber,
        startedAt,
        now,
        {
          status: "completed",
        },
      );
      result.delivered += 1;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown delivery failure";
      await finishAttempt(
        database,
        candidate.id,
        attemptNumber,
        startedAt,
        now,
        {
          status: "failed",
          error: message,
          nextAttemptAt: new Date(
            now.getTime() + Math.min(60 * 60_000, 2 ** attemptNumber * 30_000),
          ),
        },
      );
      result.failed += 1;
    }
  }
  return result;
}

async function finishAttempt(
  database: Database,
  workId: string,
  attemptNumber: number,
  startedAt: Date,
  finishedAt: Date,
  outcome:
    | { status: "completed" | "superseded" }
    | { status: "failed"; error: string; nextAttemptAt: Date },
): Promise<void> {
  const result =
    outcome.status === "completed"
      ? "delivered"
      : outcome.status === "superseded"
        ? "superseded"
        : "failed";
  await database.batch([
    database.insert(agendaDeliveryAttempts).values({
      id: crypto.randomUUID(),
      workId,
      attemptNumber,
      startedAt,
      finishedAt,
      latencyMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      result,
      error: outcome.status === "failed" ? outcome.error : null,
    }),
    database
      .update(agendaDeliveryWork)
      .set({
        status: outcome.status,
        attemptCount: attemptNumber,
        claimedAt: null,
        completedAt: outcome.status === "completed" ? finishedAt : null,
        supersededAt: outcome.status === "superseded" ? finishedAt : null,
        nextAttemptAt:
          outcome.status === "failed" ? outcome.nextAttemptAt : null,
        lastError: outcome.status === "failed" ? outcome.error : null,
      })
      .where(eq(agendaDeliveryWork.id, workId)),
  ]);
}
