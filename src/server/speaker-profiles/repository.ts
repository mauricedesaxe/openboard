import { eq } from "drizzle-orm";

import type { UserId } from "../../shared/events";
import {
  speakerProfileSchema,
  type SpeakerProfileInput,
} from "../../shared/speaker-profiles";
import type { Database } from "../database/client";
import { speakerProfiles, submissionSpeakers } from "../database/schema";

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
