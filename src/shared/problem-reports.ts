import { z } from "zod";

export const MIN_PROBLEM_REPORT_DESCRIPTION_LENGTH = 10;
export const MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH = 500;
export const MINIMUM_PROBLEM_REPORT_FORM_OPEN_DURATION_MS = 1_000;
const MAXIMUM_PROBLEM_REPORT_FORM_OPEN_DURATION_MS = 3_600_000;

export const problemReportInputSchema = z.object({
  contactAllowed: z.boolean(),
  contactEmail: z
    .string()
    .trim()
    .pipe(
      z.union([
        z.literal(""),
        z.email().transform((email) => email.toLowerCase()),
      ]),
    ),
  description: z
    .string()
    .trim()
    .min(MIN_PROBLEM_REPORT_DESCRIPTION_LENGTH)
    .max(MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH),
  formOpenDurationMs: z
    .number()
    .int()
    .min(0)
    .max(MAXIMUM_PROBLEM_REPORT_FORM_OPEN_DURATION_MS),
  route: z.string().max(300),
  honeypotWebsite: z.string().max(200),
});

export type ProblemReportInput = z.infer<typeof problemReportInputSchema>;

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
