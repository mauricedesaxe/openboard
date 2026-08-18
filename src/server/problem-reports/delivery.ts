import type { UserId } from "../../shared/events";
import type { AppConfig } from "../config";

export type ProblemReport = {
  contactAllowed: boolean;
  contactEmail?: string;
  description: string;
  environment: string;
  release: string;
  reportedAt: string;
  route: string;
  userId?: UserId;
};

type DeliveryResult =
  { ok: true } | { ok: false; reason: "configuration" | "delivery" };

const capturedReports: ProblemReport[] = [];
const PROBLEM_REPORT_DELIVERY_TIMEOUT_MS = 10_000;

export async function deliverProblemReport(
  config: AppConfig,
  report: ProblemReport,
  request: typeof fetch = fetch,
): Promise<DeliveryResult> {
  if (config.problemReports.type === "capture") {
    capturedReports.push(structuredClone(report));
    return { ok: true };
  }
  if (config.problemReports.type === "unavailable") {
    return { ok: false, reason: "configuration" };
  }

  try {
    const response = await request(
      "https://uptime.betterstack.com/api/v3/incidents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.problemReports.apiToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(PROBLEM_REPORT_DELIVERY_TIMEOUT_MS),
        body: JSON.stringify({
          description: formatIncidentDescription(report),
          email: true,
          name: "OpenBoard user report",
          ...(config.problemReports.policyId
            ? { policy_id: config.problemReports.policyId }
            : {}),
          requester_email: config.problemReports.requesterEmail,
          summary: `User reported a problem on ${report.route}`,
        }),
      },
    );
    if (!response.ok) return { ok: false, reason: "delivery" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "delivery" };
  }
}

export function getCapturedProblemReports(): readonly ProblemReport[] {
  return capturedReports;
}

function formatIncidentDescription(report: ProblemReport): string {
  return [
    "A user reported a production problem.",
    "",
    `Description: ${redactSensitiveText(report.description)}`,
    `Route: ${report.route}`,
    `Release: ${report.release}`,
    `Timestamp: ${report.reportedAt}`,
    `Environment: ${report.environment}`,
    `User ID: ${report.userId ?? "signed out"}`,
    `Contact allowed: ${report.contactAllowed && (report.userId || report.contactEmail) ? "yes" : "no"}`,
    `Contact email: ${report.contactEmail ?? "none"}`,
  ].join("\n");
}

export function redactSensitiveText(value: string): string {
  const redacted = value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]")
    .replace(/\b\d{6}\b/g, "[redacted code]");
  return Array.from(redacted, (character) => {
    const code = character.charCodeAt(0);
    const safeWhitespace =
      character === "\t" || character === "\n" || character === "\r";
    return code < 32 && !safeWhitespace ? " " : character;
  }).join("");
}
