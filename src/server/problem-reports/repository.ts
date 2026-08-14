import { sql } from "drizzle-orm";
import { z } from "zod";

import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";

const reportLimit = 3;
const attemptLimit = 10;
const reportWindowMs = 60 * 60 * 1000;

type ReportRateLimitIdentity =
  { type: "user"; userId: UserId } | { type: "ip"; ipAddress: string };

type ProblemReportReservation = { key: string };

export async function reserveProblemReport(
  database: Database,
  identity: ReportRateLimitIdentity,
  keySecret: string,
  now: Date,
): Promise<ProblemReportReservation | undefined> {
  const key = await digestIdentity(
    identity.type === "user"
      ? `user:${identity.userId}`
      : `ip:${identity.ipAddress}`,
    keySecret,
  );
  const windowStart = now.getTime() - reportWindowMs;
  await database.run(sql`
    DELETE FROM problem_report_rate_limits
    WHERE window_started_at <= ${windowStart}
  `);
  const result = await database.run(sql`
    INSERT INTO problem_report_rate_limits (
      key, window_started_at, attempt_count, report_count
    )
    VALUES (${key}, ${now.getTime()}, 1, 1)
    ON CONFLICT(key) DO UPDATE SET
      attempt_count = problem_report_rate_limits.attempt_count + 1,
      report_count = problem_report_rate_limits.report_count + 1
    RETURNING attempt_count, report_count
  `);
  const row = z
    .object({
      attempt_count: z.number().int().nonnegative(),
      report_count: z.number().int().nonnegative(),
    })
    .safeParse(result.results[0]);
  if (
    row.success &&
    row.data.attempt_count <= attemptLimit &&
    row.data.report_count <= reportLimit
  ) {
    return { key };
  }
  await releaseProblemReportReservation(database, { key });
  return undefined;
}

export async function releaseProblemReportReservation(
  database: Database,
  reservation: ProblemReportReservation,
): Promise<void> {
  await database.run(sql`
    UPDATE problem_report_rate_limits
    SET report_count = MAX(0, report_count - 1)
    WHERE key = ${reservation.key}
  `);
}

async function digestIdentity(
  identity: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`problem-report:${identity}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
