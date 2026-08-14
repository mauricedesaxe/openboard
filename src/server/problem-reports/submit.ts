import type { UserId } from "../../shared/events";
import {
  MINIMUM_PROBLEM_REPORT_FORM_OPEN_DURATION_MS,
  reportRoute,
  type ProblemReportInput,
} from "../../shared/problem-reports";
import type { AppConfig } from "../config";
import type { Database } from "../database/client";

import { deliverProblemReport } from "./delivery";
import {
  releaseProblemReportReservation,
  reserveProblemReport,
} from "./repository";

type SubmitProblemReportResult =
  | { status: "accepted" }
  | { status: "automated" }
  | { status: "rate_limited" }
  | { status: "delivery_failed" };

export async function submitProblemReport(input: {
  config: AppConfig;
  database: Database;
  identity:
    { type: "user"; userId: UserId } | { type: "ip"; ipAddress: string };
  now: Date;
  report: ProblemReportInput;
}): Promise<SubmitProblemReportResult> {
  if (looksAutomated(input.report)) return { status: "automated" };

  const reservation = await reserveProblemReport(
    input.database,
    input.identity,
    input.config.authSecret,
    input.now,
  );
  if (!reservation) return { status: "rate_limited" };

  const route = reportRoute(input.report.route);
  const userId =
    input.identity.type === "user" ? input.identity.userId : undefined;
  const report = {
    contactAllowed: input.report.contactAllowed && Boolean(userId),
    description: input.report.description,
    environment: input.config.appEnv,
    release: input.config.release,
    reportedAt: input.now.toISOString(),
    route,
    ...(userId ? { userId } : {}),
  };
  const delivery = await deliverProblemReport(input.config, report);
  if (!delivery.ok) {
    await releaseProblemReportReservation(input.database, reservation);
    console.error(
      JSON.stringify({
        event: "problem_report_delivery_failed",
        environment: report.environment,
        release: report.release,
        route,
      }),
    );
    return { status: "delivery_failed" };
  }

  console.log(
    JSON.stringify({
      event: "problem_reported",
      environment: report.environment,
      release: report.release,
      route,
      signedIn: Boolean(userId),
    }),
  );
  return { status: "accepted" };
}

function looksAutomated(input: ProblemReportInput): boolean {
  return (
    Boolean(input.honeypotWebsite) ||
    input.formOpenDurationMs < MINIMUM_PROBLEM_REPORT_FORM_OPEN_DURATION_MS
  );
}
