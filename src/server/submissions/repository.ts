import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  customFieldsSchema,
  visibleCustomFields,
  type CustomField,
} from "../../shared/cfps";
import type { UserId } from "../../shared/events";
import {
  proposalAnswersSchema,
  submissionSchema,
  type ProposalContent,
  type Submission,
  type SubmissionId,
  type SubmitProposalInput,
} from "../../shared/submissions";
import type { Database } from "../database/client";
import {
  cfps,
  communications,
  decisions,
  events,
  formResponses,
  submissions,
  submissionSpeakers,
  tracks,
} from "../database/schema";

type ProposalWriteError =
  | "cfp_unavailable"
  | "cfp_changed"
  | "deadline_passed"
  | "invalid_answers"
  | "invalid_format"
  | "invalid_track"
  | "not_found"
  | "persistence_failed"
  | "submission_closed";

type ProposalWriteResult =
  { ok: true; value: Submission } | { ok: false; error: ProposalWriteError };

export async function submitProposal(
  database: Database,
  ownerUserId: UserId,
  ownerEmail: string,
  input: SubmitProposalInput,
): Promise<ProposalWriteResult> {
  const [existing] = await database
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.cfpId, input.cfpId),
        eq(submissions.ownerUserId, ownerUserId),
        eq(submissions.clientDraftId, input.clientDraftId),
      ),
    )
    .limit(1);
  if (existing) {
    const submission = await findOwnSubmission(
      database,
      ownerUserId,
      existing.id as SubmissionId,
    );
    return submission
      ? { ok: true, value: submission }
      : { ok: false, error: "persistence_failed" };
  }

  const validated = await validateProposal(
    database,
    input.slug,
    input.cfpId,
    input,
  );
  if (!validated.ok) return validated;

  const submissionId = crypto.randomUUID() as SubmissionId;
  const now = new Date();
  try {
    await database.batch([
      database.insert(submissions).values({
        id: submissionId,
        eventId: validated.eventId,
        cfpId: input.cfpId,
        cfpRevision: validated.revision,
        ownerUserId,
        clientDraftId: input.clientDraftId,
        trackId: input.trackId,
        title: input.title,
        abstract: input.abstract,
        format: input.format,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(decisions).values({
        id: crypto.randomUUID(),
        submissionId,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(submissionSpeakers).values(
        input.proposedSpeakers.map((speaker, position) => ({
          id: crypto.randomUUID(),
          submissionId,
          invitedName: speaker.name,
          invitedEmail: speaker.email,
          position,
          createdAt: now,
          updatedAt: now,
        })),
      ),
      database.insert(formResponses).values({
        id: crypto.randomUUID(),
        cfpId: input.cfpId,
        submissionId,
        answersJson: JSON.stringify(validated.answers),
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(communications).values({
        id: crypto.randomUUID(),
        submissionId,
        recipientUserId: ownerUserId,
        destination: ownerEmail.trim().toLowerCase(),
        purpose: "submission_confirmation",
        createdAt: now,
      }),
      database
        .update(cfps)
        .set({ structureLockedAt: now, updatedAt: now })
        .where(eq(cfps.id, input.cfpId)),
    ]);
  } catch (error: unknown) {
    if (String(error).includes("stale_cfp")) {
      return { ok: false, error: "cfp_changed" };
    }
    if (String(error).includes("UNIQUE constraint failed")) {
      const [raced] = await database
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.cfpId, input.cfpId),
            eq(submissions.ownerUserId, ownerUserId),
            eq(submissions.clientDraftId, input.clientDraftId),
          ),
        )
        .limit(1);
      const submission = raced
        ? await findOwnSubmission(
            database,
            ownerUserId,
            raced.id as SubmissionId,
          )
        : undefined;
      return submission
        ? { ok: true, value: submission }
        : { ok: false, error: "persistence_failed" };
    }
    return { ok: false, error: "persistence_failed" };
  }

  const submission = await findOwnSubmission(
    database,
    ownerUserId,
    submissionId,
  );
  return submission
    ? { ok: true, value: submission }
    : { ok: false, error: "persistence_failed" };
}

export async function findOwnSubmission(
  database: Database,
  ownerUserId: UserId,
  submissionId: SubmissionId,
): Promise<Submission | undefined> {
  const [row] = await database
    .select({
      id: submissions.id,
      status: submissions.status,
      title: submissions.title,
      abstract: submissions.abstract,
      format: submissions.format,
      eventName: events.name,
      eventSlug: events.slug,
      cfpId: cfps.id,
      cfpName: cfps.name,
      deadline: cfps.deadline,
      formatsJson: cfps.formatsJson,
      customFieldsJson: cfps.customFieldsJson,
      eventId: events.id,
      trackId: tracks.id,
      trackName: tracks.name,
      answersJson: formResponses.answersJson,
      decisionStatus: decisions.status,
      communicationId: communications.id,
    })
    .from(submissions)
    .innerJoin(events, eq(events.id, submissions.eventId))
    .innerJoin(cfps, eq(cfps.id, submissions.cfpId))
    .innerJoin(tracks, eq(tracks.id, submissions.trackId))
    .innerJoin(formResponses, eq(formResponses.submissionId, submissions.id))
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .innerJoin(
      communications,
      and(
        eq(communications.submissionId, submissions.id),
        eq(communications.purpose, "submission_confirmation"),
      ),
    )
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (!row) return undefined;

  const speakers = await database
    .select({
      id: submissionSpeakers.id,
      name: submissionSpeakers.invitedName,
      email: submissionSpeakers.invitedEmail,
    })
    .from(submissionSpeakers)
    .where(
      and(
        eq(submissionSpeakers.submissionId, submissionId),
        isNull(submissionSpeakers.removedAt),
      ),
    )
    .orderBy(submissionSpeakers.position);
  const formTracks = await database
    .select({
      id: tracks.id,
      name: tracks.name,
      archivedAt: tracks.archivedAt,
    })
    .from(tracks)
    .where(
      and(
        eq(tracks.eventId, row.eventId),
        or(isNull(tracks.archivedAt), eq(tracks.id, row.trackId)),
      ),
    )
    .orderBy(tracks.position);
  const published = isPublished(row.decisionStatus);
  const active = row.status === "active";

  return submissionSchema.parse({
    id: row.id,
    status: row.status,
    event: { name: row.eventName, slug: row.eventSlug },
    cfp: { id: row.cfpId, name: row.cfpName },
    title: row.title,
    abstract: row.abstract,
    format: row.format,
    track: { id: row.trackId, name: row.trackName },
    form: {
      deadline: row.deadline,
      formats: JSON.parse(row.formatsJson) as unknown,
      tracks: formTracks.map((track) => ({
        id: track.id,
        name: track.name,
        archived: track.archivedAt !== null,
      })),
      customFields: JSON.parse(row.customFieldsJson) as unknown,
    },
    proposedSpeakers: speakers,
    customAnswers: JSON.parse(row.answersJson) as unknown,
    decision: { status: row.decisionStatus },
    confirmation: { status: row.communicationId ? "recorded" : undefined },
    permissions: {
      canEdit: active && !published && new Date(row.deadline) > new Date(),
      canWithdraw: active && !published,
    },
  });
}

export async function listOwnSubmissions(
  database: Database,
  ownerUserId: UserId,
): Promise<Submission[]> {
  const rows = await database
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.ownerUserId, ownerUserId))
    .orderBy(desc(submissions.updatedAt));
  const owned = await Promise.all(
    rows.map(({ id }) =>
      findOwnSubmission(database, ownerUserId, id as SubmissionId),
    ),
  );
  return owned.filter((submission) => submission !== undefined);
}

export async function updateOwnSubmission(
  database: Database,
  ownerUserId: UserId,
  submissionId: SubmissionId,
  input: ProposalContent,
): Promise<ProposalWriteResult> {
  const [current] = await database
    .select({
      status: submissions.status,
      slug: events.slug,
      cfpId: submissions.cfpId,
      decisionStatus: decisions.status,
    })
    .from(submissions)
    .innerJoin(events, eq(events.id, submissions.eventId))
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, error: "not_found" };
  if (current.status !== "active" || isPublished(current.decisionStatus)) {
    return { ok: false, error: "submission_closed" };
  }

  const validated = await validateProposal(
    database,
    current.slug,
    current.cfpId,
    input,
  );
  if (!validated.ok) return validated;

  const now = new Date();
  try {
    const [submissionUpdateResult] = await database.batch([
      database
        .update(submissions)
        .set({
          trackId: input.trackId,
          title: input.title,
          abstract: input.abstract,
          format: input.format,
          updatedAt: now,
        })
        .where(
          and(
            eq(submissions.id, submissionId),
            eq(submissions.ownerUserId, ownerUserId),
            eq(submissions.status, "active"),
            exists(
              database
                .select({ id: decisions.id })
                .from(decisions)
                .where(
                  and(
                    eq(decisions.submissionId, submissionId),
                    notInArray(decisions.status, ["accepted", "declined"]),
                  ),
                ),
            ),
            exists(
              database
                .select({ id: cfps.id })
                .from(cfps)
                .innerJoin(
                  tracks,
                  and(
                    eq(tracks.id, input.trackId),
                    eq(tracks.eventId, cfps.eventId),
                    isNull(tracks.archivedAt),
                  ),
                )
                .where(
                  and(
                    eq(cfps.id, current.cfpId),
                    eq(cfps.status, "open"),
                    eq(cfps.updatedAt, validated.revision),
                    sql`julianday(${cfps.deadline}) > julianday('now')`,
                  ),
                ),
            ),
          ),
        ),
      database
        .update(submissionSpeakers)
        .set({ removedAt: now, updatedAt: now })
        .where(
          and(
            eq(submissionSpeakers.submissionId, submissionId),
            isNull(submissionSpeakers.removedAt),
          ),
        ),
      database.insert(submissionSpeakers).values(
        input.proposedSpeakers.map((speaker, position) => ({
          id: crypto.randomUUID(),
          submissionId,
          invitedName: speaker.name,
          invitedEmail: speaker.email,
          position,
          createdAt: now,
          updatedAt: now,
        })),
      ),
      database
        .update(formResponses)
        .set({
          answersJson: JSON.stringify(validated.answers),
          updatedAt: now,
        })
        .where(eq(formResponses.submissionId, submissionId)),
    ]);
    if (submissionUpdateResult.meta.changes === 0) {
      return { ok: false, error: "submission_closed" };
    }
  } catch (error: unknown) {
    if (String(error).includes("submission_closed")) {
      return { ok: false, error: "submission_closed" };
    }
    return { ok: false, error: "persistence_failed" };
  }

  const submission = await findOwnSubmission(
    database,
    ownerUserId,
    submissionId,
  );
  return submission
    ? { ok: true, value: submission }
    : { ok: false, error: "persistence_failed" };
}

export async function withdrawOwnSubmission(
  database: Database,
  ownerUserId: UserId,
  submissionId: SubmissionId,
): Promise<ProposalWriteResult> {
  const [current] = await database
    .select({ status: submissions.status, decisionStatus: decisions.status })
    .from(submissions)
    .innerJoin(decisions, eq(decisions.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, error: "not_found" };
  if (current.status !== "active" || isPublished(current.decisionStatus)) {
    return { ok: false, error: "submission_closed" };
  }

  const now = new Date();
  let submissionUpdateResult;
  try {
    [submissionUpdateResult] = await database.batch([
      database
        .update(submissions)
        .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
        .where(
          and(
            eq(submissions.id, submissionId),
            eq(submissions.ownerUserId, ownerUserId),
            eq(submissions.status, "active"),
            exists(
              database
                .select({ id: decisions.id })
                .from(decisions)
                .where(
                  and(
                    eq(decisions.submissionId, submissionId),
                    notInArray(decisions.status, ["accepted", "declined"]),
                  ),
                ),
            ),
          ),
        ),
      database
        .update(decisions)
        .set({ status: "pending", updatedAt: now })
        .where(
          and(
            eq(decisions.submissionId, submissionId),
            inArray(decisions.status, ["accept_queued", "decline_queued"]),
            exists(
              database
                .select({ id: submissions.id })
                .from(submissions)
                .where(
                  and(
                    eq(submissions.id, submissionId),
                    eq(submissions.ownerUserId, ownerUserId),
                    eq(submissions.status, "withdrawn"),
                    eq(submissions.updatedAt, now),
                  ),
                ),
            ),
          ),
        ),
    ]);
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  if (submissionUpdateResult.meta.changes === 0) {
    return { ok: false, error: "submission_closed" };
  }

  const submission = await findOwnSubmission(
    database,
    ownerUserId,
    submissionId,
  );
  return submission
    ? { ok: true, value: submission }
    : { ok: false, error: "persistence_failed" };
}

async function validateProposal(
  database: Database,
  slug: string,
  cfpId: string,
  input: ProposalContent,
): Promise<
  | {
      ok: true;
      eventId: string;
      revision: Date;
      answers: Record<string, string>;
    }
  | { ok: false; error: ProposalWriteError }
> {
  const [definition] = await database
    .select({
      eventId: events.id,
      deadline: cfps.deadline,
      formatsJson: cfps.formatsJson,
      customFieldsJson: cfps.customFieldsJson,
      updatedAt: cfps.updatedAt,
      trackId: tracks.id,
    })
    .from(cfps)
    .innerJoin(events, eq(events.id, cfps.eventId))
    .leftJoin(
      tracks,
      and(
        eq(tracks.id, input.trackId),
        eq(tracks.eventId, events.id),
        isNull(tracks.archivedAt),
      ),
    )
    .where(
      and(eq(cfps.id, cfpId), eq(events.slug, slug), eq(cfps.status, "open")),
    )
    .limit(1);
  if (!definition) return { ok: false, error: "cfp_unavailable" };
  if (new Date(definition.deadline) <= new Date()) {
    return { ok: false, error: "deadline_passed" };
  }
  if (!definition.trackId) return { ok: false, error: "invalid_track" };

  const formats = parseStringArray(
    JSON.parse(definition.formatsJson) as unknown,
  );
  if (!formats?.includes(input.format)) {
    return { ok: false, error: "invalid_format" };
  }

  const fields = customFieldsSchema.safeParse(
    JSON.parse(definition.customFieldsJson) as unknown,
  );
  const answers = proposalAnswersSchema.safeParse(input.customAnswers);
  if (!fields.success || !answers.success) {
    return { ok: false, error: "invalid_answers" };
  }

  const fieldKeys = new Set(fields.data.map((field) => field.key));
  const currentAnswers = Object.fromEntries(
    Object.entries(answers.data)
      .filter(([key]) => fieldKeys.has(key))
      .map(([key, value]) => [key, value.trim()]),
  );
  const visible = visibleCustomFields(fields.data, currentAnswers);
  if (visible.some((field) => !validAnswer(field, currentAnswers[field.key]))) {
    return { ok: false, error: "invalid_answers" };
  }

  return {
    ok: true,
    eventId: definition.eventId,
    revision: definition.updatedAt,
    answers: Object.fromEntries(
      visible.flatMap((field) => {
        const value = currentAnswers[field.key];
        return value ? [[field.key, value]] : [];
      }),
    ),
  };
}

function isPublished(status: typeof decisions.$inferSelect.status): boolean {
  return status === "accepted" || status === "declined";
}

function validAnswer(field: CustomField, value: string | undefined): boolean {
  const answer = value?.trim() ?? "";
  if (!answer) return !field.required;
  return field.type !== "single_select" || field.options.includes(answer);
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
