import { and, eq } from "drizzle-orm";

import type { Event, EventId, EventInput, UserId } from "../../shared/events";
import type { Database } from "../database/client";
import { agendas, events } from "../database/schema";

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
    ]);
  } catch (error: unknown) {
    if (String(error).includes("UNIQUE constraint failed: events.slug")) {
      return { ok: false, error: "duplicate_slug" };
    }

    return { ok: false, error: "persistence_failed" };
  }

  return {
    ok: true,
    value: { ...input, id, ownerUserId, agendaId },
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

  return row as Event | undefined;
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

  return rows as Event[];
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
