import { and, eq, like } from "drizzle-orm";

import type { UserId } from "../../shared/events";
import {
  speakerProfileSchema,
  type SpeakerHeadshotUpload,
  type SpeakerProfileInput,
} from "../../shared/speaker-profiles";
import type { Database } from "../database/client";
import {
  speakerProfileHeadshots,
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
  | { ok: false; error: "not_a_speaker" | "persistence_failed" };

export async function saveOwnSpeakerProfile(
  database: Database,
  userId: UserId,
  input: SpeakerProfileInput,
): Promise<SaveSpeakerProfileResult> {
  if (!(await hasClaimedSpeakerRelationship(database, userId))) {
    return { ok: false, error: "not_a_speaker" };
  }

  const [existing] = await database
    .select({ id: speakerProfiles.id })
    .from(speakerProfiles)
    .where(eq(speakerProfiles.userId, userId))
    .limit(1);
  const now = new Date();
  try {
    if (existing) {
      await database
        .update(speakerProfiles)
        .set({ ...input, updatedAt: now })
        .where(eq(speakerProfiles.id, existing.id));
    } else {
      await database.insert(speakerProfiles).values({
        id: crypto.randomUUID(),
        userId,
        ...input,
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch {
    return { ok: false, error: "persistence_failed" };
  }

  const profile = await findOwnSpeakerProfile(database, userId);
  return profile
    ? { ok: true, value: profile }
    : { ok: false, error: "persistence_failed" };
}

type UploadSpeakerHeadshotResult =
  | {
      ok: true;
      value: NonNullable<Awaited<ReturnType<typeof findOwnSpeakerProfile>>>;
    }
  | {
      ok: false;
      error:
        | "invalid_file"
        | "not_a_speaker"
        | "profile_required"
        | "persistence_failed";
    };

export async function uploadOwnSpeakerHeadshot(
  database: Database,
  files: R2Bucket,
  userId: UserId,
  input: SpeakerHeadshotUpload,
): Promise<UploadSpeakerHeadshotResult> {
  if (!(await hasClaimedSpeakerRelationship(database, userId))) {
    return { ok: false, error: "not_a_speaker" };
  }

  const [profile] = await database
    .select({ id: speakerProfiles.id })
    .from(speakerProfiles)
    .where(eq(speakerProfiles.userId, userId))
    .limit(1);
  if (!profile) return { ok: false, error: "profile_required" };

  const stored = await putStoredFile(
    files,
    userId,
    `speaker-headshots/${userId}`,
    input,
  );
  if (!stored.ok) {
    return {
      ok: false,
      error:
        stored.error === "invalid_file" ? "invalid_file" : "persistence_failed",
    };
  }

  const now = new Date();
  try {
    await database.batch([
      database.insert(storedFiles).values(stored.value.record),
      database
        .insert(speakerProfileHeadshots)
        .values({
          speakerProfileId: profile.id,
          storedFileId: stored.value.record.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: speakerProfileHeadshots.speakerProfileId,
          set: { storedFileId: stored.value.record.id, updatedAt: now },
        }),
      database
        .update(speakerProfiles)
        .set({
          headshotUrl: `/api/speaker-headshots/${stored.value.record.id}`,
          updatedAt: now,
        })
        .where(eq(speakerProfiles.id, profile.id)),
    ]);
  } catch {
    await compensateStoredFile(
      files,
      stored.value.objectKey,
      "speaker_headshot_compensation_failed",
    );
    return { ok: false, error: "persistence_failed" };
  }

  const saved = await findOwnSpeakerProfile(database, userId);
  return saved
    ? { ok: true, value: saved }
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
    .from(storedFiles)
    .where(
      and(
        eq(storedFiles.id, fileId),
        like(storedFiles.objectKey, "speaker-headshots/%"),
      ),
    )
    .limit(1);
  return headshot;
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
