import { z } from "zod";

import { eventInputSchema } from "./events";

export type InvitationId = string & { readonly __brand: "InvitationId" };
export type EventRoleId = string & { readonly __brand: "EventRoleId" };

export const eventRoleSchema = z.enum(["organizer", "reviewer"]);
export type EventRole = z.infer<typeof eventRoleSchema>;

export const invitationSecretSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);

export const inviteEventTeamSchema = z.object({
  slug: eventInputSchema.shape.slug,
  email: z.email().trim().toLowerCase(),
  role: eventRoleSchema,
  replacesInvitationId: z
    .string()
    .transform((value) => value as InvitationId)
    .optional(),
});

export const invitationSecretInputSchema = z.object({
  secret: invitationSecretSchema,
});

export const revokeEventRoleSchema = z.object({
  slug: eventInputSchema.shape.slug,
  roleId: z.string().transform((value) => value as EventRoleId),
});

export const revokeInvitationSchema = z.object({
  slug: eventInputSchema.shape.slug,
  invitationId: z.string().transform((value) => value as InvitationId),
});
