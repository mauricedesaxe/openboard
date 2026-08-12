import { z } from "zod";

import { eventInputSchema, roomIdSchema } from "./events";

export type AgendaItemId = string & { readonly __brand: "AgendaItemId" };
export type ProgramItemId = string & { readonly __brand: "ProgramItemId" };

export const agendaItemIdSchema = z
  .uuid()
  .transform((value) => value as AgendaItemId);
export const programItemIdSchema = z
  .uuid()
  .transform((value) => value as ProgramItemId);
export const agendaLocalDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

const agendaTimeRangeSchema = z.object({
  startsAtLocal: agendaLocalDateTimeSchema,
  endsAtLocal: agendaLocalDateTimeSchema,
});

export const placeProgramItemSchema = agendaTimeRangeSchema.extend({
  slug: eventInputSchema.shape.slug,
  programItemId: programItemIdSchema,
  roomId: roomIdSchema.nullable(),
});

export const placeServiceBlockSchema = agendaTimeRangeSchema.extend({
  slug: eventInputSchema.shape.slug,
  title: z.string().trim().min(1).max(160),
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("event") }),
    z.object({ type: z.literal("room"), roomId: roomIdSchema }),
  ]),
});

export const moveAgendaItemSchema = agendaTimeRangeSchema.extend({
  slug: eventInputSchema.shape.slug,
  agendaItemId: agendaItemIdSchema,
  roomId: roomIdSchema.nullable(),
});

export const updateServiceBlockSchema = agendaTimeRangeSchema.extend({
  slug: eventInputSchema.shape.slug,
  agendaItemId: agendaItemIdSchema,
  title: z.string().trim().min(1).max(160),
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("event") }),
    z.object({ type: z.literal("room"), roomId: roomIdSchema }),
  ]),
});

export const agendaItemActionSchema = z.object({
  slug: eventInputSchema.shape.slug,
  agendaItemId: agendaItemIdSchema,
});

export const publishAgendaSchema = z.object({
  slug: eventInputSchema.shape.slug,
  expectedRevision: z.number().int().nonnegative(),
});

export type PlaceProgramItemInput = z.infer<typeof placeProgramItemSchema>;
export type PlaceServiceBlockInput = z.infer<typeof placeServiceBlockSchema>;
export type MoveAgendaItemInput = z.infer<typeof moveAgendaItemSchema>;
export type UpdateServiceBlockInput = z.infer<typeof updateServiceBlockSchema>;
export type PublishAgendaInput = z.infer<typeof publishAgendaSchema>;
