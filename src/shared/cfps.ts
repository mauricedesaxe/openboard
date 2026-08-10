import { z } from "zod";

export type CfpId = string & { readonly __brand: "CfpId" };
export type RoomId = string & { readonly __brand: "RoomId" };
export type TrackId = string & { readonly __brand: "TrackId" };

const nameSchema = z
  .string()
  .trim()
  .min(2, "Enter at least 2 characters.")
  .max(120, "Enter no more than 120 characters.");

export const eventOptionNameSchema = nameSchema;

export const visibilityConditionSchema = z.object({
  fieldKey: z.string().min(1).max(64),
  equals: z.string().min(1).max(120),
});

const fieldBase = {
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "Use lowercase letters, numbers, and underscores.",
    ),
  label: nameSchema,
  required: z.boolean(),
  condition: visibilityConditionSchema.optional(),
};

export const customFieldSchema = z.discriminatedUnion("type", [
  z.object({ ...fieldBase, type: z.literal("short_text") }),
  z.object({ ...fieldBase, type: z.literal("long_text") }),
  z.object({
    ...fieldBase,
    type: z.literal("single_select"),
    options: z
      .array(z.string().trim().min(1).max(120))
      .min(2)
      .max(30)
      .refine((options) => new Set(options).size === options.length, {
        message: "Use each option once.",
      }),
  }),
  z.object({
    ...fieldBase,
    type: z.literal("file"),
    acceptedTypes: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
    maxSizeMb: z.number().int().min(1).max(100),
  }),
]);

export const customFieldsSchema = z
  .array(customFieldSchema)
  .max(30)
  .superRefine((fields, context) => {
    const priorFields = new Map<string, (typeof fields)[number]>();

    for (const [index, field] of fields.entries()) {
      if (priorFields.has(field.key)) {
        context.addIssue({
          code: "custom",
          message: "Use each field key once.",
          path: [index, "key"],
        });
      }

      if (field.condition) {
        const source = priorFields.get(field.condition.fieldKey);
        if (source?.type !== "single_select") {
          context.addIssue({
            code: "custom",
            message: "Conditions must use an earlier single-select field.",
            path: [index, "condition", "fieldKey"],
          });
        } else if (!source.options.includes(field.condition.equals)) {
          context.addIssue({
            code: "custom",
            message: "The condition value must be one of the field options.",
            path: [index, "condition", "equals"],
          });
        }
      }

      priorFields.set(field.key, field);
    }
  });

export type CustomField = z.infer<typeof customFieldSchema>;

export const cfpDefinitionInputSchema = z.object({
  name: nameSchema,
  deadline: z.iso.datetime({ offset: true }),
  formats: z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(20)
    .refine((formats) => new Set(formats).size === formats.length, {
      message: "Use each format once.",
    }),
  customFields: customFieldsSchema,
});

export type CfpDefinitionInput = z.infer<typeof cfpDefinitionInputSchema>;

export const cfpStatusSchema = z.enum(["draft", "open", "closed"]);

export const cfpSchema = cfpDefinitionInputSchema.extend({
  id: z.string().transform((value) => value as CfpId),
  status: cfpStatusSchema,
  structureLocked: z.boolean(),
});

export type Cfp = z.infer<typeof cfpSchema>;

export const cfpFormContractSchema = z.object({
  event: z.object({ name: z.string(), slug: z.string(), timezone: z.string() }),
  cfpId: z.string().transform((value) => value as CfpId),
  name: z.string(),
  deadline: z.iso.datetime({ offset: true }),
  coreFields: z.object({
    title: z.object({ required: z.literal(true) }),
    abstract: z.object({ required: z.literal(true) }),
    format: z.object({ required: z.literal(true) }),
    track: z.object({ required: z.literal(true) }),
    proposedSpeakers: z.object({ required: z.literal(true) }),
  }),
  formats: z.array(z.string()),
  tracks: z.array(
    z.object({
      id: z.string().transform((value) => value as TrackId),
      name: z.string(),
    }),
  ),
  customFields: customFieldsSchema,
});

export type CfpFormContract = z.infer<typeof cfpFormContractSchema>;
