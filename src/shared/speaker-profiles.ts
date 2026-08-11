import { z } from "zod";

export const speakerProfileInputSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  bio: z.string().trim().min(10).max(10_000),
  headshotUrl: z.url().nullable(),
});

export const speakerProfileSchema = speakerProfileInputSchema.extend({
  id: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type SpeakerProfileInput = z.infer<typeof speakerProfileInputSchema>;
