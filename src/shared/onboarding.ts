import { z } from "zod";

import type { speakerProfileInputSchema } from "./speaker-profiles";

export type TaskDefinitionId = string & {
  readonly __brand: "TaskDefinitionId";
};
export type TaskAssignmentId = string & {
  readonly __brand: "TaskAssignmentId";
};
export type TaskEvidenceId = string & {
  readonly __brand: "TaskEvidenceId";
};

export const MAX_TASK_FILE_BYTES = 10_000_000;
const MAX_TASK_FILE_BASE64_LENGTH = Math.ceil(MAX_TASK_FILE_BYTES / 3) * 4;

export const taskDefinitionIdSchema = z
  .uuid()
  .transform((value) => value as TaskDefinitionId);
export const taskAssignmentIdSchema = z
  .uuid()
  .transform((value) => value as TaskAssignmentId);
export const taskEvidenceIdSchema = z
  .uuid()
  .transform((value) => value as TaskEvidenceId);
export const taskScopeSchema = z.enum([
  "event_speaker",
  "program_item",
  "program_item_speaker",
]);
export const completionMechanismSchema = z.enum([
  "manual",
  "profile",
  "form",
  "file",
]);
export const profileRequirementSchema = z.enum(["complete", "bio", "headshot"]);
export const onboardingFormFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().trim().min(1).max(200),
  type: z.enum(["short_text", "long_text"]),
  required: z.boolean(),
});

export const createTaskDefinitionSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    scope: taskScopeSchema,
    completionMechanism: completionMechanismSchema,
    profileRequirement: profileRequirementSchema.nullable().default(null),
    formFields: z
      .array(onboardingFormFieldSchema)
      .max(30)
      .nullable()
      .default(null),
  })
  .superRefine((input, context) => {
    if (
      input.completionMechanism === "profile" &&
      input.scope !== "event_speaker"
    ) {
      context.addIssue({
        code: "custom",
        message: "Profile tasks must use event-speaker scope.",
      });
    }
    if (input.completionMechanism === "profile" && !input.profileRequirement) {
      context.addIssue({
        code: "custom",
        message: "Choose a profile requirement.",
      });
    }
    if (input.completionMechanism === "form" && !input.formFields) {
      context.addIssue({
        code: "custom",
        message: "Add the onboarding form fields.",
      });
    }
    if (
      input.completionMechanism !== "profile" &&
      input.profileRequirement !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Only profile tasks use a profile requirement.",
      });
    }
    if (input.completionMechanism !== "form" && input.formFields !== null) {
      context.addIssue({
        code: "custom",
        message: "Only form tasks use form fields.",
      });
    }
  });

export const taskTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("event_speaker"), userId: z.string().min(1) }),
  z.object({ scope: z.literal("program_item"), programItemId: z.uuid() }),
  z.object({
    scope: z.literal("program_item_speaker"),
    submissionSpeakerId: z.uuid(),
  }),
]);

export const createTaskAssignmentSchema = z.object({
  slug: z.string().min(1),
  taskDefinitionId: taskDefinitionIdSchema,
  target: taskTargetSchema,
  required: z.boolean(),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
});

export const assignmentInputSchema = z.object({
  assignmentId: taskAssignmentIdSchema,
});
export const assignmentReasonSchema = assignmentInputSchema.extend({
  reason: z.string().trim().min(1).max(2_000),
});
export const rejectEvidenceSchema = z.object({
  evidenceId: taskEvidenceIdSchema,
  reason: z.string().trim().min(1).max(2_000),
});
export const saveOnboardingFormSchema = assignmentInputSchema.extend({
  answers: z.record(z.string(), z.string()),
});
export const taskFileUploadSchema = assignmentInputSchema.extend({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  contentBase64: z.string().min(1).max(MAX_TASK_FILE_BASE64_LENGTH),
});

export function profileSatisfiesRequirement(
  profile: z.infer<typeof speakerProfileInputSchema>,
  requirement: z.infer<typeof profileRequirementSchema>,
): boolean {
  if (requirement === "headshot") return Boolean(profile.headshotUrl);
  if (requirement === "bio") return profile.bio.trim().length > 0;
  return profile.displayName.trim().length > 0 && profile.bio.trim().length > 0;
}

export type CreateTaskDefinitionInput = z.infer<
  typeof createTaskDefinitionSchema
>;
export type CreateTaskAssignmentInput = z.infer<
  typeof createTaskAssignmentSchema
>;
