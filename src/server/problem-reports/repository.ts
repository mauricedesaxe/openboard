import { sql } from "drizzle-orm";
import { z } from "zod";

import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";

const reportLimit = 3;
const reportWindowMs = 60 * 60 * 1000;

export async function acceptProblemReport(
  database: Database,
  identity:
    { type: "user"; userId: UserId } | { type: "ip"; ipAddress: string },
  now: Date,
): Promise<boolean> {
  const key = await digestIdentity(
    identity.type === "user"
      ? `user:${identity.userId}`
      : `ip:${identity.ipAddress}`,
  );
  const windowStart = now.getTime() - reportWindowMs;
  const result = await database.run(sql`
    INSERT INTO problem_report_rate_limits (key, window_started_at, report_count)
    VALUES (${key}, ${now.getTime()}, 1)
    ON CONFLICT(key) DO UPDATE SET
      window_started_at = CASE
        WHEN problem_report_rate_limits.window_started_at <= ${windowStart}
        THEN ${now.getTime()}
        ELSE problem_report_rate_limits.window_started_at
      END,
      report_count = CASE
        WHEN problem_report_rate_limits.window_started_at <= ${windowStart}
        THEN 1
        ELSE problem_report_rate_limits.report_count + 1
      END
    RETURNING report_count
  `);
  const row = z
    .object({ report_count: z.number().int().nonnegative() })
    .safeParse(result.results[0]);
  return row.success && row.data.report_count <= reportLimit;
}

async function digestIdentity(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
