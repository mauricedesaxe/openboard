import { z } from "zod";

import { customFieldsSchema, type CfpId, type TrackId } from "./cfps";

export type SubmissionId = string & { readonly __brand: "SubmissionId" };

export const submissionIdSchema = z
  .uuid()
  .transform((value) => value as SubmissionId);

export const proposedSpeakerInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((email) => email.trim().toLowerCase()),
});

export const proposalAnswersSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]*$/),
  z.string().max(20_000),
);

export const proposalContentSchema = z.object({
  title: z.string().trim().min(2).max(200),
  abstract: z.string().trim().min(10).max(10_000),
  format: z.string().trim().min(1).max(80),
  trackId: z.uuid().transform((value) => value as TrackId),
  proposedSpeakers: z.array(proposedSpeakerInputSchema).min(1).max(20),
  customAnswers: proposalAnswersSchema,
});

export const submitProposalSchema = proposalContentSchema.extend({
  slug: z.string().min(1),
  cfpId: z.uuid().transform((value) => value as CfpId),
  clientDraftId: z.uuid(),
});

export type ProposalContent = z.infer<typeof proposalContentSchema>;
export type SubmitProposalInput = z.infer<typeof submitProposalSchema>;

export const proposalDraftSchema = z.object({
  clientDraftId: z.uuid(),
  submitAfterSignIn: z.boolean().default(false),
  step: z.number().int().min(0).max(2),
  coreAnswers: z.object({
    abstract: z.string(),
    format: z.string(),
    speakerEmail: z.string(),
    speakerName: z.string(),
    title: z.string(),
    track: z.string(),
  }),
  customAnswers: z.record(z.string(), z.string()),
});

export type ProposalDraft = z.infer<typeof proposalDraftSchema>;

export const submissionSchema = z.object({
  id: submissionIdSchema,
  status: z.enum(["active", "withdrawn"]),
  event: z.object({ name: z.string(), slug: z.string() }),
  cfp: z.object({
    id: z.string().transform((value) => value as CfpId),
    name: z.string(),
  }),
  title: z.string(),
  abstract: z.string(),
  format: z.string(),
  track: z.object({
    id: z.string().transform((value) => value as TrackId),
    name: z.string(),
  }),
  form: z.object({
    deadline: z.iso.datetime({ offset: true }),
    formats: z.array(z.string()),
    tracks: z.array(
      z.object({
        id: z.string().transform((value) => value as TrackId),
        name: z.string(),
        archived: z.boolean(),
      }),
    ),
    customFields: customFieldsSchema,
  }),
  proposedSpeakers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.email(),
    }),
  ),
  customAnswers: proposalAnswersSchema,
  decision: z.object({
    status: z.enum([
      "pending",
      "accept_queued",
      "decline_queued",
      "accepted",
      "declined",
    ]),
  }),
  confirmation: z.object({ status: z.literal("recorded") }),
  permissions: z.object({ canEdit: z.boolean(), canWithdraw: z.boolean() }),
});

export type Submission = z.infer<typeof submissionSchema>;
