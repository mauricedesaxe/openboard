import { z } from "zod";

import { storedFileUploadSchema } from "./files";

export const speakerHeadshotUploadSchema = storedFileUploadSchema.extend({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

export const speakerProfileInputSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  bio: z.string().trim().max(10_000).default(""),
});

export const saveSpeakerProfileSchema = speakerProfileInputSchema.extend({
  expectedRevision: z.number().int().positive().nullable(),
  headshot: speakerHeadshotUploadSchema.optional(),
});

export const speakerHeadshotUrlSchema = z.union([
  z.url(),
  z.string().regex(/^\/api\/speaker-headshots\/[0-9a-f-]+$/),
]);

export const speakerProfileSchema = speakerProfileInputSchema.extend({
  id: z.uuid(),
  headshotUrl: speakerHeadshotUrlSchema.nullable(),
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type SpeakerHeadshotUpload = z.infer<typeof speakerHeadshotUploadSchema>;
export type SpeakerProfileInput = z.infer<typeof speakerProfileInputSchema>;
export type SaveSpeakerProfileInput = z.infer<typeof saveSpeakerProfileSchema>;
