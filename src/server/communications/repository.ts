import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import type {
  CommunicationPurpose,
  updateCommunicationTemplateSchema,
} from "../../shared/communications";
import type { UserId } from "../../shared/events";
import type { Database } from "../database/client";
import {
  agendaDeliveryWork,
  agendaPublications,
  communicationDeliveryWork,
  communications,
  communicationTemplates,
} from "../database/schema";
import { findEventForOrganizer } from "../events/repository";

const defaultTemplates = {
  submission_confirmation: {
    subject: "Proposal received: {{submissionTitle}}",
    body: "We received {{submissionTitle}} for {{eventName}}.",
  },
  decision_acceptance: {
    subject: "Accepted: {{submissionTitle}}",
    body: "{{submissionTitle}} was accepted for {{eventName}}.",
  },
  decision_decline: {
    subject: "Decision: {{submissionTitle}}",
    body: "{{submissionTitle}} was not selected for {{eventName}}.",
  },
  task_reminder: {
    subject: "Reminder: {{taskName}}",
    body: "{{recipientName}}, {{taskName}} for {{eventName}} is still incomplete.",
  },
  agenda_invitation: {
    subject: "Invitation: {{sessionTitle}} at {{eventName}}",
    body: "{{recipientName}}, your calendar invitation for {{sessionTitle}} is attached.",
  },
  agenda_update: {
    subject: "Updated: {{sessionTitle}} at {{eventName}}",
    body: "{{recipientName}}, your calendar entry for {{sessionTitle}} was updated.",
  },
  agenda_cancellation: {
    subject: "Canceled: {{sessionTitle}} at {{eventName}}",
    body: "{{recipientName}}, your calendar entry for {{sessionTitle}} was canceled.",
  },
} satisfies Record<CommunicationPurpose, { subject: string; body: string }>;

const allowedVariables: Record<CommunicationPurpose, readonly string[]> = {
  submission_confirmation: ["eventName", "submissionTitle", "recipientName"],
  decision_acceptance: ["eventName", "submissionTitle", "recipientName"],
  decision_decline: ["eventName", "submissionTitle", "recipientName"],
  task_reminder: ["eventName", "taskName", "recipientName", "dueAt"],
  agenda_invitation: ["eventName", "sessionTitle", "recipientName"],
  agenda_update: ["eventName", "sessionTitle", "recipientName"],
  agenda_cancellation: ["eventName", "sessionTitle", "recipientName"],
};

export function defaultCommunicationTemplateValues(eventId: string, now: Date) {
  return Object.entries(defaultTemplates).map(([purpose, template]) => ({
    id: `${eventId}:${purpose}`,
    eventId,
    purpose: purpose as CommunicationPurpose,
    subjectTemplate: template.subject,
    bodyTemplate: template.body,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }));
}

export async function listCommunicationTemplates(
  database: Database,
  actorUserId: UserId,
  slug: string,
) {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return undefined;
  return database
    .select({
      purpose: communicationTemplates.purpose,
      subject: communicationTemplates.subjectTemplate,
      body: communicationTemplates.bodyTemplate,
      revision: communicationTemplates.revision,
    })
    .from(communicationTemplates)
    .where(eq(communicationTemplates.eventId, event.id))
    .orderBy(asc(communicationTemplates.purpose));
}

export async function updateCommunicationTemplate(
  database: Database,
  actorUserId: UserId,
  input: z.infer<typeof updateCommunicationTemplateSchema>,
) {
  const event = await findEventForOrganizer(database, actorUserId, input.slug);
  if (!event) return { ok: false as const, error: "not_found" as const };
  if (
    !templateIsValid(input.purpose, input.subject) ||
    !templateIsValid(input.purpose, input.body)
  ) {
    return { ok: false as const, error: "invalid_template" as const };
  }
  const result = await database
    .update(communicationTemplates)
    .set({
      subjectTemplate: input.subject,
      bodyTemplate: input.body,
      revision: sql`${communicationTemplates.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(communicationTemplates.eventId, event.id),
        eq(communicationTemplates.purpose, input.purpose),
        eq(communicationTemplates.revision, input.expectedRevision),
      ),
    );
  return result.meta.changes === 1
    ? { ok: true as const, value: { revision: input.expectedRevision + 1 } }
    : { ok: false as const, error: "template_changed" as const };
}

export type CommunicationRecipient = {
  key: string;
  userId: string | null;
  invitationId: string | null;
  destination: string;
  name: string;
};

export async function prepareCommunication(
  database: Database,
  input: {
    eventId: string;
    submissionId?: string;
    purpose: CommunicationPurpose;
    recipient: CommunicationRecipient;
    variables: Record<string, string>;
    context: Record<string, unknown>;
    now: Date;
  },
) {
  const [template] = await database
    .select()
    .from(communicationTemplates)
    .where(
      and(
        eq(communicationTemplates.eventId, input.eventId),
        eq(communicationTemplates.purpose, input.purpose),
      ),
    )
    .limit(1);
  if (!template) throw new Error("Communication template is missing");
  const communicationId = crypto.randomUUID();
  return {
    communication: {
      id: communicationId,
      eventId: input.eventId,
      submissionId: input.submissionId,
      recipientUserId: input.recipient.userId,
      recipientKey: input.recipient.key,
      recipientInvitationId: input.recipient.invitationId,
      destination: input.recipient.destination.trim().toLowerCase(),
      purpose: input.purpose,
      subject: renderTemplate(template.subjectTemplate, input.variables),
      body: renderTemplate(template.bodyTemplate, input.variables),
      contextJson: JSON.stringify(input.context),
      templateRevision: template.revision,
      createdAt: input.now,
    },
    work: {
      id: crypto.randomUUID(),
      communicationId,
      createdAt: input.now,
    },
  };
}

export async function listCommunicationFailures(
  database: Database,
  actorUserId: UserId,
  slug: string,
) {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return undefined;
  const generic = await database
    .select({
      communicationId: communications.id,
      purpose: communications.purpose,
      subject: communications.subject,
      status: communicationDeliveryWork.status,
      attemptCount: communicationDeliveryWork.attemptCount,
      error: communicationDeliveryWork.lastError,
      retryableAt: communicationDeliveryWork.nextAttemptAt,
    })
    .from(communicationDeliveryWork)
    .innerJoin(
      communications,
      eq(communications.id, communicationDeliveryWork.communicationId),
    )
    .where(
      and(
        eq(communications.eventId, event.id),
        inArray(communicationDeliveryWork.status, ["failed", "terminal"]),
      ),
    )
    .orderBy(asc(communicationDeliveryWork.createdAt));
  const agenda = await database
    .select({
      workId: agendaDeliveryWork.id,
      action: agendaDeliveryWork.action,
      subject: agendaDeliveryWork.subject,
      attemptCount: agendaDeliveryWork.attemptCount,
      error: agendaDeliveryWork.lastError,
      retryableAt: agendaDeliveryWork.nextAttemptAt,
      retryEligible: agendaDeliveryWork.retryEligible,
    })
    .from(agendaDeliveryWork)
    .innerJoin(
      agendaPublications,
      eq(agendaPublications.id, agendaDeliveryWork.publicationId),
    )
    .where(
      and(
        eq(agendaPublications.eventId, event.id),
        eq(agendaDeliveryWork.status, "failed"),
      ),
    );
  return [
    ...generic,
    ...agenda.map((failure) => ({
      communicationId: `agenda:${failure.workId}`,
      purpose:
        failure.action === "publish"
          ? "agenda_invitation"
          : failure.action === "cancel"
            ? "agenda_cancellation"
            : "agenda_update",
      subject: failure.subject,
      status: failure.retryEligible
        ? ("failed" as const)
        : ("terminal" as const),
      attemptCount: failure.attemptCount,
      error: failure.error,
      retryableAt: failure.retryableAt,
    })),
  ];
}

export async function retryCommunication(
  database: Database,
  actorUserId: UserId,
  slug: string,
  communicationId: string,
) {
  const event = await findEventForOrganizer(database, actorUserId, slug);
  if (!event) return false;
  if (communicationId.startsWith("agenda:")) {
    const result = await database
      .update(agendaDeliveryWork)
      .set({ status: "pending", nextAttemptAt: null, lastError: null })
      .where(
        and(
          eq(agendaDeliveryWork.id, communicationId.slice("agenda:".length)),
          eq(agendaDeliveryWork.status, "failed"),
          eq(agendaDeliveryWork.retryEligible, true),
          sql`EXISTS (SELECT 1 FROM agenda_publications WHERE agenda_publications.id = ${agendaDeliveryWork.publicationId} AND agenda_publications.event_id = ${event.id})`,
        ),
      );
    if (result.meta.changes === 1) return true;
    const [pending] = await database
      .select({ id: agendaDeliveryWork.id })
      .from(agendaDeliveryWork)
      .innerJoin(
        agendaPublications,
        eq(agendaPublications.id, agendaDeliveryWork.publicationId),
      )
      .where(
        and(
          eq(agendaDeliveryWork.id, communicationId.slice("agenda:".length)),
          eq(agendaDeliveryWork.status, "pending"),
          eq(agendaPublications.eventId, event.id),
        ),
      )
      .limit(1);
    return Boolean(pending);
  }
  const result = await database
    .update(communicationDeliveryWork)
    .set({ status: "pending", nextAttemptAt: null, lastError: null })
    .where(
      and(
        eq(communicationDeliveryWork.communicationId, communicationId),
        eq(communicationDeliveryWork.status, "failed"),
        sql`EXISTS (SELECT 1 FROM communications WHERE communications.id = ${communicationDeliveryWork.communicationId} AND communications.event_id = ${event.id})`,
      ),
    );
  if (result.meta.changes === 1) return true;
  const [pending] = await database
    .select({ id: communicationDeliveryWork.id })
    .from(communicationDeliveryWork)
    .innerJoin(
      communications,
      eq(communications.id, communicationDeliveryWork.communicationId),
    )
    .where(
      and(
        eq(communicationDeliveryWork.communicationId, communicationId),
        eq(communicationDeliveryWork.status, "pending"),
        eq(communications.eventId, event.id),
      ),
    )
    .limit(1);
  return Boolean(pending);
}

export function communicationInsertStatements(
  database: Database,
  prepared: Awaited<ReturnType<typeof prepareCommunication>>,
) {
  return [
    database.insert(communications).values(prepared.communication),
    database.insert(communicationDeliveryWork).values(prepared.work),
  ] as const;
}

export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(
    /{{([A-Za-z][A-Za-z0-9]*)}}/g,
    (_match, key: string) => {
      if (!(key in variables))
        throw new Error(`Missing template variable: ${key}`);
      return variables[key] ?? "";
    },
  );
}

function templateIsValid(purpose: CommunicationPurpose, template: string) {
  const placeholders = [...template.matchAll(/{{([^{}]+)}}/g)].map(
    (match) => match[1] ?? "",
  );
  const withoutPlaceholders = template.replace(/{{[^{}]+}}/g, "");
  return (
    !withoutPlaceholders.includes("{{") &&
    !withoutPlaceholders.includes("}}") &&
    placeholders.every((placeholder) =>
      allowedVariables[purpose].includes(placeholder),
    )
  );
}
