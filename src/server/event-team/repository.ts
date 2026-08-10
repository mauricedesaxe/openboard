import { and, desc, eq, gt, isNull, or } from "drizzle-orm";

import type {
  EventRole,
  EventRoleId,
  InvitationId,
} from "../../shared/event-team";
import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";
import {
  eventRoles,
  events,
  invitations,
  reviewerAssignments,
  user,
} from "../database/schema";

const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export type CreateInvitationResult =
  | {
      ok: true;
      value: {
        id: InvitationId;
        email: string;
        eventName: string;
        role: EventRole;
        secret: string;
        expiresAt: Date;
      };
    }
  | {
      ok: false;
      error:
        | "event_not_found"
        | "invitation_not_replaceable"
        | "role_already_granted"
        | "persistence_failed";
    };

export async function createInvitation(
  database: Database,
  ownerUserId: UserId,
  input: {
    slug: string;
    email: string;
    role: EventRole;
    replacesInvitationId?: InvitationId | undefined;
  },
): Promise<CreateInvitationResult> {
  const [event] = await database
    .select({ id: events.id, name: events.name })
    .from(events)
    .where(
      and(eq(events.slug, input.slug), eq(events.ownerUserId, ownerUserId)),
    )
    .limit(1);
  if (!event) return { ok: false, error: "event_not_found" };

  if (input.replacesInvitationId) {
    const [replaced] = await database
      .select({ id: invitations.id, status: invitations.status })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, input.replacesInvitationId),
          eq(invitations.eventId, event.id),
        ),
      )
      .limit(1);
    if (!replaced || replaced.status !== "pending") {
      return { ok: false, error: "invitation_not_replaceable" };
    }
  }

  const [existingRole] = await database
    .select({ id: eventRoles.id })
    .from(eventRoles)
    .innerJoin(user, eq(user.id, eventRoles.userId))
    .where(
      and(
        eq(eventRoles.eventId, event.id),
        eq(user.email, input.email),
        eq(eventRoles.role, input.role),
        isNull(eventRoles.revokedAt),
      ),
    )
    .limit(1);
  if (existingRole) return { ok: false, error: "role_already_granted" };

  const id = crypto.randomUUID() as InvitationId;
  const secret = createInvitationSecret();
  const secretHash = await hashInvitationSecret(secret);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + invitationLifetimeMs);

  try {
    await database.batch([
      database
        .update(invitations)
        .set({ status: "revoked", resolvedAt: now })
        .where(
          input.replacesInvitationId
            ? and(
                eq(invitations.eventId, event.id),
                eq(invitations.status, "pending"),
                or(
                  eq(invitations.id, input.replacesInvitationId),
                  and(
                    eq(invitations.email, input.email),
                    eq(invitations.role, input.role),
                  ),
                ),
              )
            : and(
                eq(invitations.eventId, event.id),
                eq(invitations.email, input.email),
                eq(invitations.role, input.role),
                eq(invitations.status, "pending"),
              ),
        ),
      database.insert(invitations).values({
        id,
        eventId: event.id,
        email: input.email,
        role: input.role,
        secretHash,
        status: "pending",
        invitedByUserId: ownerUserId,
        replacementForInvitationId: input.replacesInvitationId,
        expiresAt,
        createdAt: now,
      }),
    ]);
  } catch {
    return { ok: false, error: "persistence_failed" };
  }

  return {
    ok: true,
    value: {
      id,
      email: input.email,
      eventName: event.name,
      role: input.role,
      secret,
      expiresAt,
    },
  };
}

export async function listEventTeam(
  database: Database,
  ownerUserId: UserId,
  slug: string,
) {
  const [event] = await database
    .select({ id: events.id, ownerUserId: events.ownerUserId })
    .from(events)
    .where(and(eq(events.slug, slug), eq(events.ownerUserId, ownerUserId)))
    .limit(1);
  if (!event) return undefined;

  const [owner] = await database
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, event.ownerUserId))
    .limit(1);
  const roles = await database
    .select({
      id: eventRoles.id,
      userId: eventRoles.userId,
      email: user.email,
      name: user.name,
      role: eventRoles.role,
      createdAt: eventRoles.createdAt,
    })
    .from(eventRoles)
    .innerJoin(user, eq(user.id, eventRoles.userId))
    .where(and(eq(eventRoles.eventId, event.id), isNull(eventRoles.revokedAt)))
    .orderBy(eventRoles.createdAt);
  const invitationHistory = await database
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.eventId, event.id))
    .orderBy(desc(invitations.createdAt));

  const now = Date.now();
  return {
    owner,
    roles: roles.map((role) => ({
      ...role,
      createdAt: role.createdAt.toISOString(),
    })),
    invitations: invitationHistory.map((invitation) => ({
      ...invitation,
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
      usable:
        invitation.status === "pending" && invitation.expiresAt.getTime() > now,
    })),
  };
}

type InvitationLookupValue = {
  id: InvitationId;
  email: string;
  eventName: string;
  eventSlug: string;
  role: EventRole;
  expiresAt: Date;
};

export type InvitationLookupResult =
  | { ok: true; value: InvitationLookupValue }
  | { ok: false; error: "not_found" | "unavailable" };

export async function findUsableInvitation(
  database: Database,
  secret: string,
): Promise<InvitationLookupResult> {
  const secretHash = await hashInvitationSecret(secret);
  const [invitation] = await database
    .select({
      id: invitations.id,
      email: invitations.email,
      eventName: events.name,
      eventSlug: events.slug,
      role: invitations.role,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .innerJoin(events, eq(events.id, invitations.eventId))
    .where(eq(invitations.secretHash, secretHash))
    .limit(1);
  if (!invitation) return { ok: false, error: "not_found" };
  if (
    invitation.status !== "pending" ||
    invitation.expiresAt.getTime() <= Date.now()
  ) {
    return { ok: false, error: "unavailable" };
  }

  return {
    ok: true,
    value: {
      id: invitation.id as InvitationId,
      email: invitation.email,
      eventName: invitation.eventName,
      eventSlug: invitation.eventSlug,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    },
  };
}

export async function declineInvitation(
  database: Database,
  secret: string,
): Promise<InvitationLookupResult> {
  const invitation = await findUsableInvitation(database, secret);
  if (!invitation.ok) return invitation;

  const result = await database
    .update(invitations)
    .set({ status: "declined", resolvedAt: new Date() })
    .where(
      and(
        eq(invitations.id, invitation.value.id),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    );
  return result.meta.changes === 1
    ? invitation
    : { ok: false, error: "unavailable" };
}

export type AcceptInvitationResult =
  | { ok: true; value: { eventSlug: string; role: EventRole } }
  | {
      ok: false;
      error:
        "not_found" | "unavailable" | "email_mismatch" | "unverified_email";
    };

export async function acceptInvitation(
  database: Database,
  recipient: { id: UserId; email: string; emailVerified: boolean },
  secret: string,
): Promise<AcceptInvitationResult> {
  if (!recipient.emailVerified) return { ok: false, error: "unverified_email" };
  const invitation = await findUsableInvitation(database, secret);
  if (!invitation.ok) return invitation;
  if (invitation.value.email !== recipient.email.trim().toLowerCase()) {
    return { ok: false, error: "email_mismatch" };
  }

  const [record] = await database
    .select({
      eventId: invitations.eventId,
      invitedByUserId: invitations.invitedByUserId,
    })
    .from(invitations)
    .where(eq(invitations.id, invitation.value.id))
    .limit(1);
  if (!record) return { ok: false, error: "not_found" };

  const [existingRole] = await database
    .select({ id: eventRoles.id })
    .from(eventRoles)
    .where(
      and(
        eq(eventRoles.eventId, record.eventId),
        eq(eventRoles.userId, recipient.id),
        eq(eventRoles.role, invitation.value.role),
        isNull(eventRoles.revokedAt),
      ),
    )
    .limit(1);
  const now = new Date();
  const accept = database
    .update(invitations)
    .set({
      status: "accepted",
      acceptedByUserId: recipient.id,
      resolvedAt: now,
    })
    .where(
      and(
        eq(invitations.id, invitation.value.id),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    );

  try {
    if (existingRole) {
      const result = await accept;
      if (result.meta.changes !== 1) {
        return { ok: false, error: "unavailable" };
      }
    } else {
      await database.batch([
        accept,
        database.insert(eventRoles).values({
          id: crypto.randomUUID() as EventRoleId,
          eventId: record.eventId,
          userId: recipient.id,
          role: invitation.value.role,
          invitationId: invitation.value.id,
          grantedByUserId: record.invitedByUserId,
          createdAt: now,
        }),
      ]);
    }
  } catch {
    return { ok: false, error: "unavailable" };
  }

  return {
    ok: true,
    value: {
      eventSlug: invitation.value.eventSlug,
      role: invitation.value.role,
    },
  };
}

export async function revokeEventRole(
  database: Database,
  ownerUserId: UserId,
  slug: string,
  roleId: EventRoleId,
): Promise<boolean> {
  const [role] = await database
    .select({
      id: eventRoles.id,
      eventId: eventRoles.eventId,
      userId: eventRoles.userId,
      role: eventRoles.role,
    })
    .from(eventRoles)
    .innerJoin(events, eq(events.id, eventRoles.eventId))
    .where(
      and(
        eq(eventRoles.id, roleId),
        eq(events.slug, slug),
        eq(events.ownerUserId, ownerUserId),
        isNull(eventRoles.revokedAt),
      ),
    )
    .limit(1);
  if (!role) return false;

  const now = new Date();
  const revokeRole = database
    .update(eventRoles)
    .set({ revokedAt: now, revokedByUserId: ownerUserId })
    .where(and(eq(eventRoles.id, role.id), isNull(eventRoles.revokedAt)));
  if (role.role === "reviewer") {
    await database.batch([
      revokeRole,
      database
        .update(reviewerAssignments)
        .set({ revokedAt: now, revokedByUserId: ownerUserId })
        .where(
          and(
            eq(reviewerAssignments.eventId, role.eventId),
            eq(reviewerAssignments.reviewerUserId, role.userId),
            isNull(reviewerAssignments.revokedAt),
          ),
        ),
    ]);
  } else {
    await revokeRole;
  }
  return true;
}

export async function revokeInvitation(
  database: Database,
  ownerUserId: UserId,
  slug: string,
  invitationId: InvitationId,
): Promise<boolean> {
  const [invitation] = await database
    .select({ id: invitations.id })
    .from(invitations)
    .innerJoin(events, eq(events.id, invitations.eventId))
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.status, "pending"),
        eq(events.slug, slug),
        eq(events.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (!invitation) return false;

  const result = await database
    .update(invitations)
    .set({ status: "revoked", resolvedAt: new Date() })
    .where(
      and(eq(invitations.id, invitation.id), eq(invitations.status, "pending")),
    );
  return result.meta.changes === 1;
}

function createInvitationSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashInvitationSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
