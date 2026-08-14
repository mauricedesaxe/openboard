import { z } from "zod";

export const MIN_PROBLEM_REPORT_DESCRIPTION_LENGTH = 10;
export const MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH = 500;
export const MIN_PROBLEM_REPORT_COMPLETION_MS = 1_000;
const MAX_PROBLEM_REPORT_COMPLETION_MS = 3_600_000;

export const problemReportInputSchema = z.object({
  contactAllowed: z.boolean(),
  description: z
    .string()
    .trim()
    .min(MIN_PROBLEM_REPORT_DESCRIPTION_LENGTH)
    .max(MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH),
  elapsedMs: z.number().int().min(0).max(MAX_PROBLEM_REPORT_COMPLETION_MS),
  route: z.string().max(300),
  website: z.string().max(200),
});

export function reportRoute(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "invitations" && segments.length >= 2) {
    return "/invitations/:secret";
  }
  if (segments[0] === "speaker-invitations" && segments.length >= 2) {
    return "/speaker-invitations/:secret";
  }
  if (segments[0] === "submissions" && segments.length >= 2) {
    return "/submissions/:submissionId";
  }
  if (segments[0] === "events" && segments.length >= 2) {
    return ["", "events", ":slug", ...segments.slice(2)].join("/");
  }
  if (["/", "/sign-in", "/speaker-profile", "/tasks"].includes(pathname)) {
    return pathname;
  }
  return "/other";
}
