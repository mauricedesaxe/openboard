import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { RoomId, TrackId } from "../../shared/cfps";
import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";
import { rooms, tracks } from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

type EventOption = {
  id: RoomId | TrackId;
  name: string;
  position: number;
};

type OptionKind = "room" | "track";

export async function listTracks(
  database: Database,
  userId: UserId,
  slug: string,
): Promise<EventOption[] | undefined> {
  return listEventOptions(database, userId, slug, "track");
}

export async function createTrack(
  database: Database,
  userId: UserId,
  slug: string,
  name: string,
): Promise<EventOption | undefined> {
  return createEventOption(database, userId, slug, "track", name);
}

export async function updateTrack(
  database: Database,
  userId: UserId,
  slug: string,
  id: TrackId,
  name: string,
): Promise<EventOption | undefined> {
  return updateEventOption(database, userId, slug, "track", id, name);
}

export async function archiveTrack(
  database: Database,
  userId: UserId,
  slug: string,
  id: TrackId,
): Promise<boolean> {
  return archiveEventOption(database, userId, slug, "track", id);
}

export async function reorderTracks(
  database: Database,
  userId: UserId,
  slug: string,
  orderedIds: TrackId[],
): Promise<"ok" | "not_found" | "invalid_order"> {
  return reorderEventOptions(database, userId, slug, "track", orderedIds);
}

export async function listRooms(
  database: Database,
  userId: UserId,
  slug: string,
): Promise<EventOption[] | undefined> {
  return listEventOptions(database, userId, slug, "room");
}

export async function createRoom(
  database: Database,
  userId: UserId,
  slug: string,
  name: string,
): Promise<EventOption | undefined> {
  return createEventOption(database, userId, slug, "room", name);
}

export async function updateRoom(
  database: Database,
  userId: UserId,
  slug: string,
  id: RoomId,
  name: string,
): Promise<EventOption | undefined> {
  return updateEventOption(database, userId, slug, "room", id, name);
}

export async function archiveRoom(
  database: Database,
  userId: UserId,
  slug: string,
  id: RoomId,
): Promise<boolean> {
  return archiveEventOption(database, userId, slug, "room", id);
}

export async function reorderRooms(
  database: Database,
  userId: UserId,
  slug: string,
  orderedIds: RoomId[],
): Promise<"ok" | "not_found" | "invalid_order"> {
  return reorderEventOptions(database, userId, slug, "room", orderedIds);
}

async function listEventOptions(
  database: Database,
  userId: UserId,
  slug: string,
  kind: OptionKind,
): Promise<EventOption[] | undefined> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return undefined;

  const rows =
    kind === "track"
      ? await database
          .select({
            id: tracks.id,
            name: tracks.name,
            position: tracks.position,
          })
          .from(tracks)
          .where(and(eq(tracks.eventId, event.id), isNull(tracks.archivedAt)))
          .orderBy(asc(tracks.position))
      : await database
          .select({ id: rooms.id, name: rooms.name, position: rooms.position })
          .from(rooms)
          .where(and(eq(rooms.eventId, event.id), isNull(rooms.archivedAt)))
          .orderBy(asc(rooms.position));

  return rows as EventOption[];
}

async function createEventOption(
  database: Database,
  userId: UserId,
  slug: string,
  kind: OptionKind,
  name: string,
): Promise<EventOption | undefined> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return undefined;

  const id = crypto.randomUUID() as RoomId | TrackId;
  const now = Date.now();

  if (kind === "track") {
    await database.run(sql`
      INSERT INTO tracks (id, event_id, name, position, created_at, updated_at)
      SELECT ${id}, ${event.id}, ${name}, COALESCE(MAX(position), -1) + 1, ${now}, ${now}
      FROM tracks
      WHERE event_id = ${event.id}
    `);
  } else {
    await database.run(sql`
      INSERT INTO rooms (id, event_id, name, position, created_at, updated_at)
      SELECT ${id}, ${event.id}, ${name}, COALESCE(MAX(position), -1) + 1, ${now}, ${now}
      FROM rooms
      WHERE event_id = ${event.id}
    `);
  }

  return findEventOption(database, event.id, kind, id);
}

async function updateEventOption(
  database: Database,
  userId: UserId,
  slug: string,
  kind: OptionKind,
  id: RoomId | TrackId,
  name: string,
): Promise<EventOption | undefined> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return undefined;

  const now = new Date();
  if (kind === "track") {
    await database
      .update(tracks)
      .set({ name, updatedAt: now })
      .where(
        and(
          eq(tracks.id, id),
          eq(tracks.eventId, event.id),
          isNull(tracks.archivedAt),
        ),
      );
  } else {
    await database
      .update(rooms)
      .set({ name, updatedAt: now })
      .where(
        and(
          eq(rooms.id, id),
          eq(rooms.eventId, event.id),
          isNull(rooms.archivedAt),
        ),
      );
  }

  return findEventOption(database, event.id, kind, id);
}

async function archiveEventOption(
  database: Database,
  userId: UserId,
  slug: string,
  kind: OptionKind,
  id: RoomId | TrackId,
): Promise<boolean> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return false;

  const now = new Date();
  const result =
    kind === "track"
      ? await database
          .update(tracks)
          .set({ archivedAt: now, updatedAt: now })
          .where(
            and(
              eq(tracks.id, id),
              eq(tracks.eventId, event.id),
              isNull(tracks.archivedAt),
            ),
          )
      : await database
          .update(rooms)
          .set({ archivedAt: now, updatedAt: now })
          .where(
            and(
              eq(rooms.id, id),
              eq(rooms.eventId, event.id),
              isNull(rooms.archivedAt),
            ),
          );
  return result.meta.changes > 0;
}

async function reorderEventOptions(
  database: Database,
  userId: UserId,
  slug: string,
  kind: OptionKind,
  orderedIds: (RoomId | TrackId)[],
): Promise<"ok" | "not_found" | "invalid_order"> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return "not_found";

  const current = await listEventOptions(database, userId, slug, kind);
  if (
    !current ||
    current.length !== orderedIds.length ||
    current.some((option) => !orderedIds.includes(option.id))
  ) {
    return "invalid_order";
  }

  const now = new Date();
  if (kind === "track") {
    const [first, ...rest] = orderedIds.map((id, position) =>
      database
        .update(tracks)
        .set({ position, updatedAt: now })
        .where(and(eq(tracks.id, id), eq(tracks.eventId, event.id))),
    );
    if (first) await database.batch([first, ...rest]);
  } else {
    const [first, ...rest] = orderedIds.map((id, position) =>
      database
        .update(rooms)
        .set({ position, updatedAt: now })
        .where(and(eq(rooms.id, id), eq(rooms.eventId, event.id))),
    );
    if (first) await database.batch([first, ...rest]);
  }

  return "ok";
}

async function findEventOption(
  database: Database,
  eventId: string,
  kind: OptionKind,
  id: RoomId | TrackId,
): Promise<EventOption | undefined> {
  const [row] =
    kind === "track"
      ? await database
          .select({
            id: tracks.id,
            name: tracks.name,
            position: tracks.position,
          })
          .from(tracks)
          .where(
            and(
              eq(tracks.id, id),
              eq(tracks.eventId, eventId),
              isNull(tracks.archivedAt),
            ),
          )
          .limit(1)
      : await database
          .select({ id: rooms.id, name: rooms.name, position: rooms.position })
          .from(rooms)
          .where(
            and(
              eq(rooms.id, id),
              eq(rooms.eventId, eventId),
              isNull(rooms.archivedAt),
            ),
          )
          .limit(1);
  return row as EventOption | undefined;
}
