import { z } from "zod";

export type EventId = string & { readonly __brand: "EventId" };
export type RoomId = string & { readonly __brand: "RoomId" };
export type UserId = string & { readonly __brand: "UserId" };
export type EventAccess = "owner" | "organizer" | "reviewer";
export type EventPermission = "organizer" | "reviewer";

export const roomIdSchema = z.uuid().transform((value) => value as RoomId);

const supportedTimezones = new Set([
  "UTC",
  ...Intl.supportedValuesOf("timeZone"),
]);

const eventDetailsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Enter at least 2 characters.")
      .max(120, "Enter no more than 120 characters."),
    startsOn: z.iso.date({ error: "Choose a start date." }),
    endsOn: z.iso.date({ error: "Choose an end date." }),
    timezone: z
      .string()
      .refine(
        (value) => supportedTimezones.has(value),
        "Choose an IANA timezone.",
      ),
  })
  .superRefine(({ startsOn, endsOn }, context) => {
    if (startsOn > endsOn) {
      context.addIssue({
        code: "custom",
        message: "The end date must be on or after the start date.",
        path: ["endsOn"],
      });
    }
  });

const eventSlugSchema = z
  .string()
  .trim()
  .min(3, "Enter at least 3 characters.")
  .max(48, "Enter no more than 48 characters.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers, and hyphens.",
  );

export const eventInputSchema = eventDetailsSchema
  .safeExtend({ slug: eventSlugSchema })
  .superRefine(({ startsOn, timezone }, context) => {
    if (
      supportedTimezones.has(timezone) &&
      startsOn < dateInTimezone(new Date(), timezone)
    ) {
      context.addIssue({
        code: "custom",
        message: "Choose today or a future date.",
        path: ["startsOn"],
      });
    }
  });

export const eventSettingsInputSchema = eventDetailsSchema.safeExtend({
  slug: eventSlugSchema,
});

export function slugifyEventName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

export type EventInput = z.infer<typeof eventInputSchema>;
export type EventSettingsInput = z.infer<typeof eventSettingsInputSchema>;

export const eventSchema = eventSettingsInputSchema.extend({
  id: z.string().transform((value) => value as EventId),
  ownerUserId: z.string().transform((value) => value as UserId),
  agendaId: z.string(),
  access: z.enum(["owner", "organizer", "reviewer"]),
  permissions: z.array(z.enum(["organizer", "reviewer"])),
});

export type Event = z.infer<typeof eventSchema>;

export function listTimezones(): string[] {
  return [
    "UTC",
    ...[...supportedTimezones].filter((timezone) => timezone !== "UTC").sort(),
  ];
}

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: "day" | "month" | "year") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
