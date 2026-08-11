import { z } from "zod";

import { submissionIdSchema } from "./submissions";

export type ReviewerAssignmentId = string & {
  readonly __brand: "ReviewerAssignmentId";
};

export const reviewerAssignmentIdSchema = z
  .uuid()
  .transform((value) => value as ReviewerAssignmentId);
export const reviewScoreSchema = z.number().int().min(1).max(5);
export const decisionQueueStatusSchema = z.enum([
  "pending",
  "accept_queued",
  "decline_queued",
]);
export const queuedDecisionStatusSchema = z.enum([
  "accept_queued",
  "decline_queued",
]);

export const saveReviewSchema = z.object({
  assignmentId: reviewerAssignmentIdSchema,
  score: reviewScoreSchema,
  comment: z.string().trim().max(5_000).nullable(),
});

export const decisionPublicationSchema = z.object({
  slug: z.string().min(1),
  selections: z
    .array(
      z.object({
        submissionId: submissionIdSchema,
        expectedStatus: queuedDecisionStatusSchema,
        expectedRevision: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .refine(
      (selections) =>
        new Set(selections.map((selection) => selection.submissionId)).size ===
        selections.length,
      "Select each proposal once.",
    ),
});

export type DecisionPublicationInput = z.infer<
  typeof decisionPublicationSchema
>;
