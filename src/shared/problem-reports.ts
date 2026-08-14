import { z } from "zod";

export const problemReportInputSchema = z.object({
  contactAllowed: z.boolean(),
  description: z.string().trim().min(10).max(500),
  elapsedMs: z.number().int().min(0).max(3_600_000),
  route: z.string().max(300),
  website: z.string().max(200),
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
