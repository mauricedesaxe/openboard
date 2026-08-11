import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notExists,
  or,
} from "drizzle-orm";

import type { UserId } from "../../shared/events";
import {
  MAX_TASK_FILE_BYTES,
  onboardingFormFieldSchema,
  profileSatisfiesRequirement,
  type CreateTaskAssignmentInput,
  type CreateTaskDefinitionInput,
  type TaskAssignmentId,
  type TaskDefinitionId,
  type TaskEvidenceId,
} from "../../shared/onboarding";
import type { Database } from "../database/client";
import {
  onboardingFormResponses,
  events,
  programItems,
  speakerProfiles,
  storedFiles,
  submissions,
  submissionSpeakers,
  taskAssignmentAttachments,
  taskAssignmentRevisions,
  taskAssignments,
  taskDefinitions,
  taskEvidence,
  taskEvidenceRejections,
  taskEvidenceSupersessions,
  taskReminders,
  user,
} from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

export type OnboardingWriteError =
  | "already_rejected"
  | "invalid_answers"
  | "invalid_assignment"
  | "invalid_mechanism"
  | "not_found"
  | "persistence_failed"
  | "current_evidence_exists";

type WriteResult<T> =
  { ok: true; value: T } | { ok: false; error: OnboardingWriteError };

type AssignmentRow = Awaited<ReturnType<typeof findAssignment>>;

export async function createTaskDefinition(
  database: Database,
  actorUserId: UserId,
  input: CreateTaskDefinitionInput,
): Promise<WriteResult<{ id: TaskDefinitionId }>> {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false, error: "not_found" };

  const id = crypto.randomUUID() as TaskDefinitionId;
  try {
    await database.insert(taskDefinitions).values({
      id,
      eventId: event.id,
      name: input.name,
      scope: input.scope,
      completionMechanism: input.completionMechanism,
      profileRequirement: input.profileRequirement,
      formSchemaJson:
        input.formFields === null ? null : JSON.stringify(input.formFields),
      createdByUserId: actorUserId,
      createdAt: new Date(),
    });
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { id } };
}

export async function createTaskAssignment(
  database: Database,
  actorUserId: UserId,
  input: CreateTaskAssignmentInput,
): Promise<WriteResult<{ id: TaskAssignmentId }>> {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false, error: "not_found" };
  const [definition] = await database
    .select()
    .from(taskDefinitions)
    .where(
      and(
        eq(taskDefinitions.id, input.taskDefinitionId),
        eq(taskDefinitions.eventId, event.id),
      ),
    )
    .limit(1);
  if (!definition || definition.scope !== input.target.scope) {
    return { ok: false, error: "invalid_assignment" };
  }
  if (!(await targetBelongsToEvent(database, event.id, input.target))) {
    return { ok: false, error: "invalid_assignment" };
  }

  const id = crypto.randomUUID() as TaskAssignmentId;
  const now = new Date();
  try {
    await database.batch([
      database.insert(taskAssignments).values({
        id,
        taskDefinitionId: definition.id,
        eventId: event.id,
        targetUserId:
          input.target.scope === "event_speaker" ? input.target.userId : null,
        targetProgramItemId:
          input.target.scope === "program_item"
            ? input.target.programItemId
            : null,
        targetSubmissionSpeakerId:
          input.target.scope === "program_item_speaker"
            ? input.target.submissionSpeakerId
            : null,
        required: input.required,
        dueAt: input.dueAt,
        completionRevision: 1,
        assignedByUserId: actorUserId,
        createdAt: now,
      }),
      database.insert(taskAssignmentRevisions).values({
        assignmentId: id,
        revision: 1,
        openedByUserId: actorUserId,
        reason: null,
        createdAt: now,
      }),
    ]);
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { id } };
}

export async function getOrganizerOnboardingBoard(
  database: Database,
  actorUserId: UserId,
  slug: string,
) {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return undefined;

  const [definitions, assignments, targetRows] = await Promise.all([
    database
      .select()
      .from(taskDefinitions)
      .where(eq(taskDefinitions.eventId, event.id))
      .orderBy(asc(taskDefinitions.createdAt)),
    listEventAssignments(database, event.id),
    listEventTargets(database, event.id),
  ]);
  const assignmentStates = await Promise.all(
    assignments.map(async (assignment) => ({
      ...presentAssignment(assignment),
      completed: await assignmentIsComplete(database, assignment),
      evidence: await listAssignmentEvidence(database, assignment.id),
      lastReminderAt: await findLastReminder(database, assignment.id),
    })),
  );
  const requiredIncomplete = assignmentStates.filter(
    (assignment) => assignment.required && !assignment.completed,
  );
  const readinessSpeakers = readinessSpeakerRows(targetRows);
  const speakers = readinessSpeakers.filter(
    (speaker): speaker is typeof speaker & { userId: string } =>
      speaker.userId !== null,
  );
  const programItemsWithReadiness = targetRows.map((programItem) => {
    const speakerIds = programItem.speakers.map((speaker) => speaker.id);
    const speakerUserIds = programItem.speakers.flatMap((speaker) =>
      speaker.userId ? [speaker.userId] : [],
    );
    const blockers = requiredIncomplete.filter(
      (assignment) =>
        assignment.targetProgramItemId === programItem.id ||
        (assignment.targetSubmissionSpeakerId !== null &&
          speakerIds.includes(assignment.targetSubmissionSpeakerId)) ||
        (assignment.targetUserId !== null &&
          speakerUserIds.includes(assignment.targetUserId)),
    );
    return {
      ...programItem,
      ready: blockers.length === 0,
      blockers: blockers.map(blockerSummary),
      nextDueAt: earliestDueAt(blockers),
    };
  });

  return {
    definitions: definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      scope: definition.scope,
      completionMechanism: definition.completionMechanism,
      profileRequirement: definition.profileRequirement,
      formFields: parseOnboardingFormFields(definition.formSchemaJson),
    })),
    assignments: assignmentStates,
    targets: { speakers, programItems: targetRows },
    readiness: {
      speakers: readinessSpeakers.map((speaker) => {
        const blockers = requiredIncomplete.filter(
          (assignment) =>
            (speaker.userId !== null &&
              assignment.targetUserId === speaker.userId) ||
            (assignment.targetSubmissionSpeakerId !== null &&
              speaker.relationshipIds.includes(
                assignment.targetSubmissionSpeakerId,
              )),
        );
        return {
          ...speaker,
          ready: blockers.length === 0,
          blockers: blockers.map(blockerSummary),
          nextDueAt: earliestDueAt(blockers),
        };
      }),
      programItems: programItemsWithReadiness,
    },
  };
}

export async function listOwnOnboardingAssignments(
  database: Database,
  userId: UserId,
) {
  const assignments = await listAccessibleAssignments(database, userId);
  return Promise.all(
    assignments.map(async (assignment) => ({
      ...presentAssignment(assignment),
      completed: await assignmentIsComplete(database, assignment),
      evidence: await listAssignmentEvidence(database, assignment.id),
      draft:
        assignment.completionMechanism === "form"
          ? await findCurrentFormDraft(database, assignment)
          : null,
    })),
  );
}

export async function confirmManualTask(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
): Promise<WriteResult<{ evidenceId: TaskEvidenceId }>> {
  const assignment = await findAccessibleAssignment(
    database,
    actorUserId,
    assignmentId,
  );
  if (!assignment) return { ok: false, error: "not_found" };
  if (assignment.completionMechanism !== "manual") {
    return { ok: false, error: "invalid_mechanism" };
  }
  return insertEvidence(database, assignment, actorUserId, "manual", {});
}

export async function cancelTaskAssignment(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
): Promise<WriteResult<{ canceled: true }>> {
  const [assignment] = await database
    .select({
      eventId: taskAssignments.eventId,
      canceledAt: taskAssignments.canceledAt,
    })
    .from(taskAssignments)
    .where(eq(taskAssignments.id, assignmentId))
    .limit(1);
  if (!assignment) return { ok: false, error: "not_found" };
  if (
    !(await findOrganizerEventById(database, actorUserId, assignment.eventId))
  ) {
    return { ok: false, error: "not_found" };
  }
  if (assignment.canceledAt) return { ok: true, value: { canceled: true } };
  const result = await database
    .update(taskAssignments)
    .set({ canceledAt: new Date(), canceledByUserId: actorUserId })
    .where(
      and(
        eq(taskAssignments.id, assignmentId),
        isNull(taskAssignments.canceledAt),
      ),
    );
  if (result.meta.changes > 0) {
    return { ok: true, value: { canceled: true } };
  }
  const [raced] = await database
    .select({ canceledAt: taskAssignments.canceledAt })
    .from(taskAssignments)
    .where(eq(taskAssignments.id, assignmentId))
    .limit(1);
  return raced?.canceledAt
    ? { ok: true, value: { canceled: true } }
    : { ok: false, error: "invalid_assignment" };
}

export async function saveOnboardingFormDraft(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
  answers: Record<string, string>,
): Promise<WriteResult<{ responseId: string }>> {
  const assignment = await findAccessibleAssignment(
    database,
    actorUserId,
    assignmentId,
  );
  if (!assignment) return { ok: false, error: "not_found" };
  if (assignment.completionMechanism !== "form") {
    return { ok: false, error: "invalid_mechanism" };
  }
  const now = new Date();
  const draft = await findCurrentFormDraft(database, assignment);
  try {
    if (draft) {
      await database
        .update(onboardingFormResponses)
        .set({ answersJson: JSON.stringify(answers), updatedAt: now })
        .where(eq(onboardingFormResponses.id, draft.id));
      return { ok: true, value: { responseId: draft.id } };
    }
    const responseId = crypto.randomUUID();
    await database.insert(onboardingFormResponses).values({
      id: responseId,
      assignmentId: assignment.id,
      completionRevision: assignment.completionRevision,
      answersJson: JSON.stringify(answers),
      createdByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, value: { responseId } };
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
}

export async function submitOnboardingForm(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
): Promise<WriteResult<{ evidenceId: TaskEvidenceId }>> {
  const assignment = await findAccessibleAssignment(
    database,
    actorUserId,
    assignmentId,
  );
  if (!assignment) return { ok: false, error: "not_found" };
  if (assignment.completionMechanism !== "form") {
    return { ok: false, error: "invalid_mechanism" };
  }
  const draft = await findCurrentFormDraft(database, assignment);
  if (
    !draft ||
    !formAnswersAreValid(assignment.formSchemaJson, draft.answers)
  ) {
    return { ok: false, error: "invalid_answers" };
  }
  const evidenceId = crypto.randomUUID() as TaskEvidenceId;
  const now = new Date();
  try {
    await database.batch([
      database
        .update(onboardingFormResponses)
        .set({ submittedAt: now, updatedAt: now })
        .where(
          and(
            eq(onboardingFormResponses.id, draft.id),
            isNull(onboardingFormResponses.submittedAt),
          ),
        ),
      database.insert(taskEvidence).values({
        id: evidenceId,
        assignmentId: assignment.id,
        completionRevision: assignment.completionRevision,
        kind: "form",
        actorUserId,
        formResponseId: draft.id,
        createdAt: now,
      }),
    ]);
  } catch (error: unknown) {
    return {
      ok: false,
      error: String(error).includes("current_form_evidence_exists")
        ? "current_evidence_exists"
        : "persistence_failed",
    };
  }
  return { ok: true, value: { evidenceId } };
}

export async function attachTaskFile(
  database: Database,
  files: R2Bucket,
  actorUserId: UserId,
  input: {
    assignmentId: TaskAssignmentId;
    fileName: string;
    contentType: string;
    contentBase64: string;
  },
): Promise<WriteResult<{ evidenceId: TaskEvidenceId; fileId: string }>> {
  const assignment = await findAccessibleAssignment(
    database,
    actorUserId,
    input.assignmentId,
  );
  if (!assignment) return { ok: false, error: "not_found" };
  if (assignment.completionMechanism !== "file") {
    return { ok: false, error: "invalid_mechanism" };
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(input.contentBase64), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return { ok: false, error: "invalid_answers" };
  }
  if (bytes.byteLength > MAX_TASK_FILE_BYTES) {
    return { ok: false, error: "invalid_answers" };
  }
  const fileId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID() as TaskEvidenceId;
  const objectKey = `task-files/${assignment.eventId}/${assignment.id}/${fileId}`;
  const current = await findCurrentFileEvidence(database, assignment);
  const now = new Date();
  try {
    await files.put(objectKey, bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { fileName: input.fileName },
    });
    const storedFileInsert = database.insert(storedFiles).values({
      id: fileId,
      objectKey,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
      uploadedByUserId: actorUserId,
      createdAt: now,
    });
    const attachmentInsert = database.insert(taskAssignmentAttachments).values({
      id: attachmentId,
      assignmentId: assignment.id,
      completionRevision: assignment.completionRevision,
      storedFileId: fileId,
      attachedByUserId: actorUserId,
      createdAt: now,
    });
    const evidenceInsert = database.insert(taskEvidence).values({
      id: evidenceId,
      assignmentId: assignment.id,
      completionRevision: assignment.completionRevision,
      kind: "file" as const,
      actorUserId,
      attachmentId,
      createdAt: now,
    });
    if (current) {
      await database.batch([
        storedFileInsert,
        attachmentInsert,
        evidenceInsert,
        database.insert(taskEvidenceSupersessions).values({
          previousEvidenceId: current.evidenceId,
          replacementEvidenceId: evidenceId,
          supersededByUserId: actorUserId,
          createdAt: now,
        }),
      ]);
    } else {
      await database.batch([
        storedFileInsert,
        attachmentInsert,
        evidenceInsert,
      ]);
    }
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { evidenceId, fileId } };
}

export async function waiveTask(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
  reason: string,
): Promise<WriteResult<{ evidenceId: TaskEvidenceId }>> {
  return addOrganizerEvidence(
    database,
    actorUserId,
    assignmentId,
    "waiver",
    reason,
  );
}

export async function overrideTask(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
  reason: string,
): Promise<WriteResult<{ evidenceId: TaskEvidenceId }>> {
  return addOrganizerEvidence(
    database,
    actorUserId,
    assignmentId,
    "organizer_override",
    reason,
  );
}

export async function rejectTaskEvidence(
  database: Database,
  actorUserId: UserId,
  evidenceId: TaskEvidenceId,
  reason: string,
): Promise<WriteResult<{ rejected: true }>> {
  const [evidence] = await database
    .select({ id: taskEvidence.id, eventId: taskAssignments.eventId })
    .from(taskEvidence)
    .innerJoin(
      taskAssignments,
      eq(taskAssignments.id, taskEvidence.assignmentId),
    )
    .where(eq(taskEvidence.id, evidenceId))
    .limit(1);
  if (!evidence) return { ok: false, error: "not_found" };
  const event = await findOrganizerEventById(
    database,
    actorUserId,
    evidence.eventId,
  );
  if (!event) return { ok: false, error: "not_found" };
  try {
    await database.insert(taskEvidenceRejections).values({
      evidenceId,
      rejectedByUserId: actorUserId,
      reason,
      createdAt: new Date(),
    });
  } catch (error: unknown) {
    return {
      ok: false,
      error: String(error).includes("UNIQUE constraint failed")
        ? "already_rejected"
        : "persistence_failed",
    };
  }
  return { ok: true, value: { rejected: true } };
}

export async function reopenTaskAssignment(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
  reason: string,
): Promise<WriteResult<{ revision: number }>> {
  const assignment = await findAssignment(database, assignmentId);
  if (!assignment) return { ok: false, error: "not_found" };
  if (
    !(await findOrganizerEventById(database, actorUserId, assignment.eventId))
  ) {
    return { ok: false, error: "not_found" };
  }
  const nextRevision = assignment.completionRevision + 1;
  const now = new Date();
  try {
    const [updated] = await database.batch([
      database
        .update(taskAssignments)
        .set({ completionRevision: nextRevision })
        .where(
          and(
            eq(taskAssignments.id, assignmentId),
            eq(
              taskAssignments.completionRevision,
              assignment.completionRevision,
            ),
            isNull(taskAssignments.canceledAt),
          ),
        ),
      database.insert(taskAssignmentRevisions).values({
        assignmentId,
        revision: nextRevision,
        openedByUserId: actorUserId,
        reason,
        createdAt: now,
      }),
    ]);
    if (updated.meta.changes === 0) {
      return { ok: false, error: "invalid_assignment" };
    }
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { revision: nextRevision } };
}

export async function recordTaskReminder(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
): Promise<WriteResult<{ reminderId: string }>> {
  const assignment = await findAssignment(database, assignmentId);
  if (!assignment) return { ok: false, error: "not_found" };
  if (
    !(await findOrganizerEventById(database, actorUserId, assignment.eventId))
  ) {
    return { ok: false, error: "not_found" };
  }
  const reminderId = crypto.randomUUID();
  try {
    await database.insert(taskReminders).values({
      id: reminderId,
      assignmentId,
      sentByUserId: actorUserId,
      createdAt: new Date(),
    });
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { reminderId } };
}

async function addOrganizerEvidence(
  database: Database,
  actorUserId: UserId,
  assignmentId: TaskAssignmentId,
  kind: "waiver" | "organizer_override",
  reason: string,
): Promise<WriteResult<{ evidenceId: TaskEvidenceId }>> {
  const assignment = await findAssignment(database, assignmentId);
  if (!assignment) return { ok: false, error: "not_found" };
  if (
    !(await findOrganizerEventById(database, actorUserId, assignment.eventId))
  ) {
    return { ok: false, error: "not_found" };
  }
  return insertEvidence(database, assignment, actorUserId, kind, { reason });
}

async function insertEvidence(
  database: Database,
  assignment: NonNullable<AssignmentRow>,
  actorUserId: UserId,
  kind: "manual" | "waiver" | "organizer_override",
  source: { reason?: string },
): Promise<WriteResult<{ evidenceId: TaskEvidenceId }>> {
  const evidenceId = crypto.randomUUID() as TaskEvidenceId;
  try {
    await database.insert(taskEvidence).values({
      id: evidenceId,
      assignmentId: assignment.id,
      completionRevision: assignment.completionRevision,
      kind,
      actorUserId,
      reason: source.reason,
      createdAt: new Date(),
    });
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { evidenceId } };
}

async function listEventAssignments(database: Database, eventId: string) {
  return database
    .select({
      id: taskAssignments.id,
      eventId: taskAssignments.eventId,
      taskDefinitionId: taskDefinitions.id,
      name: taskDefinitions.name,
      scope: taskDefinitions.scope,
      completionMechanism: taskDefinitions.completionMechanism,
      profileRequirement: taskDefinitions.profileRequirement,
      formSchemaJson: taskDefinitions.formSchemaJson,
      targetUserId: taskAssignments.targetUserId,
      targetProgramItemId: taskAssignments.targetProgramItemId,
      targetSubmissionSpeakerId: taskAssignments.targetSubmissionSpeakerId,
      required: taskAssignments.required,
      dueAt: taskAssignments.dueAt,
      completionRevision: taskAssignments.completionRevision,
    })
    .from(taskAssignments)
    .innerJoin(
      taskDefinitions,
      eq(taskDefinitions.id, taskAssignments.taskDefinitionId),
    )
    .where(
      and(
        eq(taskAssignments.eventId, eventId),
        isNull(taskAssignments.canceledAt),
      ),
    )
    .orderBy(asc(taskAssignments.createdAt));
}

async function listAccessibleAssignments(database: Database, userId: UserId) {
  const activeRelationships = database
    .select({ id: submissionSpeakers.id })
    .from(submissionSpeakers)
    .where(
      and(
        eq(submissionSpeakers.claimedUserId, userId),
        isNull(submissionSpeakers.removedAt),
      ),
    );
  const accessibleProgramItems = database
    .select({ id: programItems.id })
    .from(programItems)
    .innerJoin(submissions, eq(submissions.id, programItems.submissionId))
    .innerJoin(
      submissionSpeakers,
      eq(submissionSpeakers.submissionId, submissions.id),
    )
    .where(
      and(
        eq(submissionSpeakers.claimedUserId, userId),
        isNull(submissionSpeakers.removedAt),
      ),
    );
  return database
    .select({
      id: taskAssignments.id,
      eventId: taskAssignments.eventId,
      taskDefinitionId: taskDefinitions.id,
      name: taskDefinitions.name,
      scope: taskDefinitions.scope,
      completionMechanism: taskDefinitions.completionMechanism,
      profileRequirement: taskDefinitions.profileRequirement,
      formSchemaJson: taskDefinitions.formSchemaJson,
      targetUserId: taskAssignments.targetUserId,
      targetProgramItemId: taskAssignments.targetProgramItemId,
      targetSubmissionSpeakerId: taskAssignments.targetSubmissionSpeakerId,
      required: taskAssignments.required,
      dueAt: taskAssignments.dueAt,
      completionRevision: taskAssignments.completionRevision,
    })
    .from(taskAssignments)
    .innerJoin(
      taskDefinitions,
      eq(taskDefinitions.id, taskAssignments.taskDefinitionId),
    )
    .where(
      and(
        isNull(taskAssignments.canceledAt),
        or(
          eq(taskAssignments.targetUserId, userId),
          inArray(
            taskAssignments.targetSubmissionSpeakerId,
            activeRelationships,
          ),
          inArray(taskAssignments.targetProgramItemId, accessibleProgramItems),
        ),
      ),
    )
    .orderBy(asc(taskAssignments.dueAt), asc(taskAssignments.createdAt));
}

async function findAccessibleAssignment(
  database: Database,
  userId: UserId,
  assignmentId: TaskAssignmentId,
) {
  const assignments = await listAccessibleAssignments(database, userId);
  return assignments.find((assignment) => assignment.id === assignmentId);
}

async function findAssignment(database: Database, assignmentId: string) {
  const [assignment] = await database
    .select({
      id: taskAssignments.id,
      eventId: taskAssignments.eventId,
      taskDefinitionId: taskDefinitions.id,
      name: taskDefinitions.name,
      scope: taskDefinitions.scope,
      completionMechanism: taskDefinitions.completionMechanism,
      profileRequirement: taskDefinitions.profileRequirement,
      formSchemaJson: taskDefinitions.formSchemaJson,
      targetUserId: taskAssignments.targetUserId,
      targetProgramItemId: taskAssignments.targetProgramItemId,
      targetSubmissionSpeakerId: taskAssignments.targetSubmissionSpeakerId,
      required: taskAssignments.required,
      dueAt: taskAssignments.dueAt,
      completionRevision: taskAssignments.completionRevision,
    })
    .from(taskAssignments)
    .innerJoin(
      taskDefinitions,
      eq(taskDefinitions.id, taskAssignments.taskDefinitionId),
    )
    .where(
      and(
        eq(taskAssignments.id, assignmentId),
        isNull(taskAssignments.canceledAt),
      ),
    )
    .limit(1);
  return assignment;
}

async function assignmentIsComplete(
  database: Database,
  assignment: NonNullable<AssignmentRow>,
): Promise<boolean> {
  const evidenceRows = await database
    .select({
      kind: taskEvidence.kind,
      profileRequirement: taskDefinitions.profileRequirement,
      profileDisplayName: speakerProfiles.displayName,
      profileBio: speakerProfiles.bio,
      profileHeadshotUrl: speakerProfiles.headshotUrl,
    })
    .from(taskEvidence)
    .innerJoin(
      taskAssignments,
      eq(taskAssignments.id, taskEvidence.assignmentId),
    )
    .innerJoin(
      taskDefinitions,
      eq(taskDefinitions.id, taskAssignments.taskDefinitionId),
    )
    .leftJoin(
      taskEvidenceRejections,
      eq(taskEvidenceRejections.evidenceId, taskEvidence.id),
    )
    .leftJoin(
      taskEvidenceSupersessions,
      eq(taskEvidenceSupersessions.previousEvidenceId, taskEvidence.id),
    )
    .leftJoin(
      speakerProfiles,
      eq(speakerProfiles.id, taskEvidence.speakerProfileId),
    )
    .where(
      and(
        eq(taskEvidence.assignmentId, assignment.id),
        eq(taskEvidence.completionRevision, assignment.completionRevision),
        isNull(taskEvidenceRejections.evidenceId),
        isNull(taskEvidenceSupersessions.previousEvidenceId),
      ),
    );
  return evidenceRows.some((evidence) => {
    if (evidence.kind !== "profile") return true;
    if (!evidence.profileRequirement || !evidence.profileDisplayName)
      return false;
    return profileSatisfiesRequirement(
      {
        displayName: evidence.profileDisplayName,
        bio: evidence.profileBio ?? "",
        headshotUrl: evidence.profileHeadshotUrl,
      },
      evidence.profileRequirement,
    );
  });
}

async function listAssignmentEvidence(
  database: Database,
  assignmentId: string,
) {
  const rows = await database
    .select({
      id: taskEvidence.id,
      revision: taskEvidence.completionRevision,
      kind: taskEvidence.kind,
      reason: taskEvidence.reason,
      createdAt: taskEvidence.createdAt,
      rejectedReason: taskEvidenceRejections.reason,
      supersededBy: taskEvidenceSupersessions.replacementEvidenceId,
      fileName: storedFiles.fileName,
    })
    .from(taskEvidence)
    .leftJoin(
      taskEvidenceRejections,
      eq(taskEvidenceRejections.evidenceId, taskEvidence.id),
    )
    .leftJoin(
      taskEvidenceSupersessions,
      eq(taskEvidenceSupersessions.previousEvidenceId, taskEvidence.id),
    )
    .leftJoin(
      taskAssignmentAttachments,
      eq(taskAssignmentAttachments.id, taskEvidence.attachmentId),
    )
    .leftJoin(
      storedFiles,
      eq(storedFiles.id, taskAssignmentAttachments.storedFileId),
    )
    .where(eq(taskEvidence.assignmentId, assignmentId))
    .orderBy(desc(taskEvidence.createdAt));
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

async function findCurrentFormDraft(
  database: Database,
  assignment: NonNullable<AssignmentRow>,
) {
  const [draft] = await database
    .select({
      id: onboardingFormResponses.id,
      answersJson: onboardingFormResponses.answersJson,
    })
    .from(onboardingFormResponses)
    .where(
      and(
        eq(onboardingFormResponses.assignmentId, assignment.id),
        eq(
          onboardingFormResponses.completionRevision,
          assignment.completionRevision,
        ),
        isNull(onboardingFormResponses.submittedAt),
      ),
    )
    .limit(1);
  return draft
    ? {
        id: draft.id,
        answers: JSON.parse(draft.answersJson) as Record<string, string>,
      }
    : null;
}

async function findCurrentFileEvidence(
  database: Database,
  assignment: NonNullable<AssignmentRow>,
) {
  const [current] = await database
    .select({ evidenceId: taskEvidence.id })
    .from(taskEvidence)
    .where(
      and(
        eq(taskEvidence.assignmentId, assignment.id),
        eq(taskEvidence.completionRevision, assignment.completionRevision),
        eq(taskEvidence.kind, "file"),
        notExists(
          database
            .select({ id: taskEvidenceSupersessions.previousEvidenceId })
            .from(taskEvidenceSupersessions)
            .where(
              eq(taskEvidenceSupersessions.previousEvidenceId, taskEvidence.id),
            ),
        ),
      ),
    )
    .limit(1);
  return current;
}

async function listEventTargets(database: Database, eventId: string) {
  const rows = await database
    .select({
      programItemId: programItems.id,
      title: submissions.title,
      submissionSpeakerId: submissionSpeakers.id,
      invitedName: submissionSpeakers.invitedName,
      claimedUserId: submissionSpeakers.claimedUserId,
      userName: user.name,
      userEmail: user.email,
    })
    .from(programItems)
    .innerJoin(submissions, eq(submissions.id, programItems.submissionId))
    .innerJoin(
      submissionSpeakers,
      eq(submissionSpeakers.submissionId, submissions.id),
    )
    .leftJoin(user, eq(user.id, submissionSpeakers.claimedUserId))
    .where(
      and(
        eq(programItems.eventId, eventId),
        isNull(submissionSpeakers.removedAt),
      ),
    )
    .orderBy(asc(submissions.title), asc(submissionSpeakers.position));
  const itemIds = [...new Set(rows.map((row) => row.programItemId))];
  return itemIds.map((id) => {
    const itemRows = rows.filter((row) => row.programItemId === id);
    return {
      id,
      title: itemRows[0]?.title ?? "Accepted program item",
      speakers: itemRows.map((row) => ({
        id: row.submissionSpeakerId,
        name: row.userName || row.invitedName,
        userId: row.claimedUserId,
        email: row.userEmail,
      })),
    };
  });
}

function readinessSpeakerRows(
  programItemRows: Awaited<ReturnType<typeof listEventTargets>>,
) {
  const byUser = new Map<
    string,
    {
      key: string;
      userId: string;
      name: string;
      email: string | null;
      relationshipIds: string[];
    }
  >();
  const unclaimed: Array<{
    key: string;
    userId: null;
    name: string;
    email: string | null;
    relationshipIds: string[];
  }> = [];
  for (const item of programItemRows) {
    for (const speaker of item.speakers) {
      if (!speaker.userId) {
        unclaimed.push({
          key: speaker.id,
          userId: null,
          name: speaker.name,
          email: speaker.email,
          relationshipIds: [speaker.id],
        });
        continue;
      }
      const current = byUser.get(speaker.userId);
      if (current) {
        current.relationshipIds.push(speaker.id);
      } else {
        byUser.set(speaker.userId, {
          key: speaker.userId,
          userId: speaker.userId,
          name: speaker.name,
          email: speaker.email,
          relationshipIds: [speaker.id],
        });
      }
    }
  }
  return [...byUser.values(), ...unclaimed];
}

async function targetBelongsToEvent(
  database: Database,
  eventId: string,
  target: CreateTaskAssignmentInput["target"],
): Promise<boolean> {
  if (target.scope === "event_speaker") {
    const [speaker] = await database
      .select({ id: submissionSpeakers.id })
      .from(submissionSpeakers)
      .innerJoin(
        submissions,
        eq(submissions.id, submissionSpeakers.submissionId),
      )
      .innerJoin(programItems, eq(programItems.submissionId, submissions.id))
      .where(
        and(
          eq(programItems.eventId, eventId),
          eq(submissionSpeakers.claimedUserId, target.userId),
          isNull(submissionSpeakers.removedAt),
        ),
      )
      .limit(1);
    return Boolean(speaker);
  }
  if (target.scope === "program_item") {
    const [item] = await database
      .select({ id: programItems.id })
      .from(programItems)
      .where(
        and(
          eq(programItems.id, target.programItemId),
          eq(programItems.eventId, eventId),
        ),
      )
      .limit(1);
    return Boolean(item);
  }
  const [speaker] = await database
    .select({ id: submissionSpeakers.id })
    .from(submissionSpeakers)
    .innerJoin(submissions, eq(submissions.id, submissionSpeakers.submissionId))
    .innerJoin(programItems, eq(programItems.submissionId, submissions.id))
    .where(
      and(
        eq(submissionSpeakers.id, target.submissionSpeakerId),
        eq(programItems.eventId, eventId),
        isNull(submissionSpeakers.removedAt),
      ),
    )
    .limit(1);
  return Boolean(speaker);
}

async function findOrganizerEventById(
  database: Database,
  actorUserId: UserId,
  eventId: string,
) {
  const [event] = await database
    .select({ slug: events.slug })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  const slug = event?.slug;
  return slug ? findEventForOrganizer(database, actorUserId, slug) : undefined;
}

async function findLastReminder(database: Database, assignmentId: string) {
  const [reminder] = await database
    .select({ createdAt: taskReminders.createdAt })
    .from(taskReminders)
    .where(eq(taskReminders.assignmentId, assignmentId))
    .orderBy(desc(taskReminders.createdAt))
    .limit(1);
  return reminder?.createdAt.toISOString() ?? null;
}

function presentAssignment(assignment: NonNullable<AssignmentRow>) {
  return {
    id: assignment.id,
    name: assignment.name,
    scope: assignment.scope,
    completionMechanism: assignment.completionMechanism,
    profileRequirement: assignment.profileRequirement,
    formFields: parseOnboardingFormFields(assignment.formSchemaJson),
    targetUserId: assignment.targetUserId,
    targetProgramItemId: assignment.targetProgramItemId,
    targetSubmissionSpeakerId: assignment.targetSubmissionSpeakerId,
    required: assignment.required,
    dueAt: assignment.dueAt,
    completionRevision: assignment.completionRevision,
  };
}

function blockerSummary(assignment: ReturnType<typeof presentAssignment>) {
  return {
    assignmentId: assignment.id,
    requirement: assignment.name,
    dueAt: assignment.dueAt,
  };
}

function earliestDueAt(
  assignments: Array<ReturnType<typeof presentAssignment>>,
) {
  return (
    assignments
      .flatMap((assignment) => (assignment.dueAt ? [assignment.dueAt] : []))
      .sort()[0] ?? null
  );
}

function formAnswersAreValid(
  formSchemaJson: string | null,
  answers: Record<string, string>,
): boolean {
  if (!formSchemaJson) return false;
  const fields = parseOnboardingFormFields(formSchemaJson);
  if (!fields) return false;
  return fields.every(
    (field) => !field.required || Boolean(answers[field.key]?.trim()),
  );
}

function parseOnboardingFormFields(formSchemaJson: string | null) {
  return formSchemaJson
    ? onboardingFormFieldSchema.array().parse(JSON.parse(formSchemaJson))
    : null;
}
