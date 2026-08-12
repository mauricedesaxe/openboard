import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import type { AppConfig } from "../config";
import type { Database } from "../database/client";
import { communicationDeliveryWork, communications } from "../database/schema";
import {
  createEmailDeliveryError,
  emailFailureIsRetryable,
  sendConfiguredEmail,
} from "../email/transport";

const retryBaseMs = 30_000;
const claimTimeoutMs = 5 * 60_000;
const maxAttempts = 8;

export async function processCommunicationDeliveryWork(
  database: Database,
  config: AppConfig,
  options: { now?: Date; limit?: number } = {},
) {
  const now = currentTime(options);
  const staleClaim = new Date(now.getTime() - claimTimeoutMs);
  const candidates = await database
    .select({ work: communicationDeliveryWork, communication: communications })
    .from(communicationDeliveryWork)
    .innerJoin(
      communications,
      eq(communications.id, communicationDeliveryWork.communicationId),
    )
    .where(
      and(
        inArray(communicationDeliveryWork.status, ["pending", "failed"]),
        or(
          isNull(communicationDeliveryWork.nextAttemptAt),
          lte(communicationDeliveryWork.nextAttemptAt, now),
        ),
        or(
          isNull(communicationDeliveryWork.claimToken),
          lte(communicationDeliveryWork.claimedAt, staleClaim),
        ),
      ),
    )
    .orderBy(asc(communicationDeliveryWork.createdAt))
    .limit(options.limit ?? 25);
  const summary = { delivered: 0, failed: 0, terminal: 0 };
  for (const candidate of candidates) {
    if (
      config.email.type === "cloudflare" &&
      candidate.work.claimToken &&
      candidate.work.claimedAt &&
      candidate.work.claimedAt <= staleClaim
    ) {
      const finished = await finishCommunicationAttempt(
        database,
        candidate.work.id,
        candidate.work.claimToken,
        candidate.work.attemptCount,
        candidate.work.claimedAt,
        now,
        {
          status: "terminal",
          result: "terminal_failure",
          providerId: null,
          error: "Previous Cloudflare delivery outcome is unknown",
          nextAttemptAt: null,
        },
      );
      if (finished) summary.terminal += 1;
      continue;
    }
    const token = crypto.randomUUID();
    const attemptNumber = candidate.work.attemptCount + 1;
    const claimedAt = currentTime(options);
    const claim = await database
      .update(communicationDeliveryWork)
      .set({
        claimToken: token,
        claimedAt,
        attemptCount: attemptNumber,
      })
      .where(
        and(
          eq(communicationDeliveryWork.id, candidate.work.id),
          eq(communicationDeliveryWork.status, candidate.work.status),
          eq(
            communicationDeliveryWork.attemptCount,
            candidate.work.attemptCount,
          ),
          candidate.work.nextAttemptAt
            ? eq(
                communicationDeliveryWork.nextAttemptAt,
                candidate.work.nextAttemptAt,
              )
            : isNull(communicationDeliveryWork.nextAttemptAt),
          candidate.work.claimToken
            ? eq(
                communicationDeliveryWork.claimToken,
                candidate.work.claimToken,
              )
            : isNull(communicationDeliveryWork.claimToken),
          candidate.work.claimedAt
            ? eq(communicationDeliveryWork.claimedAt, candidate.work.claimedAt)
            : isNull(communicationDeliveryWork.claimedAt),
        ),
      );
    if (claim.meta.changes === 0) continue;
    const startedAt = claimedAt;
    let status: "completed" | "failed" | "terminal" = "completed";
    let result: "delivered" | "retryable_failure" | "terminal_failure" =
      "delivered";
    let providerId: string | null = null;
    let errorMessage: string | null = null;
    try {
      if (!candidate.communication.subject || !candidate.communication.body) {
        throw createEmailDeliveryError(
          "Communication snapshot is incomplete",
          false,
        );
      }
      const delivered = await sendConfiguredEmail(config, {
        idempotencyKey: candidate.communication.id,
        to: candidate.communication.destination,
        subject: candidate.communication.subject,
        text: candidate.communication.body,
      });
      providerId = delivered.providerId;
    } catch (error: unknown) {
      const retryable = emailFailureIsRetryable(error);
      const exhausted = attemptNumber >= maxAttempts;
      status = retryable && !exhausted ? "failed" : "terminal";
      result =
        retryable && !exhausted ? "retryable_failure" : "terminal_failure";
      errorMessage =
        error instanceof Error ? error.message : "Email delivery failed";
    }
    const finishedAt = currentTime(options);
    const nextAttemptAt =
      status === "failed"
        ? new Date(
            finishedAt.getTime() +
              retryDelayMs(candidate.work.id, attemptNumber),
          )
        : null;
    const finished = await finishCommunicationAttempt(
      database,
      candidate.work.id,
      token,
      attemptNumber,
      startedAt,
      finishedAt,
      {
        status,
        result,
        providerId,
        error: errorMessage,
        nextAttemptAt,
      },
    );
    if (finished) {
      summary[status === "completed" ? "delivered" : status] += 1;
    }
  }
  return summary;
}

function currentTime(options: { now?: Date }): Date {
  return options.now ?? new Date();
}

async function finishCommunicationAttempt(
  database: Database,
  workId: string,
  claimToken: string,
  attemptNumber: number,
  startedAt: Date,
  finishedAt: Date,
  outcome: {
    status: "completed" | "failed" | "terminal";
    result: "delivered" | "retryable_failure" | "terminal_failure";
    providerId: string | null;
    error: string | null;
    nextAttemptAt: Date | null;
  },
): Promise<boolean> {
  const [attempt, completed] = await database.$client.batch([
    database.$client
      .prepare(
        "INSERT INTO communication_delivery_attempts (id, work_id, attempt_number, started_at, finished_at, latency_ms, result, provider_id, error) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM communication_delivery_work WHERE id = ? AND claim_token = ? AND attempt_count = ?)",
      )
      .bind(
        crypto.randomUUID(),
        workId,
        attemptNumber,
        startedAt.getTime(),
        finishedAt.getTime(),
        Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        outcome.result,
        outcome.providerId,
        outcome.error,
        workId,
        claimToken,
        attemptNumber,
      ),
    database.$client
      .prepare(
        "UPDATE communication_delivery_work SET status = ?, claim_token = NULL, claimed_at = NULL, last_error = ?, next_attempt_at = ? WHERE id = ? AND claim_token = ? AND attempt_count = ?",
      )
      .bind(
        outcome.status,
        outcome.error,
        outcome.nextAttemptAt?.getTime() ?? null,
        workId,
        claimToken,
        attemptNumber,
      ),
  ]);
  return attempt?.meta.changes === 1 && completed?.meta.changes === 1;
}

function retryDelayMs(workId: string, attemptNumber: number): number {
  const capped = Math.min(3_600_000, 2 ** attemptNumber * retryBaseMs);
  const hash = [...workId].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return Math.round(capped * (0.75 + (hash % 501) / 1000));
}
