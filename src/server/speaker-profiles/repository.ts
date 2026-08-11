import { desc, eq } from "drizzle-orm";

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
  return (await findClaimedSpeakerName(database, userId)) !== null;
}

async function findClaimedSpeakerName(
  database: Database,
  userId: UserId,
): Promise<string | null> {
  const [speaker] = await database
    .select({ name: submissionSpeakers.invitedName })
    .from(submissionSpeakers)
    .where(eq(submissionSpeakers.claimedUserId, userId))
    .orderBy(desc(submissionSpeakers.updatedAt), desc(submissionSpeakers.id))
    .limit(1);
  return speaker?.name ?? null;
}
