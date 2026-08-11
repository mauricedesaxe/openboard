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
  onboardingFormFieldSchema,
  profileSatisfiesRequirement,
  type CreateTaskAssignmentInput,
  type CreateTaskDefinitionInput,
  type TaskAssignmentId,
  type TaskDefinitionId,
  type TaskEvidenceId,
} from "../../shared/onboarding";
import {
  communicationInsertStatements,
  prepareCommunication,
  type CommunicationRecipient,
} from "../communications/repository";
import type { Database } from "../database/client";
import {
  onboardingFormResponses,
  events,
  programItems,
  speakerProfiles,
  storedFiles,
  submissions,
  submissionSpeakerInvitations,
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
import { compensateStoredFile, putStoredFile } from "../files/repository";
import { speakerHeadshotUrl } from "../speaker-profiles/repository";

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
        dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : null,
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
  const current = await findCurrentFileEvidence(database, assignment);
  const stored = await putStoredFile(
    files,
    actorUserId,
    `task-files/${assignment.eventId}/${assignment.id}`,
    input,
  );
  if (!stored.ok) {
    return {
      ok: false,
      error:
        stored.error === "invalid_file"
          ? "invalid_answers"
          : "persistence_failed",
    };
  }
  const fileId = stored.value.record.id;
  const attachmentId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID() as TaskEvidenceId;
  const now = new Date();
  try {
    const storedFileInsert = database
      .insert(storedFiles)
      .values(stored.value.record);
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
      replacementForEvidenceId: current?.evidenceId,
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
  } catch (error: unknown) {
    await compensateStoredFile(
      files,
      stored.value.record.objectKey,
      "task_file_compensation_failed",
    );
    return {
      ok: false,
      error: isCurrentEvidenceConflict(error)
        ? "current_evidence_exists"
        : "persistence_failed",
    };
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
  const now = new Date();
  const [event] = await database
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, assignment.eventId))
    .limit(1);
  if (!event) return { ok: false, error: "not_found" };
  const recipients = await taskReminderRecipients(database, assignment);
  if (recipients.length === 0) {
    return { ok: false, error: "invalid_assignment" };
  }
  let prepared: Array<Awaited<ReturnType<typeof prepareCommunication>>>;
  try {
    prepared = await Promise.all(
      recipients.map((recipient) =>
        prepareCommunication(database, {
          eventId: assignment.eventId,
          purpose: "task_reminder",
          recipient,
          variables: {
            eventName: event.name,
            taskName: assignment.name,
            recipientName: recipient.name,
            dueAt: assignment.dueAt ?? "No due date",
          },
          context: {
            assignmentId,
            completionRevision: assignment.completionRevision,
          },
          now,
        }),
      ),
    );
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  try {
    await database.batch([
      database.insert(taskReminders).values({
        id: reminderId,
        assignmentId,
        sentByUserId: actorUserId,
        createdAt: now,
      }),
      ...prepared.flatMap((communication) =>
        communicationInsertStatements(database, communication),
      ),
    ]);
  } catch {
    return { ok: false, error: "persistence_failed" };
  }
  return { ok: true, value: { reminderId } };
}

async function taskReminderRecipients(
  database: Database,
  assignment: NonNullable<AssignmentRow>,
): Promise<CommunicationRecipient[]> {
  if (assignment.targetUserId) {
    const [recipient] = await database
      .select({ id: user.id, email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, assignment.targetUserId))
      .limit(1);
    return recipient
      ? [
          {
            key: `user:${recipient.id}`,
            userId: recipient.id,
            invitationId: null,
            destination: recipient.email,
            name: recipient.name,
          },
        ]
      : [];
  }
  const speakerRows = await database
    .select({
      id: submissionSpeakers.id,
      invitationId: submissionSpeakerInvitations.id,
      claimedUserId: submissionSpeakers.claimedUserId,
      invitedEmail: submissionSpeakers.invitedEmail,
      invitedName: submissionSpeakers.invitedName,
      userEmail: user.email,
      userName: user.name,
    })
    .from(submissionSpeakers)
    .leftJoin(
      submissionSpeakerInvitations,
      and(
        eq(
          submissionSpeakerInvitations.submissionSpeakerId,
          submissionSpeakers.id,
        ),
        eq(submissionSpeakerInvitations.status, "pending"),
      ),
    )
    .leftJoin(user, eq(user.id, submissionSpeakers.claimedUserId))
    .leftJoin(
      programItems,
      eq(programItems.submissionId, submissionSpeakers.submissionId),
    )
    .where(
      and(
        isNull(submissionSpeakers.removedAt),
        assignment.targetSubmissionSpeakerId
          ? eq(submissionSpeakers.id, assignment.targetSubmissionSpeakerId)
          : eq(programItems.id, assignment.targetProgramItemId ?? ""),
      ),
    );
  const recipients = new Map<string, CommunicationRecipient>();
  for (const speaker of speakerRows) {
    const recipient =
      speaker.claimedUserId && speaker.userEmail
        ? {
            key: `user:${speaker.claimedUserId}`,
            userId: speaker.claimedUserId,
            invitationId: null,
            destination: speaker.userEmail,
            name: speaker.userName ?? speaker.invitedName,
          }
        : speaker.invitationId
          ? {
              key: `invitation:${speaker.invitationId}`,
              userId: null,
              invitationId: speaker.invitationId,
              destination: speaker.invitedEmail,
              name: speaker.invitedName,
            }
          : {
              key: `speaker:${speaker.id}`,
              userId: null,
              invitationId: null,
              destination: speaker.invitedEmail,
              name: speaker.invitedName,
            };
    recipients.set(recipient.key, recipient);
  }
  return [...recipients.values()];
}

export async function findAccessibleTaskFile(
  database: Database,
  actorUserId: UserId,
  fileId: string,
) {
  const [file] = await database
    .select({
      assignmentId: taskAssignments.id,
      eventId: taskAssignments.eventId,
      objectKey: storedFiles.objectKey,
      fileName: storedFiles.fileName,
      contentType: storedFiles.contentType,
    })
    .from(storedFiles)
    .innerJoin(
      taskAssignmentAttachments,
      eq(taskAssignmentAttachments.storedFileId, storedFiles.id),
    )
    .innerJoin(
      taskAssignments,
      eq(taskAssignments.id, taskAssignmentAttachments.assignmentId),
    )
    .where(eq(storedFiles.id, fileId))
    .limit(1);
  if (!file) return undefined;
  if (await findOrganizerEventById(database, actorUserId, file.eventId)) {
    return file;
  }
  const assignments = await listAccessibleAssignments(database, actorUserId);
  return assignments.some((assignment) => assignment.id === file.assignmentId)
    ? file
    : undefined;
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
  if (await assignmentIsComplete(database, assignment)) {
    return { ok: false, error: "current_evidence_exists" };
  }
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
  } catch (error: unknown) {
    return {
      ok: false,
      error: isCurrentEvidenceConflict(error)
        ? "current_evidence_exists"
        : "persistence_failed",
    };
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
      profileHeadshotStoredFileId: speakerProfiles.headshotStoredFileId,
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
        headshotUrl: speakerHeadshotUrl({
          headshotStoredFileId: evidence.profileHeadshotStoredFileId,
          headshotUrl: evidence.profileHeadshotUrl,
        }),
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
      fileId: storedFiles.id,
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
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
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

function isCurrentEvidenceConflict(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("current_completion_evidence_exists") ||
    message.includes("current_file_evidence_exists") ||
    message.includes("stale_file_replacement") ||
    message.includes("task_evidence_one_replacement_idx") ||
    message.includes("task_evidence.replacement_for_evidence_id") ||
    message.toLowerCase().includes("constraint")
  );
}
