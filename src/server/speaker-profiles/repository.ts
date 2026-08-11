import { eq } from "drizzle-orm";

import type { UserId } from "../../shared/events";
import {
  speakerProfileSchema,
  type SaveSpeakerProfileInput,
} from "../../shared/speaker-profiles";
import type { Database } from "../database/client";
import {
  speakerProfiles,
  storedFiles,
  submissionSpeakers,
} from "../database/schema";
import { compensateStoredFile, putStoredFile } from "../files/repository";

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
        headshotUrl: profile.headshotStoredFileId
          ? `/api/speaker-headshots/${profile.headshotStoredFileId}`
          : profile.headshotUrl,
        updatedAt: profile.updatedAt.toISOString(),
      })
    : null;
}

export async function getOwnSpeakerProfileState(
  database: Database,
  userId: UserId,
) {
  const [profile, eligible] = await Promise.all([
    findOwnSpeakerProfile(database, userId),
    hasClaimedSpeakerRelationship(database, userId),
  ]);
  return { eligible, profile };
}

type SaveSpeakerProfileResult =
  | {
      ok: true;
      value: NonNullable<Awaited<ReturnType<typeof findOwnSpeakerProfile>>>;
    }
  | {
      ok: false;
      error: "invalid_file" | "not_a_speaker" | "persistence_failed";
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
    })
    .from(speakerProfiles)
    .leftJoin(
      storedFiles,
      eq(speakerProfiles.headshotStoredFileId, storedFiles.id),
    )
    .where(eq(speakerProfiles.userId, userId))
    .limit(1);
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
    ...(stored?.ok
      ? {
          headshotUrl: null,
          headshotStoredFileId: stored.value.record.id,
        }
      : {}),
  };
  try {
    if (existing) {
      const update = database
        .update(speakerProfiles)
        .set(profileValues)
        .where(eq(speakerProfiles.id, existing.id));
      if (stored?.ok) {
        await database.batch([
          database.insert(storedFiles).values(stored.value.record),
          update,
        ]);
      } else {
        await update;
      }
    } else {
      const insert = database.insert(speakerProfiles).values({
        id: crypto.randomUUID(),
        userId,
        ...profileValues,
        createdAt: now,
      });
      if (stored?.ok) {
        await database.batch([
          database.insert(storedFiles).values(stored.value.record),
          insert,
        ]);
      } else {
        await insert;
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

  if (
    stored?.ok &&
    existing?.headshotStoredFileId &&
    existing.headshotObjectKey
  ) {
    await removeReplacedHeadshot(
      database,
      files,
      existing.headshotStoredFileId,
      existing.headshotObjectKey,
    );
  }
  const profile = await findOwnSpeakerProfile(database, userId);
  return profile
    ? { ok: true, value: profile }
    : { ok: false, error: "persistence_failed" };
}

export async function findPublicSpeakerHeadshot(
  database: Database,
  fileId: string,
) {
  const [headshot] = await database
    .select({
      objectKey: storedFiles.objectKey,
      fileName: storedFiles.fileName,
      contentType: storedFiles.contentType,
    })
    .from(speakerProfiles)
    .innerJoin(
      storedFiles,
      eq(speakerProfiles.headshotStoredFileId, storedFiles.id),
    )
    .where(eq(storedFiles.id, fileId))
    .limit(1);
  return headshot;
}

async function removeReplacedHeadshot(
  database: Database,
  files: R2Bucket,
  fileId: string,
  objectKey: string,
): Promise<void> {
  try {
    await files.delete(objectKey);
    await database.delete(storedFiles).where(eq(storedFiles.id, fileId));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "speaker_headshot_cleanup_failed",
        fileId,
        objectKey,
        error:
          error instanceof Error ? error.message : "Unknown cleanup failure",
      }),
    );
  }
}

function isValidHeadshot(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  }
  return (
    contentType === "image/webp" &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  );
}

async function hasClaimedSpeakerRelationship(
  database: Database,
  userId: UserId,
): Promise<boolean> {
  const [speaker] = await database
    .select({ id: submissionSpeakers.id })
    .from(submissionSpeakers)
    .where(eq(submissionSpeakers.claimedUserId, userId))
    .limit(1);
  return speaker !== undefined;
}
