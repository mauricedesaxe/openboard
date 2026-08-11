import { z } from "zod";

const publicIdSchema = z.string().min(1);
const instantSchema = z.iso.datetime({ offset: true });

export const publishedScheduleSchema = z.object({
  version: z.literal("1.0"),
  revision: z.number().int().positive(),
  publishedAt: instantSchema,
  event: z.object({
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
  }),
  tracks: z.array(
    z.object({
      id: publicIdSchema,
      name: z.string(),
      position: z.number().int(),
    }),
  ),
  rooms: z.array(
    z.object({
      id: publicIdSchema,
      name: z.string(),
      position: z.number().int(),
    }),
  ),
  items: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        id: publicIdSchema,
        kind: z.literal("session"),
        title: z.string(),
        abstract: z.string(),
        format: z.string(),
        trackId: publicIdSchema,
        roomId: publicIdSchema,
        startsAt: instantSchema,
        endsAt: instantSchema,
        calendar: z.object({
          uid: z.string().min(1),
          sequence: z.number().int().nonnegative(),
        }),
        speakers: z.array(
          z.object({
            id: publicIdSchema,
            displayName: z.string(),
            bio: z.string().nullable(),
            headshotUrl: z.url().nullable(),
            position: z.number().int().nonnegative(),
          }),
        ),
      }),
      z.object({
        id: publicIdSchema,
        kind: z.literal("service"),
        title: z.string(),
        roomId: publicIdSchema.nullable(),
        startsAt: instantSchema,
        endsAt: instantSchema,
      }),
    ]),
  ),
});

export type PublishedSchedule = z.infer<typeof publishedScheduleSchema>;
