import { and, desc, eq, isNull } from "drizzle-orm";

import {
  cfpFormContractSchema,
  cfpSchema,
  customFieldsSchema,
  type Cfp,
  type CfpDefinitionInput,
  type CfpFormContract,
  type CfpId,
} from "../../shared/cfps";
import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";
import { cfps, events, tracks } from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

type CfpWriteResult =
  | { ok: true; value: Cfp }
  | {
      ok: false;
      error:
        | "already_open"
        | "already_draft"
        | "missing_track"
        | "not_found"
        | "persistence_failed"
        | "structure_locked";
    };

export async function getCfpSetup(
  database: Database,
  userId: UserId,
  slug: string,
): Promise<Cfp | null | undefined> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return undefined;

  const [row] = await database
    .select()
    .from(cfps)
    .where(eq(cfps.eventId, event.id))
    .orderBy(desc(cfps.createdAt))
    .limit(1);
  return row ? parseCfp(row) : null;
}

export async function createDraftCfp(
  database: Database,
  userId: UserId,
  slug: string,
  input: CfpDefinitionInput,
): Promise<CfpWriteResult> {
  const event = await findEventForOrganizer(database, userId, slug);
  if (!event) return { ok: false, error: "not_found" };

  const [currentDraft] = await database
    .select({ id: cfps.id })
    .from(cfps)
    .where(and(eq(cfps.eventId, event.id), eq(cfps.status, "draft")))
    .limit(1);
  if (currentDraft) return { ok: false, error: "already_draft" };

  const id = crypto.randomUUID() as CfpId;
  const now = new Date();
  try {
    await database.insert(cfps).values({
      id,
      eventId: event.id,
      name: input.name,
      deadline: input.deadline,
      status: "draft",
      formatsJson: JSON.stringify(input.formats),
      customFieldsJson: JSON.stringify(input.customFields),
      createdAt: now,
      updatedAt: now,
    });
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

  const [existing] = await database
    .select({ lockedAt: cfps.structureLockedAt, status: cfps.status })
    .from(cfps)
    .where(and(eq(cfps.id, cfpId), eq(cfps.eventId, event.id)))
    .limit(1);
  if (!existing) {
    return { ok: false, error: "not_found" };
  }
  if (existing.lockedAt) return { ok: false, error: "structure_locked" };

  try {
    const result = await database
      .update(cfps)
      .set({
        name: input.name,
        deadline: input.deadline,
        formatsJson: JSON.stringify(input.formats),
        customFieldsJson: JSON.stringify(input.customFields),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cfps.id, cfpId),
          eq(cfps.eventId, event.id),
          isNull(cfps.structureLockedAt),
        ),
      );
    if (result.meta.changes === 0) {
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
      status: existing.status,
      structureLocked: false,
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

  const [currentOpen] = await database
    .select()
    .from(cfps)
    .where(and(eq(cfps.eventId, event.id), eq(cfps.status, "open")))
    .limit(1);
  if (currentOpen && currentOpen.id !== cfpId) {
    return { ok: false, error: "already_open" };
  }
  if (currentOpen) return { ok: true, value: parseCfp(currentOpen) };

  const [target] = await database
    .select({ lockedAt: cfps.structureLockedAt, status: cfps.status })
    .from(cfps)
    .where(and(eq(cfps.id, cfpId), eq(cfps.eventId, event.id)))
    .limit(1);
  if (!target || target.status !== "draft") {
    return { ok: false, error: "not_found" };
  }
  if (target.lockedAt) return { ok: false, error: "structure_locked" };

  const [activeTrack] = await database
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.eventId, event.id), isNull(tracks.archivedAt)))
    .limit(1);
  if (!activeTrack) return { ok: false, error: "missing_track" };

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
          eq(cfps.status, "draft"),
        ),
      );
    if (result.meta.changes === 0) return { ok: false, error: "not_found" };
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
      timezone: events.timezone,
    })
    .from(cfps)
    .innerJoin(events, eq(events.id, cfps.eventId))
    .where(and(eq(events.slug, slug), eq(cfps.status, "open")))
    .limit(1);
  if (!row) return undefined;

  const activeTracks = await database
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(and(eq(tracks.eventId, row.eventId), isNull(tracks.archivedAt)))
    .orderBy(tracks.position);

  return cfpFormContractSchema.parse({
    event: {
      name: row.eventName,
      slug: row.eventSlug,
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
