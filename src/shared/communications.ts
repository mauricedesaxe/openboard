import { z } from "zod";

export const communicationPurposeSchema = z.enum([
  "submission_confirmation",
  "decision_acceptance",
  "decision_decline",
  "task_reminder",
  "agenda_invitation",
  "agenda_update",
  "agenda_cancellation",
]);

export type CommunicationPurpose = z.infer<typeof communicationPurposeSchema>;

export const updateCommunicationTemplateSchema = z.object({
  slug: z.string().min(1),
  purpose: communicationPurposeSchema,
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  expectedRevision: z.number().int().positive(),
});

export const retryCommunicationSchema = z.object({
  slug: z.string().min(1),
  communicationId: z.string().min(1),
});
