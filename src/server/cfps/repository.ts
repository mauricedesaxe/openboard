import { and, eq, exists, isNull } from "drizzle-orm";

import {
  cfpFormContractSchema,
  cfpSchema,
  customFieldsSchema,
  type Cfp,
  type CfpDefinitionInput,
  type CfpFormContract,
  type CfpId,
} from "../../shared/cfps";
import {
  instantFallsAfterLocalDate,
  isoToEventLocalDateTime,
} from "../../shared/date-time";
import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";
import { cfps, events, reviewRounds, tracks } from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

type CfpWriteResult =
  | { ok: true; value: Cfp }
  | {
      ok: false;
      error:
        | "already_open"
        | "already_draft"
        | "cfp_changed"
        | "deadline_after_event"
        | "deadline_passed"
        | "missing_track"
        | "not_found"
        | "persistence_failed"
        | "structure_locked";
    };

export async function getCfpSetup(
  database: Database,
  userId: UserId,
  slug: string,
): Promise<{ draft: Cfp | null; open: Cfp | null } | undefined> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return undefined;

  const rows = await database
    .select()
    .from(cfps)
    .where(eq(cfps.eventId, event.id));
  return {
    draft: parseCfpStatus(rows, "draft"),
    open: parseCfpStatus(rows, "open"),
  };
}

export async function createDraftCfp(
  database: Database,
  userId: UserId,
  slug: string,
  input: CfpDefinitionInput,
): Promise<CfpWriteResult> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };
  if (new Date(input.deadline) <= new Date()) {
    return { ok: false, error: "deadline_passed" };
  }
  if (
    instantFallsAfterLocalDate({
      instant: input.deadline,
      localDate: event.endsOn,
      timezone: event.timezone,
    })
  ) {
    return { ok: false, error: "deadline_after_event" };
  }

  const [currentDraft] = await database
    .select({ id: cfps.id })
    .from(cfps)
    .where(and(eq(cfps.eventId, event.id), eq(cfps.status, "draft")))
    .limit(1);
  if (currentDraft) return { ok: false, error: "already_draft" };

  const id = crypto.randomUUID() as CfpId;
  const roundId = crypto.randomUUID();
  const now = new Date();
  try {
    await database.batch([
      database.insert(cfps).values({
        id,
        eventId: event.id,
        name: input.name,
        deadline: input.deadline,
        status: "draft",
        formatsJson: JSON.stringify(input.formats),
        customFieldsJson: JSON.stringify(input.customFields),
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(reviewRounds).values({
        id: roundId,
        eventId: event.id,
        cfpId: id,
        name: `${input.name} review`,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } catch (error: unknown) {
    if (String(error).includes("UNIQUE constraint failed")) {
      return { ok: false, error: "already_draft" };
    }
    return { ok: false, error: "persistence_failed" };
  }

  return {
    ok: true,
    value: {
      id,
      ...input,
      status: "draft",
      structureLocked: false,
    },
  };
}

export async function updateDraftCfp(
  database: Database,
  userId: UserId,
  slug: string,
  cfpId: CfpId,
  input: CfpDefinitionInput,
): Promise<CfpWriteResult> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };
  if (
    instantFallsAfterLocalDate({
      instant: input.deadline,
      localDate: event.endsOn,
      timezone: event.timezone,
    })
  ) {
    return { ok: false, error: "deadline_after_event" };
  }

  const [existing] = await database
    .select({
      customFieldsJson: cfps.customFieldsJson,
      deadline: cfps.deadline,
      formatsJson: cfps.formatsJson,
      lockedAt: cfps.structureLockedAt,
      status: cfps.status,
    })
    .from(cfps)
    .where(and(eq(cfps.id, cfpId), eq(cfps.eventId, event.id)))
    .limit(1);
  if (!existing) {
    return { ok: false, error: "not_found" };
  }
  const deadlineUnchanged =
    isoToEventLocalDateTime({
      instant: input.deadline,
      timezone: event.timezone,
    }) ===
    isoToEventLocalDateTime({
      instant: existing.deadline,
      timezone: event.timezone,
    });
  if (
    existing.status === "draft" &&
    new Date(input.deadline) <= new Date() &&
    !deadlineUnchanged
  ) {
    return { ok: false, error: "deadline_passed" };
  }
  if (
    existing.lockedAt &&
    (existing.formatsJson !== JSON.stringify(input.formats) ||
      existing.customFieldsJson !== JSON.stringify(input.customFields))
  ) {
    return { ok: false, error: "structure_locked" };
  }
  const deadline = deadlineUnchanged ? existing.deadline : input.deadline;

  try {
    const result = await database
      .update(cfps)
      .set({
        name: input.name,
        deadline,
        ...(existing.lockedAt
          ? {}
          : {
              formatsJson: JSON.stringify(input.formats),
              customFieldsJson: JSON.stringify(input.customFields),
            }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cfps.id, cfpId),
          eq(cfps.eventId, event.id),
          eq(cfps.deadline, existing.deadline),
          eq(cfps.status, existing.status),
          existing.lockedAt ? undefined : isNull(cfps.structureLockedAt),
        ),
      );
    if (result.meta.changes === 0) {
      const [latest] = await database
        .select({
          customFieldsJson: cfps.customFieldsJson,
          deadline: cfps.deadline,
          formatsJson: cfps.formatsJson,
          lockedAt: cfps.structureLockedAt,
          status: cfps.status,
        })
        .from(cfps)
        .where(and(eq(cfps.id, cfpId), eq(cfps.eventId, event.id)))
        .limit(1);
      if (!latest) return { ok: false, error: "not_found" };
      if (
        latest.deadline !== existing.deadline ||
        latest.status !== existing.status
      ) {
        return { ok: false, error: "cfp_changed" };
      }
      if (
        latest.lockedAt &&
        latest.formatsJson === JSON.stringify(input.formats) &&
        latest.customFieldsJson === JSON.stringify(input.customFields)
      ) {
        const metadataResult = await database
          .update(cfps)
          .set({
            name: input.name,
            deadline,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(cfps.id, cfpId),
              eq(cfps.eventId, event.id),
              eq(cfps.deadline, latest.deadline),
              eq(cfps.status, latest.status),
              eq(cfps.structureLockedAt, latest.lockedAt),
            ),
          );
        if (metadataResult.meta.changes > 0) {
          return {
            ok: true,
            value: {
              id: cfpId,
              ...input,
              deadline,
              status: existing.status,
              structureLocked: true,
            },
          };
        }
        return { ok: false, error: "cfp_changed" };
      }
      return { ok: false, error: "structure_locked" };
    }
  } catch {
    return { ok: false, error: "persistence_failed" };
  }

  return {
    ok: true,
    value: {
      id: cfpId,
      ...input,
      deadline,
      status: existing.status,
      structureLocked: existing.lockedAt !== null,
    },
  };
}

export async function saveAndOpenCfp(
  database: Database,
  userId: UserId,
  slug: string,
  cfpId: CfpId,
  input: CfpDefinitionInput,
): Promise<CfpWriteResult> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };
  if (
    instantFallsAfterLocalDate({
      instant: input.deadline,
      localDate: event.endsOn,
      timezone: event.timezone,
    })
  ) {
    return { ok: false, error: "deadline_after_event" };
  }
  if (new Date(input.deadline) <= new Date()) {
    return { ok: false, error: "deadline_passed" };
  }
  const [currentOpen] = await database
    .select()
    .from(cfps)
    .where(and(eq(cfps.eventId, event.id), eq(cfps.status, "open")))
    .limit(1);
  if (currentOpen && currentOpen.id !== cfpId) {
    return { ok: false, error: "already_open" };
  }
  if (currentOpen?.structureLockedAt) {
    return { ok: false, error: "structure_locked" };
  }

  const [target] = await database
    .select({ lockedAt: cfps.structureLockedAt, status: cfps.status })
    .from(cfps)
    .where(and(eq(cfps.id, cfpId), eq(cfps.eventId, event.id)))
    .limit(1);
  if (!target || (target.status !== "draft" && !currentOpen)) {
    return { ok: false, error: "not_found" };
  }
  if (target.lockedAt) return { ok: false, error: "structure_locked" };

  try {
    const result = await database
      .update(cfps)
      .set({
        name: input.name,
        deadline: input.deadline,
        status: "open",
        formatsJson: JSON.stringify(input.formats),
        customFieldsJson: JSON.stringify(input.customFields),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cfps.id, cfpId),
          eq(cfps.eventId, event.id),
          eq(cfps.status, currentOpen ? "open" : "draft"),
          isNull(cfps.structureLockedAt),
          exists(
            database
              .select({ id: tracks.id })
              .from(tracks)
              .where(
                and(eq(tracks.eventId, event.id), isNull(tracks.archivedAt)),
              ),
          ),
        ),
      );
    if (result.meta.changes === 0) {
      const [latest] = await database
        .select({ lockedAt: cfps.structureLockedAt })
        .from(cfps)
        .where(and(eq(cfps.id, cfpId), eq(cfps.eventId, event.id)))
        .limit(1);
      if (latest?.lockedAt) return { ok: false, error: "structure_locked" };

      const [activeTrack] = await database
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.eventId, event.id), isNull(tracks.archivedAt)))
        .limit(1);
      return {
        ok: false,
        error: activeTrack ? "not_found" : "missing_track",
      };
    }
  } catch (error: unknown) {
    if (String(error).includes("UNIQUE constraint failed")) {
      return { ok: false, error: "already_open" };
    }
    return { ok: false, error: "persistence_failed" };
  }

  const [row] = await database
    .select()
    .from(cfps)
    .where(and(eq(cfps.id, cfpId), eq(cfps.eventId, event.id)))
    .limit(1);
  return row
    ? { ok: true, value: parseCfp(row) }
    : { ok: false, error: "persistence_failed" };
}

export async function findPublicCfp(
  database: Database,
  slug: string,
): Promise<CfpFormContract | undefined> {
  const [row] = await database
    .select({
      cfpId: cfps.id,
      name: cfps.name,
      deadline: cfps.deadline,
      formatsJson: cfps.formatsJson,
      customFieldsJson: cfps.customFieldsJson,
      eventId: events.id,
      eventName: events.name,
      eventSlug: events.slug,
      startsOn: events.startsOn,
      endsOn: events.endsOn,
      timezone: events.timezone,
    })
    .from(cfps)
    .innerJoin(events, eq(events.id, cfps.eventId))
    .where(and(eq(events.slug, slug), eq(cfps.status, "open")))
    .limit(1);
  if (!row) return undefined;
  if (new Date(row.deadline) <= new Date()) return undefined;

  const activeTracks = await database
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(and(eq(tracks.eventId, row.eventId), isNull(tracks.archivedAt)))
    .orderBy(tracks.position);

  return cfpFormContractSchema.parse({
    event: {
      name: row.eventName,
      slug: row.eventSlug,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      timezone: row.timezone,
    },
    cfpId: row.cfpId,
    name: row.name,
    deadline: row.deadline,
    coreFields: {
      title: { required: true },
      abstract: { required: true },
      format: { required: true },
      track: { required: true },
      proposedSpeakers: { required: true },
    },
    formats: JSON.parse(row.formatsJson) as unknown,
    tracks: activeTracks,
    customFields: JSON.parse(row.customFieldsJson) as unknown,
  });
}

function parseCfp(row: typeof cfps.$inferSelect): Cfp {
  return cfpSchema.parse({
    id: row.id,
    name: row.name,
    deadline: row.deadline,
    status: row.status,
    formats: JSON.parse(row.formatsJson) as unknown,
    customFields: customFieldsSchema.parse(
      JSON.parse(row.customFieldsJson) as unknown,
    ),
    structureLocked: row.structureLockedAt !== null,
  });
}

function parseCfpStatus(
  rows: (typeof cfps.$inferSelect)[],
  status: "draft" | "open",
): Cfp | null {
  const row = rows.find((candidate) => candidate.status === status);
  return row ? parseCfp(row) : null;
}
