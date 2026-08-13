import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { UserId } from "../../shared/events";
import type { StoredFileId } from "../../shared/files";
import {
  speakerProfileSchema,
  type SaveSpeakerProfileInput,
} from "../../shared/speaker-profiles";
import type { Database } from "../database/client";
import {
  publishedAgendaSpeakers,
  speakerProfiles,
  storedFiles,
  submissionSpeakers,
} from "../database/schema";
import {
  compensateStoredFile,
  matchesStoredFileContentType,
  putStoredFile,
} from "../files/repository";

export async function findOwnSpeakerProfile(
  database: Database,
  userId: UserId,
) {
  const [profile] = await database
    .select()
    .from(speakerProfiles)
    .where(eq(speakerProfiles.userId, userId))
    .limit(1);
  return profile
    ? speakerProfileSchema.parse({
        ...profile,
        headshotUrl: speakerHeadshotUrl(profile),
        updatedAt: profile.updatedAt.toISOString(),
      })
    : null;
}

export async function getOwnSpeakerProfileState(
  database: Database,
  userId: UserId,
) {
  const [profile, suggestedDisplayName] = await Promise.all([
    findOwnSpeakerProfile(database, userId),
    findClaimedSpeakerName(database, userId),
  ]);
  return {
    eligible: suggestedDisplayName !== null,
    profile,
    suggestedDisplayName: profile ? null : suggestedDisplayName,
  };
}

type SaveSpeakerProfileResult =
  | {
      ok: true;
      value: NonNullable<Awaited<ReturnType<typeof findOwnSpeakerProfile>>>;
    }
  | {
      ok: false;
      error:
        | "invalid_file"
        | "not_a_speaker"
        | "profile_conflict"
        | "persistence_failed";
    };

export async function saveOwnSpeakerProfile(
  database: Database,
  files: R2Bucket,
  userId: UserId,
  input: SaveSpeakerProfileInput,
): Promise<SaveSpeakerProfileResult> {
  if (!(await hasClaimedSpeakerRelationship(database, userId))) {
    return { ok: false, error: "not_a_speaker" };
  }

  const [existing] = await database
    .select({
      id: speakerProfiles.id,
      headshotStoredFileId: speakerProfiles.headshotStoredFileId,
      headshotObjectKey: storedFiles.objectKey,
      revision: speakerProfiles.revision,
    })
    .from(speakerProfiles)
    .leftJoin(
      storedFiles,
      eq(speakerProfiles.headshotStoredFileId, storedFiles.id),
    )
    .where(eq(speakerProfiles.userId, userId))
    .limit(1);
  if (
    (existing && input.expectedRevision !== existing.revision) ||
    (!existing && input.expectedRevision !== null)
  ) {
    return { ok: false, error: "profile_conflict" };
  }
  const stored = input.headshot
    ? await putStoredFile(
        files,
        userId,
        `speaker-headshots/${userId}`,
        input.headshot,
        isValidHeadshot,
      )
    : undefined;
  if (stored && !stored.ok) {
    return {
      ok: false,
      error:
        stored.error === "invalid_file" ? "invalid_file" : "persistence_failed",
    };
  }

  const now = new Date();
  const profileValues = {
    displayName: input.displayName,
    bio: input.bio,
    updatedAt: now,
    ...(existing ? { revision: sql`${speakerProfiles.revision} + 1` } : {}),
    ...(stored?.ok
      ? {
          headshotUrl: null,
          headshotStoredFileId: stored.value.record.id,
        }
      : {}),
  };
  let conflict: "profile_conflict" | undefined;
  try {
    if (existing) {
      const update = database
        .update(speakerProfiles)
        .set(profileValues)
        .where(
          and(
            eq(speakerProfiles.id, existing.id),
            eq(speakerProfiles.revision, existing.revision),
            stored?.ok
              ? existing.headshotStoredFileId
                ? eq(
                    speakerProfiles.headshotStoredFileId,
                    existing.headshotStoredFileId,
                  )
                : isNull(speakerProfiles.headshotStoredFileId)
              : undefined,
          ),
        );
      if (stored?.ok) {
        const [, updated] = await database.batch([
          database.insert(storedFiles).values(stored.value.record),
          update,
        ]);
        if (updated.meta.changes === 0) conflict = "profile_conflict";
      } else {
        const updated = await update;
        if (updated.meta.changes === 0) conflict = "profile_conflict";
      }
    } else {
      const insert = database
        .insert(speakerProfiles)
        .values({
          id: crypto.randomUUID(),
          userId,
          ...profileValues,
          createdAt: now,
        })
        .onConflictDoNothing({ target: speakerProfiles.userId });
      if (stored?.ok) {
        const [, inserted] = await database.batch([
          database.insert(storedFiles).values(stored.value.record),
          insert,
        ]);
        if (inserted.meta.changes === 0) conflict = "profile_conflict";
      } else {
        const inserted = await insert;
        if (inserted.meta.changes === 0) conflict = "profile_conflict";
      }
    }
  } catch {
    if (stored?.ok) {
      await compensateStoredFile(
        files,
        stored.value.record.objectKey,
        "speaker_headshot_compensation_failed",
      );
    }
    return { ok: false, error: "persistence_failed" };
  }

  if (conflict) {
    if (stored?.ok) {
      await removeStoredHeadshot(
        database,
        files,
        stored.value.record.id,
        stored.value.record.objectKey,
        "speaker_headshot_conflict_cleanup_failed",
      );
    }
    return { ok: false, error: conflict };
  }
  if (
    stored?.ok &&
    existing?.headshotStoredFileId &&
    existing.headshotObjectKey
  ) {
    await removeStoredHeadshot(
      database,
      files,
      existing.headshotStoredFileId,
      existing.headshotObjectKey,
      "speaker_headshot_cleanup_failed",
    );
  }
  const profile = await findOwnSpeakerProfile(database, userId);
  return profile
    ? { ok: true, value: profile }
    : { ok: false, error: "persistence_failed" };
}

export async function findSpeakerHeadshot(
  database: Database,
  fileId: StoredFileId,
) {
  const [headshot] = await database
    .select({
      objectKey: storedFiles.objectKey,
      fileName: storedFiles.fileName,
      contentType: storedFiles.contentType,
    })
    .from(storedFiles)
    .where(eq(storedFiles.id, fileId))
    .limit(1);
  if (!headshot) return undefined;
  const references = await findHeadshotReferences(database, fileId);
  if (references.published) return { ...headshot, access: "public" as const };
  return references.ownerUserId
    ? {
        ...headshot,
        access: "owner" as const,
        ownerUserId: references.ownerUserId,
      }
    : undefined;
}

export function speakerHeadshotUrl(profile: {
  headshotStoredFileId: string | null;
  headshotUrl: string | null;
}): string | null {
  return profile.headshotStoredFileId
    ? `/api/speaker-headshots/${profile.headshotStoredFileId}`
    : profile.headshotUrl;
}

async function removeStoredHeadshot(
  database: Database,
  files: R2Bucket,
  fileId: string,
  objectKey: string,
  event: string,
): Promise<void> {
  try {
    const references = await findHeadshotReferences(database, fileId);
    if (references.ownerUserId || references.published) return;
    await files.delete(objectKey);
    await database.delete(storedFiles).where(eq(storedFiles.id, fileId));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event,
        fileId,
        objectKey,
        error:
          error instanceof Error ? error.message : "Unknown cleanup failure",
      }),
    );
  }
}

async function findHeadshotReferences(database: Database, fileId: string) {
  const path = `/api/speaker-headshots/${fileId}`;
  const [current, published] = await Promise.all([
    database
      .select({ userId: speakerProfiles.userId })
      .from(speakerProfiles)
      .where(eq(speakerProfiles.headshotStoredFileId, fileId))
      .limit(1),
    database
      .select({ id: publishedAgendaSpeakers.id })
      .from(publishedAgendaSpeakers)
      .where(eq(publishedAgendaSpeakers.headshotUrl, path))
      .limit(1),
  ]);
  return {
    ownerUserId: current[0]?.userId,
    published: published.length > 0,
  };
}

function isValidHeadshot(bytes: Uint8Array, contentType: string): boolean {
  return matchesStoredFileContentType(bytes, contentType);
}

async function hasClaimedSpeakerRelationship(
  database: Database,
  userId: UserId,
): Promise<boolean> {
  return (await findClaimedSpeakerName(database, userId)) !== null;
}

async function findClaimedSpeakerName(
  database: Database,
  userId: UserId,
): Promise<string | null> {
  const [speaker] = await database
    .select({ name: submissionSpeakers.invitedName })
    .from(submissionSpeakers)
    .where(
      and(
        eq(submissionSpeakers.claimedUserId, userId),
        isNull(submissionSpeakers.removedAt),
      ),
    )
    .orderBy(desc(submissionSpeakers.updatedAt), desc(submissionSpeakers.id))
    .limit(1);
  return speaker?.name ?? null;
}
