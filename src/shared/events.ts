import { z } from "zod";

export type EventId = string & { readonly __brand: "EventId" };
export type UserId = string & { readonly __brand: "UserId" };

const supportedTimezones = new Set([
  "UTC",
  ...Intl.supportedValuesOf("timeZone"),
]);

export const eventInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Enter at least 2 characters.")
      .max(120, "Enter no more than 120 characters."),
    slug: z
      .string()
      .trim()
      .min(3, "Enter at least 3 characters.")
      .max(48, "Enter no more than 48 characters.")
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase letters, numbers, and hyphens.",
      ),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    timezone: z
      .string()
      .refine(
        (value) => supportedTimezones.has(value),
        "Choose an IANA timezone.",
      ),
  })
  .refine(({ startsOn, endsOn }) => startsOn <= endsOn, {
    message: "The end date must be on or after the start date.",
    path: ["endsOn"],
  });

export type EventInput = z.infer<typeof eventInputSchema>;

export const eventSchema = eventInputSchema.extend({
  id: z.string().transform((value) => value as EventId),
  ownerUserId: z.string().transform((value) => value as UserId),
  agendaId: z.string(),
});

export type Event = z.infer<typeof eventSchema>;

export function listTimezones(): string[] {
  return [...supportedTimezones].sort();
}
