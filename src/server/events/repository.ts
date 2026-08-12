import { and, eq, isNull, or } from "drizzle-orm";

import type {
  Event,
  EventAccess,
  EventId,
  EventInput,
  EventPermission,
  UserId,
} from "../../shared/events";
import { defaultCommunicationTemplateValues } from "../communications/repository";
import type { Database } from "../database/client";
import {
  agendas,
  communicationTemplates,
  eventRoles,
  events,
} from "../database/schema";

export type EventWriteResult =
  | { ok: true; value: Event }
  | { ok: false; error: "duplicate_slug" | "persistence_failed" };

export async function createEvent(
  database: Database,
  ownerUserId: UserId,
  input: EventInput,
): Promise<EventWriteResult> {
  const id = crypto.randomUUID() as EventId;
  const agendaId = crypto.randomUUID();
  const now = new Date();

  try {
    await database.batch([
      database.insert(events).values({
        id,
        ownerUserId,
        name: input.name,
        slug: input.slug,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        timezone: input.timezone,
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(agendas).values({
        id: agendaId,
        eventId: id,
        createdAt: now,
        updatedAt: now,
      }),
      database
        .insert(communicationTemplates)
        .values(defaultCommunicationTemplateValues(id, now)),
    ]);
  } catch (error: unknown) {
    if (String(error).includes("UNIQUE constraint failed: events.slug")) {
      return { ok: false, error: "duplicate_slug" };
    }

    return { ok: false, error: "persistence_failed" };
  }

  return {
    ok: true,
    value: {
      ...input,
      id,
      ownerUserId,
      agendaId,
      access: "owner",
      permissions: ["organizer", "reviewer"],
    },
  };
}

export async function findOwnedEvent(
  database: Database,
  ownerUserId: UserId,
  slug: string,
): Promise<Event | undefined> {
  const [row] = await database
    .select({
      id: events.id,
      ownerUserId: events.ownerUserId,
      name: events.name,
      slug: events.slug,
      startsOn: events.startsOn,
      endsOn: events.endsOn,
      timezone: events.timezone,
      agendaId: agendas.id,
    })
    .from(events)
    .innerJoin(agendas, eq(agendas.eventId, events.id))
    .where(and(eq(events.ownerUserId, ownerUserId), eq(events.slug, slug)))
    .limit(1);

  return row
    ? ({
        ...row,
        access: "owner",
        permissions: ["organizer", "reviewer"],
      } as Event)
    : undefined;
}

export async function findEventForUser(
  database: Database,
  userId: UserId,
  slug: string,
): Promise<Event | undefined> {
  const rows = await selectAccessibleEvents(database, userId, slug);
  return combineAccessibleRows(rows, userId)[0];
}

export async function findEventForOrganizer(
  database: Database,
  userId: UserId,
  slug: string,
): Promise<(Event & { agendaRevision: number }) | undefined> {
  const organizerAccess = or(
    eq(events.ownerUserId, userId),
    and(
      eq(eventRoles.userId, userId),
      eq(eventRoles.role, "organizer"),
      isNull(eventRoles.revokedAt),
    ),
  );
  const [result] = await database
    .select({
      id: events.id,
      ownerUserId: events.ownerUserId,
      name: events.name,
      slug: events.slug,
      startsOn: events.startsOn,
      endsOn: events.endsOn,
      timezone: events.timezone,
      agendaId: agendas.id,
      agendaRevision: agendas.revision,
    })
    .from(events)
    .innerJoin(agendas, eq(agendas.eventId, events.id))
    .leftJoin(
      eventRoles,
      and(eq(eventRoles.eventId, events.id), eq(eventRoles.userId, userId)),
    )
    .where(and(organizerAccess, eq(events.slug, slug)))
    .limit(1);
  if (!result) return undefined;
  const eventAccess: EventAccess =
    result.ownerUserId === userId ? "owner" : "organizer";
  return {
    ...result,
    access: eventAccess,
    permissions:
      eventAccess === "owner" ? ["organizer", "reviewer"] : ["organizer"],
  } as Event & {
    agendaRevision: number;
  };
}

export async function listOwnedEvents(
  database: Database,
  ownerUserId: UserId,
): Promise<Event[]> {
  const rows = await database
    .select({
      id: events.id,
      ownerUserId: events.ownerUserId,
      name: events.name,
      slug: events.slug,
      startsOn: events.startsOn,
      endsOn: events.endsOn,
      timezone: events.timezone,
      agendaId: agendas.id,
    })
    .from(events)
    .innerJoin(agendas, eq(agendas.eventId, events.id))
    .where(eq(events.ownerUserId, ownerUserId))
    .orderBy(events.startsOn);

  return rows.map((row) => ({
    ...row,
    access: "owner",
    permissions: ["organizer", "reviewer"],
  })) as Event[];
}

export async function listEventsForUser(
  database: Database,
  userId: UserId,
): Promise<Event[]> {
  const rows = await selectAccessibleEvents(database, userId);
  return combineAccessibleRows(rows, userId);
}

export async function renameOwnedEvent(
  database: Database,
  ownerUserId: UserId,
  slug: string,
  name: string,
): Promise<Event | undefined> {
  const result = await database
    .update(events)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(events.ownerUserId, ownerUserId), eq(events.slug, slug)));

  if (result.meta.changes === 0) {
    return undefined;
  }

  return findOwnedEvent(database, ownerUserId, slug);
}

function selectAccessibleEvents(
  database: Database,
  userId: UserId,
  slug?: string,
) {
  const access = or(
    eq(events.ownerUserId, userId),
    and(eq(eventRoles.userId, userId), isNull(eventRoles.revokedAt)),
  );
  return database
    .select({
      id: events.id,
      ownerUserId: events.ownerUserId,
      name: events.name,
      slug: events.slug,
      startsOn: events.startsOn,
      endsOn: events.endsOn,
      timezone: events.timezone,
      agendaId: agendas.id,
      role: eventRoles.role,
    })
    .from(events)
    .innerJoin(agendas, eq(agendas.eventId, events.id))
    .leftJoin(
      eventRoles,
      and(eq(eventRoles.eventId, events.id), eq(eventRoles.userId, userId)),
    )
    .where(slug ? and(access, eq(events.slug, slug)) : access)
    .orderBy(events.startsOn);
}

function combineAccessibleRows(
  rows: Awaited<ReturnType<typeof selectAccessibleEvents>>,
  userId: UserId,
): Event[] {
  const accessible = new Map<EventId, Event>();
  for (const { role, ...row } of rows) {
    const access: EventAccess =
      row.ownerUserId === userId
        ? "owner"
        : role === "organizer"
          ? "organizer"
          : "reviewer";
    const current = accessible.get(row.id as EventId);
    const permissions = new Set<EventPermission>(current?.permissions ?? []);
    if (row.ownerUserId === userId) {
      permissions.add("organizer");
      permissions.add("reviewer");
    } else if (role) {
      permissions.add(role);
    }
    accessible.set(
      row.id as EventId,
      {
        ...row,
        access:
          current?.access === "owner" || access === "owner"
            ? "owner"
            : current?.access === "organizer" || access === "organizer"
              ? "organizer"
              : "reviewer",
        permissions: [...permissions],
      } as Event,
    );
  }
  return [...accessible.values()];
}
