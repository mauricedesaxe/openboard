import {
  and,
  asc,
  count,
  eq,
  isNotNull,
  isNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";

import type { RoomId, TrackId } from "../../shared/cfps";
import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";
import { cfps, rooms, tracks } from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

type EventOption = {
  id: RoomId | TrackId;
  name: string;
  position: number;
};

type OptionKind = "room" | "track";
type ReorderResult = "invalid_order" | "not_found" | "ok";
type TrackReorderResult = ReorderResult | "structure_locked";

type OptionMutationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error:
        | "duplicate_name"
        | "last_open_track"
        | "not_found"
        | "persistence_failed"
        | "structure_locked";
    };

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
): Promise<OptionMutationResult<EventOption>> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };
  if (await hasActiveOptionName(database, event.id, "track", name)) {
    return { ok: false, error: "duplicate_name" };
  }

  const id = crypto.randomUUID() as TrackId;
  const now = Date.now();
  let result;
  try {
    result = await database.run(sql`
      INSERT INTO tracks (id, event_id, name, position, created_at, updated_at)
      SELECT ${id}, ${event.id}, ${name}, next_position, ${now}, ${now}
      FROM (
        SELECT COALESCE(MAX(position), -1) + 1 AS next_position
        FROM tracks
        WHERE event_id = ${event.id}
      )
      WHERE NOT EXISTS (
        SELECT 1 FROM cfps
        WHERE event_id = ${event.id} AND structure_locked_at IS NOT NULL
      )
    `);
  } catch (error: unknown) {
    return {
      ok: false,
      error: isUniqueConstraintError(error)
        ? "duplicate_name"
        : "persistence_failed",
    };
  }
  if (result.meta.changes === 0) {
    return { ok: false, error: "structure_locked" };
  }

  const value = await findEventOption(database, event.id, "track", id);
  return value ? { ok: true, value } : { ok: false, error: "not_found" };
}

export async function updateTrack(
  database: Database,
  userId: UserId,
  slug: string,
  id: TrackId,
  name: string,
): Promise<OptionMutationResult<EventOption>> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };
  if (await hasActiveOptionName(database, event.id, "track", name, id)) {
    return { ok: false, error: "duplicate_name" };
  }

  let result;
  try {
    result = await database
      .update(tracks)
      .set({ name, updatedAt: new Date() })
      .where(
        and(
          eq(tracks.id, id),
          eq(tracks.eventId, event.id),
          isNull(tracks.archivedAt),
          noLockedCfp(database, event.id),
        ),
      );
  } catch (error: unknown) {
    return {
      ok: false,
      error: isUniqueConstraintError(error)
        ? "duplicate_name"
        : "persistence_failed",
    };
  }
  if (result.meta.changes === 0) {
    return {
      ok: false,
      error: (await hasLockedCfp(database, event.id))
        ? "structure_locked"
        : "not_found",
    };
  }

  const value = await findEventOption(database, event.id, "track", id);
  return value ? { ok: true, value } : { ok: false, error: "not_found" };
}

export async function archiveTrack(
  database: Database,
  userId: UserId,
  slug: string,
  id: TrackId,
): Promise<OptionMutationResult<{ archived: true }>> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };

  const now = Date.now();
  const result = await database.run(sql`
    UPDATE tracks
    SET archived_at = ${now}, updated_at = ${now}
    WHERE id = ${id}
      AND event_id = ${event.id}
      AND archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM cfps
        WHERE event_id = ${event.id} AND structure_locked_at IS NOT NULL
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM cfps
          WHERE event_id = ${event.id} AND status = 'open'
        )
        OR (
          SELECT COUNT(*) FROM tracks
          WHERE event_id = ${event.id} AND archived_at IS NULL
        ) > 1
      )
  `);
  if (result.meta.changes > 0) {
    return { ok: true, value: { archived: true } };
  }
  if (!(await findEventOption(database, event.id, "track", id))) {
    return { ok: false, error: "not_found" };
  }
  if (await hasLockedCfp(database, event.id)) {
    return { ok: false, error: "structure_locked" };
  }
  if (
    (await hasOpenCfp(database, event.id)) &&
    (await activeTrackCount(database, event.id)) <= 1
  ) {
    return { ok: false, error: "last_open_track" };
  }
  return { ok: false, error: "not_found" };
}

export async function reorderTracks(
  database: Database,
  userId: UserId,
  slug: string,
  orderedIds: TrackId[],
): Promise<TrackReorderResult> {
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
): Promise<OptionMutationResult<EventOption>> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };
  if (await hasActiveOptionName(database, event.id, "room", name)) {
    return { ok: false, error: "duplicate_name" };
  }

  const id = crypto.randomUUID() as RoomId;
  const now = Date.now();
  try {
    await database.run(sql`
      INSERT INTO rooms (id, event_id, name, position, created_at, updated_at)
      SELECT ${id}, ${event.id}, ${name}, COALESCE(MAX(position), -1) + 1, ${now}, ${now}
      FROM rooms
      WHERE event_id = ${event.id}
    `);
  } catch (error: unknown) {
    return {
      ok: false,
      error: isUniqueConstraintError(error)
        ? "duplicate_name"
        : "persistence_failed",
    };
  }

  const value = await findEventOption(database, event.id, "room", id);
  return value ? { ok: true, value } : { ok: false, error: "not_found" };
}

export async function updateRoom(
  database: Database,
  userId: UserId,
  slug: string,
  id: RoomId,
  name: string,
): Promise<OptionMutationResult<EventOption>> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };
  if (await hasActiveOptionName(database, event.id, "room", name, id)) {
    return { ok: false, error: "duplicate_name" };
  }

  let result;
  try {
    result = await database
      .update(rooms)
      .set({ name, updatedAt: new Date() })
      .where(
        and(
          eq(rooms.id, id),
          eq(rooms.eventId, event.id),
          isNull(rooms.archivedAt),
        ),
      );
  } catch (error: unknown) {
    return {
      ok: false,
      error: isUniqueConstraintError(error)
        ? "duplicate_name"
        : "persistence_failed",
    };
  }
  if (result.meta.changes === 0) return { ok: false, error: "not_found" };

  const value = await findEventOption(database, event.id, "room", id);
  return value ? { ok: true, value } : { ok: false, error: "not_found" };
}

export async function archiveRoom(
  database: Database,
  userId: UserId,
  slug: string,
  id: RoomId,
): Promise<boolean> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return false;

  const now = new Date();
  const result = await database
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

export async function reorderRooms(
  database: Database,
  userId: UserId,
  slug: string,
  orderedIds: RoomId[],
): Promise<ReorderResult> {
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

async function reorderEventOptions(
  database: Database,
  userId: UserId,
  slug: string,
  kind: "room",
  orderedIds: RoomId[],
): Promise<ReorderResult>;
async function reorderEventOptions(
  database: Database,
  userId: UserId,
  slug: string,
  kind: "track",
  orderedIds: TrackId[],
): Promise<TrackReorderResult>;
async function reorderEventOptions(
  database: Database,
  userId: UserId,
  slug: string,
  kind: OptionKind,
  orderedIds: (RoomId | TrackId)[],
): Promise<TrackReorderResult> {
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
  if (kind === "track" && (await hasLockedCfp(database, event.id))) {
    return "structure_locked";
  }

  const now = new Date();
  if (kind === "track") {
    const [first, ...rest] = orderedIds.map((id, position) =>
      database
        .update(tracks)
        .set({ position, updatedAt: now })
        .where(
          and(
            eq(tracks.id, id),
            eq(tracks.eventId, event.id),
            noLockedCfp(database, event.id),
          ),
        ),
    );
    if (first) {
      const results = await database.batch([first, ...rest]);
      if (results.some((result) => result.meta.changes === 0)) {
        return "structure_locked";
      }
    }
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

function noLockedCfp(database: Database, eventId: string) {
  return notExists(
    database
      .select({ id: cfps.id })
      .from(cfps)
      .where(and(eq(cfps.eventId, eventId), isNotNull(cfps.structureLockedAt))),
  );
}

async function hasLockedCfp(
  database: Database,
  eventId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: cfps.id })
    .from(cfps)
    .where(and(eq(cfps.eventId, eventId), isNotNull(cfps.structureLockedAt)))
    .limit(1);
  return Boolean(row);
}

async function hasOpenCfp(
  database: Database,
  eventId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: cfps.id })
    .from(cfps)
    .where(and(eq(cfps.eventId, eventId), eq(cfps.status, "open")))
    .limit(1);
  return Boolean(row);
}

async function activeTrackCount(
  database: Database,
  eventId: string,
): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(tracks)
    .where(and(eq(tracks.eventId, eventId), isNull(tracks.archivedAt)));
  return row?.value ?? 0;
}

async function hasActiveOptionName(
  database: Database,
  eventId: string,
  kind: OptionKind,
  name: string,
  excludedId?: RoomId | TrackId,
): Promise<boolean> {
  const [row] =
    kind === "track"
      ? await database
          .select({ id: tracks.id })
          .from(tracks)
          .where(
            and(
              eq(tracks.eventId, eventId),
              isNull(tracks.archivedAt),
              sql`lower(${tracks.name}) = lower(${name})`,
              excludedId ? ne(tracks.id, excludedId) : undefined,
            ),
          )
          .limit(1)
      : await database
          .select({ id: rooms.id })
          .from(rooms)
          .where(
            and(
              eq(rooms.eventId, eventId),
              isNull(rooms.archivedAt),
              sql`lower(${rooms.name}) = lower(${name})`,
              excludedId ? ne(rooms.id, excludedId) : undefined,
            ),
          )
          .limit(1);
  return Boolean(row);
}

function isUniqueConstraintError(error: unknown): boolean {
  return String(error).toLowerCase().includes("unique");
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
