import { z } from "zod";

import { storedFileUploadSchema } from "./files";

export const speakerHeadshotUploadSchema = storedFileUploadSchema.extend({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

export const speakerProfileInputSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  bio: z.string().trim().max(10_000),
  headshotUrl: z
    .union([
      z.url(),
      z.string().regex(/^\/api\/speaker-headshots\/[0-9a-f-]+$/),
    ])
    .nullable(),
});

export const speakerProfileSchema = speakerProfileInputSchema.extend({
  id: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type SpeakerHeadshotUpload = z.infer<typeof speakerHeadshotUploadSchema>;
export type SpeakerProfileInput = z.infer<typeof speakerProfileInputSchema>;
