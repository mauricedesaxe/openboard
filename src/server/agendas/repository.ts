import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";

import type {
  AgendaItemId,
  MoveAgendaItemInput,
  PlaceProgramItemInput,
  PlaceServiceBlockInput,
  PublishAgendaInput,
} from "../../shared/agendas";
import { resolveEventLocalDateTime } from "../../shared/date-time";
import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";
import {
  agendaDeliveryWork,
  agendaItems,
  agendaPublications,
  calendarSyncStates,
  decisions,
  events,
  programItems,
  publishedAgendaItems,
  publishedAgendaSpeakers,
  rooms,
  speakerProfiles,
  submissions,
  submissionSpeakers,
  tracks,
  user,
} from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

/** Keep generated inserts below D1's 100-variable statement limit. */
const agendaPublicationBindingBudget = 80;
const publishedItemBindingsPerRow = 19;
const publishedSpeakerBindingsPerRow = 8;
const calendarChangeBindingsPerRow = 7;
const publishedItemInsertSize = Math.floor(
  agendaPublicationBindingBudget / publishedItemBindingsPerRow,
);
const publishedSpeakerInsertSize = Math.floor(
  agendaPublicationBindingBudget / publishedSpeakerBindingsPerRow,
);
const calendarChangeInsertSize = Math.floor(
  agendaPublicationBindingBudget / calendarChangeBindingsPerRow,
);
/** Five recipients per insert stays below both D1 statement and batch limits. */
const calendarDeliveryInsertSize = 5;

export type AgendaWriteError =
  | "agenda_changed"
  | "agenda_item_not_found"
  | "archived_reference"
  | "invalid_agenda_item"
  | "invalid_time"
  | "missing_room"
  | "not_found"
  | "persistence_failed"
  | "program_item_unavailable"
  | "room_conflict"
  | "speaker_conflict"
  | "timezone_ambiguous";

type AgendaWriteResult<T> =
  { ok: true; value: T } | { ok: false; error: AgendaWriteError };

type WorkingItem = Awaited<
  ReturnType<typeof loadWorkingAgenda>
>["items"][number];

export async function getWorkingAgenda(
  database: Database,
  actorUserId: UserId,
  slug: string,
) {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return undefined;
  return loadWorkingAgenda(database, event);
}

export async function placeProgramItem(
  database: Database,
  actorUserId: UserId,
  input: PlaceProgramItemInput,
): Promise<AgendaWriteResult<{ id: AgendaItemId }>> {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false, error: "not_found" };
  const [existingPlacement] = await database
    .select({ id: agendaItems.id })
    .from(agendaItems)
    .where(eq(agendaItems.programItemId, input.programItemId))
    .limit(1);
  if (existingPlacement) {
    return { ok: false, error: "program_item_unavailable" };
  }
  const id = crypto.randomUUID() as AgendaItemId;
  const now = new Date();
  try {
    await database.insert(agendaItems).values({
      id,
      agendaId: event.agendaId,
      eventId: event.id,
      kind: "program",
      programItemId: input.programItemId,
      roomId: input.roomId,
      startsAtLocal: input.startsAtLocal,
      endsAtLocal: input.endsAtLocal,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, value: { id } };
  } catch (error: unknown) {
    return { ok: false, error: agendaItemPersistenceError(error) };
  }
}

export async function placeServiceBlock(
  database: Database,
  actorUserId: UserId,
  input: PlaceServiceBlockInput,
): Promise<AgendaWriteResult<{ id: AgendaItemId }>> {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false, error: "not_found" };
  const id = crypto.randomUUID() as AgendaItemId;
  const now = new Date();
  try {
    await database.insert(agendaItems).values({
      id,
      agendaId: event.agendaId,
      eventId: event.id,
      kind: "service",
      serviceScope: input.scope.type,
      serviceTitle: input.title,
      roomId: input.scope.type === "room" ? input.scope.roomId : null,
      startsAtLocal: input.startsAtLocal,
      endsAtLocal: input.endsAtLocal,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, value: { id } };
  } catch (error: unknown) {
    return { ok: false, error: agendaItemPersistenceError(error) };
  }
}

export async function moveAgendaItem(
  database: Database,
  actorUserId: UserId,
  input: MoveAgendaItemInput,
): Promise<AgendaWriteResult<{ moved: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false, error: "not_found" };
  const [item] = await database
    .select({ kind: agendaItems.kind, serviceScope: agendaItems.serviceScope })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.id, input.agendaItemId),
        eq(agendaItems.agendaId, event.agendaId),
      ),
    )
    .limit(1);
  if (!item) return { ok: false, error: "agenda_item_not_found" };
  if (
    item.kind === "service" &&
    item.serviceScope === "event" &&
    input.roomId
  ) {
    return { ok: false, error: "invalid_agenda_item" };
  }
  if (
    item.kind === "service" &&
    item.serviceScope === "room" &&
    !input.roomId
  ) {
    return { ok: false, error: "missing_room" };
  }
  const now = new Date();
  try {
    const result = await database
      .update(agendaItems)
      .set({
        roomId: input.roomId,
        startsAtLocal: input.startsAtLocal,
        endsAtLocal: input.endsAtLocal,
        updatedAt: now,
      })
      .where(
        and(
          eq(agendaItems.id, input.agendaItemId),
          eq(agendaItems.agendaId, event.agendaId),
        ),
      );
    return result.meta.changes > 0
      ? { ok: true, value: { moved: true } }
      : { ok: false, error: "agenda_item_not_found" };
  } catch (error: unknown) {
    return { ok: false, error: agendaItemPersistenceError(error) };
  }
}

export async function setProgramPlacementCanceled(
  database: Database,
  actorUserId: UserId,
  slug: string,
  agendaItemId: AgendaItemId,
  canceled: boolean,
): Promise<AgendaWriteResult<{ canceled: boolean }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const now = new Date();
  const result = await database
    .update(agendaItems)
    .set({ canceledAt: canceled ? now : null, updatedAt: now })
    .where(
      and(
        eq(agendaItems.id, agendaItemId),
        eq(agendaItems.agendaId, event.agendaId),
        eq(agendaItems.kind, "program"),
        canceled
          ? isNull(agendaItems.canceledAt)
          : isNotNull(agendaItems.canceledAt),
      ),
    );
  if (result.meta.changes > 0) return { ok: true, value: { canceled } };
  const [current] = await database
    .select({ canceledAt: agendaItems.canceledAt })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.id, agendaItemId),
        eq(agendaItems.agendaId, event.agendaId),
        eq(agendaItems.kind, "program"),
      ),
    )
    .limit(1);
  return current && (current.canceledAt !== null) === canceled
    ? { ok: true, value: { canceled } }
    : { ok: false, error: "agenda_item_not_found" };
}

export async function removeServiceBlock(
  database: Database,
  actorUserId: UserId,
  slug: string,
  agendaItemId: AgendaItemId,
): Promise<AgendaWriteResult<{ removed: true }>> {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return { ok: false, error: "not_found" };
  const result = await database
    .delete(agendaItems)
    .where(
      and(
        eq(agendaItems.id, agendaItemId),
        eq(agendaItems.agendaId, event.agendaId),
        eq(agendaItems.kind, "service"),
      ),
    );
  return result.meta.changes > 0
    ? { ok: true, value: { removed: true } }
    : { ok: false, error: "agenda_item_not_found" };
}

export async function publishAgenda(
  database: Database,
  actorUserId: UserId,
  input: PublishAgendaInput,
): Promise<AgendaWriteResult<{ revision: number; deliveryWork: number }>> {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false, error: "not_found" };
  const working = await loadWorkingAgenda(database, event, false);
  if (working.revision !== input.expectedRevision) {
    return { ok: false, error: "agenda_changed" };
  }
  const validation = validateForPublication(working.items, event);
  if (!validation.ok) return { ok: false, error: validation.error };

  const publicationStateRows = await database
    .select({
      revision: agendaPublications.revision,
      agendaItemId: calendarSyncStates.agendaItemId,
      uid: calendarSyncStates.uid,
      sequence: calendarSyncStates.sequence,
      canceled: calendarSyncStates.canceled,
      fingerprint: calendarSyncStates.fingerprint,
    })
    .from(agendaPublications)
    .leftJoin(
      agendaItems,
      eq(agendaItems.agendaId, agendaPublications.agendaId),
    )
    .leftJoin(
      calendarSyncStates,
      eq(calendarSyncStates.agendaItemId, agendaItems.id),
    )
    .where(
      and(
        eq(agendaPublications.agendaId, event.agendaId),
        sql`${agendaPublications.revision} = (
          SELECT MAX(latest.revision)
          FROM agenda_publications AS latest
          WHERE latest.agenda_id = ${event.agendaId}
        )`,
      ),
    );
  const previousStates = publicationStateRows.flatMap((row) =>
    row.agendaItemId &&
    row.uid &&
    row.sequence !== null &&
    row.canceled !== null &&
    row.fingerprint
      ? [
          {
            agendaItemId: row.agendaItemId,
            uid: row.uid,
            sequence: row.sequence,
            canceled: row.canceled,
            fingerprint: row.fingerprint,
          },
        ]
      : [],
  );
  const publicationId = crypto.randomUUID();
  const revision = (publicationStateRows[0]?.revision ?? 0) + 1;
  const now = new Date();
  const snapshots = working.items.map((item) =>
    snapshotItem(item, validation.times.get(item.id)),
  );
  const calendarChanges = snapshots.flatMap((snapshot) => {
    if (snapshot.kind !== "program") return [];
    const previous = previousStates.find(
      (state) => state.agendaItemId === snapshot.agendaItemId,
    );
    if (!previous && snapshot.canceled) return [];
    const fingerprint = JSON.stringify({
      title: snapshot.title,
      room: snapshot.roomName,
      startsAt: snapshot.startsAt,
      endsAt: snapshot.endsAt,
      canceled: snapshot.canceled,
      abstract: snapshot.abstract,
      format: snapshot.format,
      track: snapshot.trackName,
      speakers: snapshot.speakers.map((speaker) => speaker.displayName),
    });
    if (previous?.fingerprint === fingerprint) return [];
    const sequence = (previous?.sequence ?? -1) + 1;
    const uid = previous?.uid ?? `${snapshot.agendaItemId}@openboard`;
    const action = !previous
      ? "publish"
      : snapshot.canceled
        ? "cancel"
        : previous.canceled
          ? "restore"
          : "update";
    return [{ snapshot, fingerprint, sequence, uid, action } as const];
  });
  const calendarMetadata = new Map(
    snapshots.flatMap((snapshot) => {
      if (snapshot.kind !== "program") return [];
      const change = calendarChanges.find(
        (candidate) =>
          candidate.snapshot.agendaItemId === snapshot.agendaItemId,
      );
      const previous = previousStates.find(
        (state) => state.agendaItemId === snapshot.agendaItemId,
      );
      const metadata = change ?? previous;
      return metadata
        ? [
            [
              snapshot.agendaItemId,
              { uid: metadata.uid, sequence: metadata.sequence },
            ] as const,
          ]
        : [];
    }),
  );

  const publicationStatement = database.insert(agendaPublications).values({
    id: publicationId,
    agendaId: event.agendaId,
    eventId: event.id,
    revision,
    workingRevision: input.expectedRevision,
    eventName: event.name,
    timezone: event.timezone,
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    publishedByUserId: actorUserId,
    createdAt: now,
    requiresFinalization: true,
  });
  const snapshotValues = snapshots.map((snapshot) => ({
    id: snapshot.id,
    publicationId,
    agendaItemId: snapshot.agendaItemId,
    kind: snapshot.kind,
    programItemId: snapshot.programItemId,
    title: snapshot.title,
    abstract: snapshot.abstract,
    format: snapshot.format,
    trackId: snapshot.trackId,
    trackName: snapshot.trackName,
    trackPosition: snapshot.trackPosition,
    roomId: snapshot.roomId,
    roomName: snapshot.roomName,
    roomPosition: snapshot.roomPosition,
    startsAt: snapshot.startsAt,
    endsAt: snapshot.endsAt,
    canceled: snapshot.canceled,
    calendarUid: calendarMetadata.get(snapshot.agendaItemId)?.uid,
    calendarSequence: calendarMetadata.get(snapshot.agendaItemId)?.sequence,
  }));
  const speakerValues = snapshots.flatMap((snapshot) =>
    snapshot.speakers.map((speaker) => ({
      id: crypto.randomUUID(),
      publishedAgendaItemId: snapshot.id,
      submissionSpeakerId: speaker.id,
      sourceClaimedUserId: speaker.claimedUserId,
      displayName: speaker.displayName,
      bio: speaker.bio,
      headshotUrl: speaker.headshotUrl,
      position: speaker.position,
    })),
  );
  const snapshotStatements = chunks(
    snapshotValues,
    publishedItemInsertSize,
  ).map((values) => database.insert(publishedAgendaItems).values(values));
  const speakerStatements = chunks(
    speakerValues,
    publishedSpeakerInsertSize,
  ).map((values) => database.insert(publishedAgendaSpeakers).values(values));
  const calendarStateStatements = chunks(
    calendarChanges.map((change) => ({
      agendaItemId: change.snapshot.agendaItemId,
      uid: change.uid,
      sequence: change.sequence,
      canceled: change.snapshot.canceled,
      fingerprint: change.fingerprint,
      publicationId,
      updatedAt: now,
    })),
    calendarChangeInsertSize,
  ).map((values) =>
    database
      .insert(calendarSyncStates)
      .values(values)
      .onConflictDoUpdate({
        target: calendarSyncStates.agendaItemId,
        set: {
          sequence: sql`excluded.sequence`,
          canceled: sql`excluded.canceled`,
          fingerprint: sql`excluded.fingerprint`,
          publicationId: sql`excluded.publication_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
  const deliveryValues = calendarChanges.flatMap((change) =>
    [
      ...new Map(
        change.snapshot.speakers.map(
          (speaker) =>
            [
              speaker.claimedUserId ?? `speaker:${speaker.id}`,
              speaker,
            ] as const,
        ),
      ).values(),
    ].map((speaker) => ({
      id: crypto.randomUUID(),
      publicationId,
      agendaItemId: change.snapshot.agendaItemId,
      recipientKey: speaker.claimedUserId ?? `speaker:${speaker.id}`,
      recipientUserId: speaker.claimedUserId,
      destination: speaker.claimedEmail ?? speaker.invitedEmail,
      recipientName: speaker.displayName,
      action: change.action,
      calendarUid: change.uid,
      calendarSequence: change.sequence,
      createdAt: now,
    })),
  );
  const deliveryStatements = chunks(
    deliveryValues,
    calendarDeliveryInsertSize,
  ).map((values) => database.insert(agendaDeliveryWork).values(values));
  const finalizationStatement = database
    .update(agendaPublications)
    .set({ finalized: true })
    .where(
      and(
        eq(agendaPublications.id, publicationId),
        eq(agendaPublications.finalized, false),
      ),
    );
  try {
    await database.batch([
      publicationStatement,
      ...snapshotStatements,
      ...speakerStatements,
      ...calendarStateStatements,
      ...deliveryStatements,
      finalizationStatement,
    ]);
  } catch (error: unknown) {
    if (String(error).includes("stale_agenda_publication")) {
      return { ok: false, error: "agenda_changed" };
    }
    console.error(
      JSON.stringify({
        event: "agenda_publication_failed",
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { ok: false, error: "persistence_failed" };
  }
  return {
    ok: true,
    value: { revision, deliveryWork: deliveryValues.length },
  };
}

export async function getPublishedAgenda(database: Database, slug: string) {
  await database
    .update(agendaPublications)
    .set({ finalized: true })
    .where(
      and(
        eq(agendaPublications.requiresFinalization, false),
        eq(agendaPublications.finalized, false),
      ),
    );
  const [publication] = await database
    .select()
    .from(agendaPublications)
    .innerJoin(events, eq(events.id, agendaPublications.eventId))
    .where(and(eq(events.slug, slug), eq(agendaPublications.finalized, true)))
    .orderBy(desc(agendaPublications.revision))
    .limit(1);
  if (!publication) return undefined;
  const itemRows = await database
    .select()
    .from(publishedAgendaItems)
    .where(
      and(
        eq(
          publishedAgendaItems.publicationId,
          publication.agenda_publications.id,
        ),
        eq(publishedAgendaItems.canceled, false),
      ),
    )
    .orderBy(
      asc(publishedAgendaItems.startsAt),
      asc(publishedAgendaItems.roomPosition),
      asc(publishedAgendaItems.title),
    );
  const speakerRows =
    itemRows.length === 0
      ? []
      : await database
          .select()
          .from(publishedAgendaSpeakers)
          .where(
            inArray(
              publishedAgendaSpeakers.publishedAgendaItemId,
              itemRows.map((item) => item.id),
            ),
          )
          .orderBy(asc(publishedAgendaSpeakers.position));
  const revision = publication.agenda_publications;
  return {
    event: {
      name: revision.eventName,
      slug,
      timezone: revision.timezone,
      startsOn: revision.startsOn,
      endsOn: revision.endsOn,
    },
    revision: revision.revision,
    publishedAt: revision.createdAt.toISOString(),
    items: itemRows.map((item) => ({
      ...item,
      speakers: speakerRows
        .filter((speaker) => speaker.publishedAgendaItemId === item.id)
        .map((speaker) => ({
          submissionSpeakerId: speaker.submissionSpeakerId,
          displayName: speaker.displayName,
          bio: speaker.bio,
          headshotUrl: speaker.headshotUrl,
          position: speaker.position,
        })),
    })),
  };
}

async function loadWorkingAgenda(
  database: Database,
  event: {
    id: string;
    agendaId: string;
    startsOn: string;
    endsOn: string;
    timezone: string;
    agendaRevision: number;
  },
  includeEditorOptions = true,
) {
  const rows = await database
    .select({
      id: agendaItems.id,
      kind: agendaItems.kind,
      programItemId: agendaItems.programItemId,
      serviceScope: agendaItems.serviceScope,
      serviceTitle: agendaItems.serviceTitle,
      roomId: agendaItems.roomId,
      roomName: rooms.name,
      roomPosition: rooms.position,
      roomArchivedAt: rooms.archivedAt,
      startsAtLocal: agendaItems.startsAtLocal,
      endsAtLocal: agendaItems.endsAtLocal,
      canceledAt: agendaItems.canceledAt,
      submissionId: submissions.id,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      submissionStatus: submissions.status,
      decisionStatus: decisions.status,
      trackId: tracks.id,
      trackName: tracks.name,
      trackPosition: tracks.position,
      trackArchivedAt: tracks.archivedAt,
    })
    .from(agendaItems)
    .leftJoin(programItems, eq(programItems.id, agendaItems.programItemId))
    .leftJoin(submissions, eq(submissions.id, programItems.submissionId))
    .leftJoin(decisions, eq(decisions.submissionId, submissions.id))
    .leftJoin(tracks, eq(tracks.id, submissions.trackId))
    .leftJoin(rooms, eq(rooms.id, agendaItems.roomId))
    .where(eq(agendaItems.agendaId, event.agendaId))
    .orderBy(asc(agendaItems.startsAtLocal), asc(rooms.position));
  const speakerRows =
    rows.length === 0
      ? []
      : await database
          .select({
            agendaItemId: agendaItems.id,
            id: submissionSpeakers.id,
            claimedUserId: submissionSpeakers.claimedUserId,
            claimedEmail: user.email,
            invitedEmail: submissionSpeakers.invitedEmail,
            invitedName: submissionSpeakers.invitedName,
            displayName: speakerProfiles.displayName,
            bio: speakerProfiles.bio,
            headshotUrl: speakerProfiles.headshotUrl,
            position: submissionSpeakers.position,
          })
          .from(agendaItems)
          .innerJoin(
            programItems,
            eq(programItems.id, agendaItems.programItemId),
          )
          .innerJoin(
            submissionSpeakers,
            eq(submissionSpeakers.submissionId, programItems.submissionId),
          )
          .leftJoin(
            speakerProfiles,
            eq(speakerProfiles.userId, submissionSpeakers.claimedUserId),
          )
          .leftJoin(user, eq(user.id, submissionSpeakers.claimedUserId))
          .where(
            and(
              eq(agendaItems.agendaId, event.agendaId),
              isNull(submissionSpeakers.removedAt),
            ),
          )
          .orderBy(asc(submissionSpeakers.position));
  const items = rows.map((row) => ({
    ...row,
    canceled: row.canceledAt !== null,
    speakers: speakerRows
      .filter((speaker) => speaker.agendaItemId === row.id)
      .map((speaker) => ({
        id: speaker.id,
        claimedUserId: speaker.claimedUserId,
        claimedEmail: speaker.claimedEmail,
        invitedEmail: speaker.invitedEmail,
        displayName: speaker.displayName ?? speaker.invitedName,
        bio: speaker.bio,
        headshotUrl: speaker.headshotUrl,
        position: speaker.position,
      })),
    conflicts: [] as Array<"room" | "speaker">,
  }));
  deriveConflicts(items);

  const unplaced = includeEditorOptions
    ? await database
        .select({
          id: programItems.id,
          title: submissions.title,
          format: submissions.format,
          track: tracks.name,
        })
        .from(programItems)
        .innerJoin(submissions, eq(submissions.id, programItems.submissionId))
        .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
        .innerJoin(tracks, eq(tracks.id, submissions.trackId))
        .leftJoin(agendaItems, eq(agendaItems.programItemId, programItems.id))
        .where(
          and(
            eq(programItems.eventId, event.id),
            eq(submissions.status, "active"),
            eq(decisions.status, "accepted"),
            isNull(agendaItems.id),
          ),
        )
        .orderBy(asc(submissions.title))
    : [];
  const activeRooms = includeEditorOptions
    ? await database
        .select({ id: rooms.id, name: rooms.name, position: rooms.position })
        .from(rooms)
        .where(and(eq(rooms.eventId, event.id), isNull(rooms.archivedAt)))
        .orderBy(asc(rooms.position))
    : [];
  return {
    revision: event.agendaRevision,
    timezone: event.timezone,
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    rooms: activeRooms,
    unplacedProgramItems: unplaced,
    items,
  };
}

function deriveConflicts(items: WorkingItem[]): void {
  const active = items.filter((item) => !item.canceled);
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < active.length;
      rightIndex += 1
    ) {
      const left = active[leftIndex];
      const right = active[rightIndex];
      if (!left || !right || !overlaps(left, right)) continue;
      if (roomsOverlap(left, right)) addConflict(left, right, "room");
      const leftUsers = new Set(
        left.speakers.flatMap((speaker) =>
          speaker.claimedUserId ? [speaker.claimedUserId] : [],
        ),
      );
      if (
        right.speakers.some(
          (speaker) =>
            speaker.claimedUserId && leftUsers.has(speaker.claimedUserId),
        )
      ) {
        addConflict(left, right, "speaker");
      }
    }
  }
}

function overlaps(left: WorkingItem, right: WorkingItem): boolean {
  return (
    left.startsAtLocal < right.endsAtLocal &&
    right.startsAtLocal < left.endsAtLocal
  );
}

function roomsOverlap(left: WorkingItem, right: WorkingItem): boolean {
  if (left.serviceScope === "event" || right.serviceScope === "event")
    return true;
  return Boolean(left.roomId && left.roomId === right.roomId);
}

function addConflict(
  left: WorkingItem,
  right: WorkingItem,
  conflict: "room" | "speaker",
): void {
  if (!left.conflicts.includes(conflict)) left.conflicts.push(conflict);
  if (!right.conflicts.includes(conflict)) right.conflicts.push(conflict);
}

function validateForPublication(
  items: WorkingItem[],
  event: { startsOn: string; endsOn: string; timezone: string },
):
  | {
      ok: true;
      times: Map<string, { startsAt: string; endsAt: string }>;
    }
  | { ok: false; error: AgendaWriteError } {
  const times = new Map<string, { startsAt: string; endsAt: string }>();
  for (const item of items) {
    if (!item.canceled) {
      if (item.kind === "program" && !item.roomId) {
        return { ok: false, error: "missing_room" };
      }
      if (item.roomId && (!item.roomName || item.roomArchivedAt)) {
        return { ok: false, error: "archived_reference" };
      }
      if (
        item.kind === "program" &&
        (!item.programItemId ||
          item.submissionStatus !== "active" ||
          item.decisionStatus !== "accepted")
      ) {
        return { ok: false, error: "program_item_unavailable" };
      }
      if (
        item.kind === "program" &&
        (!item.trackName || item.trackArchivedAt)
      ) {
        return { ok: false, error: "archived_reference" };
      }
    }
    const start = resolveEventLocalDateTime(item.startsAtLocal, event.timezone);
    const end = resolveEventLocalDateTime(item.endsAtLocal, event.timezone);
    if (start.status === "ambiguous" || end.status === "ambiguous") {
      return { ok: false, error: "timezone_ambiguous" };
    }
    if (
      start.status === "invalid" ||
      end.status === "invalid" ||
      start.iso >= end.iso ||
      item.startsAtLocal.slice(0, 10) < event.startsOn ||
      item.endsAtLocal.slice(0, 10) > event.endsOn
    ) {
      return { ok: false, error: "invalid_time" };
    }
    times.set(item.id, { startsAt: start.iso, endsAt: end.iso });
  }
  if (items.some((item) => !item.canceled && item.conflicts.includes("room"))) {
    return { ok: false, error: "room_conflict" };
  }
  if (
    items.some((item) => !item.canceled && item.conflicts.includes("speaker"))
  ) {
    return { ok: false, error: "speaker_conflict" };
  }
  return { ok: true, times };
}

function snapshotItem(
  item: WorkingItem,
  times: { startsAt: string; endsAt: string } | undefined,
) {
  if (!times) throw new Error("Validated agenda time is missing.");
  return {
    id: crypto.randomUUID(),
    agendaItemId: item.id,
    kind: item.kind,
    programItemId: item.programItemId,
    title:
      item.kind === "program" ? (item.title ?? "") : (item.serviceTitle ?? ""),
    abstract: item.kind === "program" ? item.abstract : null,
    format: item.kind === "program" ? item.format : null,
    trackId: item.kind === "program" ? item.trackId : null,
    trackName: item.kind === "program" ? item.trackName : null,
    trackPosition: item.kind === "program" ? item.trackPosition : null,
    roomId: item.roomId,
    roomName: item.roomName,
    roomPosition: item.roomPosition,
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    canceled: item.canceled,
    speakers: item.kind === "program" ? item.speakers : [],
  };
}

function agendaItemPersistenceError(error: unknown): AgendaWriteError {
  const message = String(error);
  if (
    message.includes("UNIQUE constraint failed") ||
    message.includes("agenda_items.program_item_id")
  ) {
    return "program_item_unavailable";
  }
  if (message.includes("invalid_agenda_item_scope")) {
    return "invalid_agenda_item";
  }
  return "persistence_failed";
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
