import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const rateLimit = sqliteTable(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: integer("last_request").notNull(),
  },
  (table) => [uniqueIndex("rate_limit_key_idx").on(table.key)],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on").notNull(),
    timezone: text("timezone").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("events_owner_user_id_idx").on(table.ownerUserId)],
);

export const agendas = sqliteTable("agendas", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .unique()
    .references(() => events.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  revision: integer("revision").notNull().default(0),
});

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["organizer", "reviewer"] }).notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    status: text("status", {
      enum: ["pending", "accepted", "declined", "revoked"],
    }).notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id),
    replacementForInvitationId: text("replacement_for_invitation_id"),
    replacementToken: text("replacement_token"),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("invitations_event_id_idx").on(table.eventId),
    index("invitations_email_idx").on(table.email),
    uniqueIndex("invitations_pending_grant_idx")
      .on(table.eventId, table.email, table.role)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export const eventRoles = sqliteTable(
  "event_roles",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    role: text("role", { enum: ["organizer", "reviewer"] }).notNull(),
    invitationId: text("invitation_id").references(() => invitations.id),
    grantedByUserId: text("granted_by_user_id")
      .notNull()
      .references(() => user.id),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedByUserId: text("revoked_by_user_id").references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("event_roles_event_id_idx").on(table.eventId),
    index("event_roles_user_id_idx").on(table.userId),
    uniqueIndex("event_roles_active_grant_idx")
      .on(table.eventId, table.userId, table.role)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const reviewRounds = sqliteTable(
  "review_rounds",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    cfpId: text("cfp_id")
      .notNull()
      .unique()
      .references(() => cfps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", { enum: ["draft", "open", "closed"] }).notNull(),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("review_rounds_event_id_idx").on(table.eventId)],
);

export const reviewerAssignments = sqliteTable(
  "reviewer_assignments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    reviewRoundId: text("review_round_id")
      .notNull()
      .references(() => reviewRounds.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id")
      .notNull()
      .references(() => user.id),
    assignedByUserId: text("assigned_by_user_id")
      .notNull()
      .references(() => user.id),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedByUserId: text("revoked_by_user_id").references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("reviewer_assignments_event_reviewer_idx").on(
      table.eventId,
      table.reviewerUserId,
    ),
    uniqueIndex("reviewer_assignments_active_idx")
      .on(table.reviewRoundId, table.submissionId, table.reviewerUserId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id")
    .notNull()
    .unique()
    .references(() => reviewerAssignments.id, { onDelete: "cascade" }),
  score: integer("score").notNull(),
  comment: text("comment"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const tracks = sqliteTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("tracks_event_id_idx").on(table.eventId),
    uniqueIndex("tracks_active_name_idx")
      .on(table.eventId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} IS NULL`),
  ],
);

export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("rooms_event_id_idx").on(table.eventId),
    uniqueIndex("rooms_active_name_idx")
      .on(table.eventId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} IS NULL`),
  ],
);

export const cfps = sqliteTable(
  "cfps",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    deadline: text("deadline").notNull(),
    status: text("status", { enum: ["draft", "open"] }).notNull(),
    formatsJson: text("formats_json").notNull(),
    customFieldsJson: text("custom_fields_json").notNull(),
    structureLockedAt: integer("structure_locked_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("cfps_event_id_idx").on(table.eventId),
    uniqueIndex("cfps_one_open_per_event_idx")
      .on(table.eventId)
      .where(sql`${table.status} = 'open'`),
    uniqueIndex("cfps_one_draft_per_event_idx")
      .on(table.eventId)
      .where(sql`${table.status} = 'draft'`),
  ],
);

export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    cfpId: text("cfp_id")
      .notNull()
      .references(() => cfps.id, { onDelete: "cascade" }),
    cfpRevision: integer("cfp_revision", { mode: "timestamp_ms" }).notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id),
    clientDraftId: text("client_draft_id").notNull(),
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.id),
    title: text("title").notNull(),
    abstract: text("abstract").notNull(),
    format: text("format").notNull(),
    status: text("status", { enum: ["active", "withdrawn"] }).notNull(),
    revision: integer("revision").notNull().default(1),
    writeToken: text("write_token").notNull().default(""),
    withdrawnAt: integer("withdrawn_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("submissions_event_id_idx").on(table.eventId),
    index("submissions_owner_user_id_idx").on(table.ownerUserId),
    uniqueIndex("submissions_owner_draft_idx").on(
      table.cfpId,
      table.ownerUserId,
      table.clientDraftId,
    ),
  ],
);

export const submissionSpeakers = sqliteTable(
  "submission_speakers",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    invitedName: text("invited_name").notNull(),
    invitedEmail: text("invited_email").notNull(),
    claimedUserId: text("claimed_user_id").references(() => user.id),
    position: integer("position").notNull(),
    removedAt: integer("removed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("submission_speakers_submission_id_idx").on(table.submissionId),
    uniqueIndex("submission_speakers_active_email_idx")
      .on(table.submissionId, table.invitedEmail)
      .where(sql`${table.removedAt} IS NULL`),
    uniqueIndex("submission_speakers_active_claim_idx")
      .on(table.submissionId, table.claimedUserId)
      .where(
        sql`${table.claimedUserId} IS NOT NULL AND ${table.removedAt} IS NULL`,
      ),
  ],
);

export const submissionSpeakerInvitations = sqliteTable(
  "submission_speaker_invitations",
  {
    id: text("id").primaryKey(),
    submissionSpeakerId: text("submission_speaker_id")
      .notNull()
      .references(() => submissionSpeakers.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    status: text("status", {
      enum: ["pending", "accepted", "declined", "revoked"],
    }).notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id),
    replacementForInvitationId: text("replacement_for_invitation_id"),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("submission_speaker_invitations_speaker_id_idx").on(
      table.submissionSpeakerId,
    ),
    index("submission_speaker_invitations_email_idx").on(table.email),
    uniqueIndex("submission_speaker_invitations_pending_idx")
      .on(table.submissionSpeakerId)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      columns: [table.replacementForInvitationId],
      foreignColumns: [table.id],
    }),
  ],
);

export const formResponses = sqliteTable("form_responses", {
  id: text("id").primaryKey(),
  cfpId: text("cfp_id")
    .notNull()
    .references(() => cfps.id),
  submissionId: text("submission_id")
    .notNull()
    .unique()
    .references(() => submissions.id, { onDelete: "cascade" }),
  answersJson: text("answers_json").notNull(),
  writeToken: text("write_token").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const submissionFileUploads = sqliteTable(
  "submission_file_uploads",
  {
    id: text("id").primaryKey(),
    cfpId: text("cfp_id")
      .notNull()
      .references(() => cfps.id, { onDelete: "cascade" }),
    clientDraftId: text("client_draft_id").notNull(),
    fieldKey: text("field_key").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id),
    storedFileId: text("stored_file_id")
      .notNull()
      .unique()
      .references(() => storedFiles.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("submission_file_uploads_draft_idx").on(
      table.cfpId,
      table.ownerUserId,
      table.clientDraftId,
    ),
  ],
);

export const formResponseAttachments = sqliteTable(
  "form_response_attachments",
  {
    id: text("id").primaryKey(),
    formResponseId: text("form_response_id")
      .notNull()
      .references(() => formResponses.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    storedFileId: text("stored_file_id")
      .notNull()
      .unique()
      .references(() => storedFiles.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("form_response_attachments_response_idx").on(table.formResponseId),
    uniqueIndex("form_response_attachments_field_idx").on(
      table.formResponseId,
      table.fieldKey,
    ),
  ],
);

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  submissionId: text("submission_id")
    .notNull()
    .unique()
    .references(() => submissions.id, { onDelete: "cascade" }),
  status: text("status", {
    enum: [
      "pending",
      "accept_queued",
      "decline_queued",
      "accepted",
      "declined",
    ],
  }).notNull(),
  revision: integer("revision").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const programItems = sqliteTable(
  "program_items",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .unique()
      .references(() => submissions.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("program_items_event_id_idx").on(table.eventId)],
);

export const decisionPublications = sqliteTable("decision_publications", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  reviewRoundId: text("review_round_id")
    .notNull()
    .references(() => reviewRounds.id),
  publishedByUserId: text("published_by_user_id")
    .notNull()
    .references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const decisionPublicationItems = sqliteTable(
  "decision_publication_items",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => decisionPublications.id, { onDelete: "cascade" }),
    decisionId: text("decision_id")
      .notNull()
      .unique()
      .references(() => decisions.id),
    outcome: text("outcome", { enum: ["accepted", "declined"] }).notNull(),
    expectedRevision: integer("expected_revision").notNull(),
  },
);

export const reviewAuditEvents = sqliteTable(
  "review_audit_events",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id),
    publicationItemId: text("publication_item_id")
      .notNull()
      .unique()
      .references(() => decisionPublicationItems.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("review_audit_events_event_id_idx").on(table.eventId)],
);

export const communications = sqliteTable(
  "communications",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id").references(() => submissions.id, {
      onDelete: "cascade",
    }),
    recipientUserId: text("recipient_user_id").references(() => user.id),
    eventId: text("event_id").references(() => events.id),
    recipientKey: text("recipient_key"),
    recipientInvitationId: text("recipient_invitation_id"),
    destination: text("destination").notNull(),
    purpose: text("purpose").notNull(),
    subject: text("subject"),
    body: text("body"),
    contextJson: text("context_json"),
    templateRevision: integer("template_revision"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("communications_submission_id_idx").on(table.submissionId)],
);

export const communicationTemplates = sqliteTable(
  "communication_templates",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    purpose: text("purpose", {
      enum: [
        "submission_confirmation",
        "decision_acceptance",
        "decision_decline",
        "task_reminder",
        "agenda_invitation",
        "agenda_update",
        "agenda_cancellation",
      ],
    }).notNull(),
    subjectTemplate: text("subject_template").notNull(),
    bodyTemplate: text("body_template").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("communication_templates_event_purpose_idx").on(
      table.eventId,
      table.purpose,
    ),
  ],
);

export const communicationDeliveryWork = sqliteTable(
  "communication_delivery_work",
  {
    id: text("id").primaryKey(),
    communicationId: text("communication_id")
      .notNull()
      .unique()
      .references(() => communications.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["pending", "failed", "completed", "terminal"],
    })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    claimToken: text("claim_token"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const communicationDeliveryAttempts = sqliteTable(
  "communication_delivery_attempts",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => communicationDeliveryWork.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    result: text("result", {
      enum: ["delivered", "retryable_failure", "terminal_failure"],
    }).notNull(),
    providerId: text("provider_id"),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("communication_delivery_attempts_work_number_idx").on(
      table.workId,
      table.attemptNumber,
    ),
  ],
);

export const taskDefinitions = sqliteTable(
  "task_definitions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scope: text("scope", {
      enum: ["event_speaker", "program_item", "program_item_speaker"],
    }).notNull(),
    completionMechanism: text("completion_mechanism", {
      enum: ["manual", "profile", "form", "file"],
    }).notNull(),
    profileRequirement: text("profile_requirement", {
      enum: ["complete", "bio", "headshot"],
    }),
    formSchemaJson: text("form_schema_json"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("task_definitions_event_id_idx").on(table.eventId)],
);

export const taskAssignments = sqliteTable(
  "task_assignments",
  {
    id: text("id").primaryKey(),
    taskDefinitionId: text("task_definition_id")
      .notNull()
      .references(() => taskDefinitions.id),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id").references(() => user.id),
    targetProgramItemId: text("target_program_item_id").references(
      () => programItems.id,
    ),
    targetSubmissionSpeakerId: text("target_submission_speaker_id").references(
      () => submissionSpeakers.id,
    ),
    required: integer("required", { mode: "boolean" }).notNull(),
    dueAt: text("due_at"),
    completionRevision: integer("completion_revision").notNull().default(1),
    assignedByUserId: text("assigned_by_user_id")
      .notNull()
      .references(() => user.id),
    canceledAt: integer("canceled_at", { mode: "timestamp_ms" }),
    canceledByUserId: text("canceled_by_user_id").references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("task_assignments_event_id_idx").on(table.eventId),
    index("task_assignments_target_user_idx").on(
      table.eventId,
      table.targetUserId,
    ),
    index("task_assignments_target_program_item_idx").on(
      table.targetProgramItemId,
    ),
    index("task_assignments_target_speaker_idx").on(
      table.targetSubmissionSpeakerId,
    ),
  ],
);

export const taskAssignmentRevisions = sqliteTable(
  "task_assignment_revisions",
  {
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => taskAssignments.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    openedByUserId: text("opened_by_user_id")
      .notNull()
      .references(() => user.id),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("task_assignment_revisions_pk").on(
      table.assignmentId,
      table.revision,
    ),
  ],
);

export const onboardingFormResponses = sqliteTable(
  "onboarding_form_responses",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => taskAssignments.id, { onDelete: "cascade" }),
    completionRevision: integer("completion_revision").notNull(),
    answersJson: text("answers_json").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("onboarding_form_responses_one_draft_idx")
      .on(table.assignmentId, table.completionRevision)
      .where(sql`${table.submittedAt} IS NULL`),
  ],
);

export const storedFiles = sqliteTable("stored_files", {
  id: text("id").primaryKey(),
  objectKey: text("object_key").notNull().unique(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedByUserId: text("uploaded_by_user_id")
    .notNull()
    .references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const speakerProfiles = sqliteTable("speaker_profiles", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  bio: text("bio").notNull(),
  headshotUrl: text("headshot_url"),
  headshotStoredFileId: text("headshot_stored_file_id").references(
    () => storedFiles.id,
  ),
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const taskAssignmentAttachments = sqliteTable(
  "task_assignment_attachments",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => taskAssignments.id, { onDelete: "cascade" }),
    completionRevision: integer("completion_revision").notNull(),
    storedFileId: text("stored_file_id")
      .notNull()
      .unique()
      .references(() => storedFiles.id),
    attachedByUserId: text("attached_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("task_assignment_attachments_assignment_idx").on(
      table.assignmentId,
      table.completionRevision,
    ),
  ],
);

export const taskEvidence = sqliteTable(
  "task_evidence",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => taskAssignments.id, { onDelete: "cascade" }),
    completionRevision: integer("completion_revision").notNull(),
    kind: text("kind", {
      enum: [
        "manual",
        "profile",
        "form",
        "file",
        "waiver",
        "organizer_override",
      ],
    }).notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id),
    speakerProfileId: text("speaker_profile_id").references(
      () => speakerProfiles.id,
    ),
    formResponseId: text("form_response_id").references(
      () => onboardingFormResponses.id,
    ),
    attachmentId: text("attachment_id").references(
      () => taskAssignmentAttachments.id,
    ),
    replacementForEvidenceId: text("replacement_for_evidence_id"),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("task_evidence_assignment_idx").on(
      table.assignmentId,
      table.completionRevision,
    ),
    uniqueIndex("task_evidence_one_replacement_idx")
      .on(table.replacementForEvidenceId)
      .where(sql`${table.replacementForEvidenceId} IS NOT NULL`),
    foreignKey({
      columns: [table.replacementForEvidenceId],
      foreignColumns: [table.id],
    }),
  ],
);

export const taskEvidenceRejections = sqliteTable("task_evidence_rejections", {
  evidenceId: text("evidence_id")
    .primaryKey()
    .references(() => taskEvidence.id, { onDelete: "cascade" }),
  rejectedByUserId: text("rejected_by_user_id")
    .notNull()
    .references(() => user.id),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const taskEvidenceSupersessions = sqliteTable(
  "task_evidence_supersessions",
  {
    previousEvidenceId: text("previous_evidence_id")
      .primaryKey()
      .references(() => taskEvidence.id, { onDelete: "cascade" }),
    replacementEvidenceId: text("replacement_evidence_id")
      .notNull()
      .unique()
      .references(() => taskEvidence.id, { onDelete: "cascade" }),
    supersededByUserId: text("superseded_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const taskReminders = sqliteTable(
  "task_reminders",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => taskAssignments.id, { onDelete: "cascade" }),
    sentByUserId: text("sent_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("task_reminders_assignment_idx").on(
      table.assignmentId,
      table.createdAt,
    ),
  ],
);

export const agendaItems = sqliteTable(
  "agenda_items",
  {
    id: text("id").primaryKey(),
    agendaId: text("agenda_id")
      .notNull()
      .references(() => agendas.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["program", "service"] }).notNull(),
    programItemId: text("program_item_id")
      .unique()
      .references(() => programItems.id),
    serviceScope: text("service_scope", { enum: ["event", "room"] }),
    serviceTitle: text("service_title"),
    roomId: text("room_id").references(() => rooms.id),
    startsAtLocal: text("starts_at_local").notNull(),
    endsAtLocal: text("ends_at_local").notNull(),
    canceledAt: integer("canceled_at", { mode: "timestamp_ms" }),
    placed: integer("placed", { mode: "boolean" }).notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("agenda_items_agenda_id_idx").on(table.agendaId)],
);

export const agendaPublications = sqliteTable(
  "agenda_publications",
  {
    id: text("id").primaryKey(),
    agendaId: text("agenda_id")
      .notNull()
      .references(() => agendas.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    workingRevision: integer("working_revision").notNull(),
    eventName: text("event_name").notNull(),
    timezone: text("timezone").notNull(),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on").notNull(),
    publishedByUserId: text("published_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    finalized: integer("finalized", { mode: "boolean" })
      .notNull()
      .default(false),
    requiresFinalization: integer("requires_finalization", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("agenda_publications_agenda_revision_idx").on(
      table.agendaId,
      table.revision,
    ),
  ],
);

export const publishedAgendaItems = sqliteTable(
  "published_agenda_items",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => agendaPublications.id, { onDelete: "cascade" }),
    agendaItemId: text("agenda_item_id").notNull(),
    kind: text("kind", { enum: ["program", "service"] }).notNull(),
    programItemId: text("program_item_id"),
    title: text("title").notNull(),
    abstract: text("abstract"),
    format: text("format"),
    trackId: text("track_id"),
    trackName: text("track_name"),
    trackPosition: integer("track_position"),
    roomId: text("room_id"),
    roomName: text("room_name"),
    roomPosition: integer("room_position"),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    canceled: integer("canceled", { mode: "boolean" }).notNull().default(false),
    calendarUid: text("calendar_uid"),
    calendarSequence: integer("calendar_sequence"),
  },
  (table) => [
    uniqueIndex("published_agenda_items_publication_item_idx").on(
      table.publicationId,
      table.agendaItemId,
    ),
  ],
);

export const publishedAgendaSpeakers = sqliteTable(
  "published_agenda_speakers",
  {
    id: text("id").primaryKey(),
    publishedAgendaItemId: text("published_agenda_item_id")
      .notNull()
      .references(() => publishedAgendaItems.id, { onDelete: "cascade" }),
    submissionSpeakerId: text("submission_speaker_id").notNull(),
    sourceClaimedUserId: text("source_claimed_user_id"),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    headshotUrl: text("headshot_url"),
    position: integer("position").notNull(),
  },
  (table) => [
    uniqueIndex("published_agenda_speakers_item_speaker_idx").on(
      table.publishedAgendaItemId,
      table.submissionSpeakerId,
    ),
  ],
);

export const calendarSyncStates = sqliteTable("calendar_sync_states", {
  agendaItemId: text("agenda_item_id")
    .primaryKey()
    .references(() => agendaItems.id, { onDelete: "cascade" }),
  uid: text("uid").notNull().unique(),
  sequence: integer("sequence").notNull(),
  canceled: integer("canceled", { mode: "boolean" }).notNull(),
  fingerprint: text("fingerprint").notNull(),
  publicationId: text("publication_id")
    .notNull()
    .references(() => agendaPublications.id),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const agendaDeliveryWork = sqliteTable(
  "agenda_delivery_work",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => agendaPublications.id, { onDelete: "cascade" }),
    agendaItemId: text("agenda_item_id")
      .notNull()
      .references(() => agendaItems.id),
    recipientKey: text("recipient_key"),
    recipientUserId: text("recipient_user_id").references(() => user.id),
    destination: text("destination"),
    recipientName: text("recipient_name"),
    action: text("action", {
      enum: ["publish", "update", "cancel", "restore"],
    }).notNull(),
    calendarUid: text("calendar_uid").notNull(),
    calendarSequence: integer("calendar_sequence").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status", {
      enum: ["pending", "failed", "completed", "superseded"],
    })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    claimToken: text("claim_token"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    supersededAt: integer("superseded_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    subject: text("subject"),
    body: text("body"),
    retryEligible: integer("retry_eligible", { mode: "boolean" })
      .notNull()
      .default(true),
  },
  (table) => [
    uniqueIndex("agenda_delivery_work_publication_item_recipient_idx").on(
      table.publicationId,
      table.agendaItemId,
      table.recipientKey,
      table.destination,
      table.action,
    ),
  ],
);

export const agendaDeliveryAttempts = sqliteTable(
  "agenda_delivery_attempts",
  {
    id: text("id").primaryKey(),
    workId: text("work_id")
      .notNull()
      .references(() => agendaDeliveryWork.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    result: text("result", {
      enum: ["delivered", "failed", "superseded"],
    }).notNull(),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("agenda_delivery_attempts_work_number_idx").on(
      table.workId,
      table.attemptNumber,
    ),
  ],
);

export const schema = {
  account,
  agendas,
  agendaDeliveryWork,
  agendaDeliveryAttempts,
  agendaItems,
  agendaPublications,
  communications,
  communicationDeliveryAttempts,
  communicationDeliveryWork,
  communicationTemplates,
  calendarSyncStates,
  decisionPublicationItems,
  decisionPublications,
  decisions,
  eventRoles,
  cfps,
  events,
  formResponseAttachments,
  formResponses,
  invitations,
  onboardingFormResponses,
  programItems,
  publishedAgendaItems,
  publishedAgendaSpeakers,
  rateLimit,
  reviewAuditEvents,
  reviewerAssignments,
  reviewRounds,
  reviews,
  rooms,
  session,
  speakerProfiles,
  storedFiles,
  submissionFileUploads,
  submissions,
  submissionSpeakerInvitations,
  submissionSpeakers,
  tracks,
  taskAssignmentAttachments,
  taskAssignmentRevisions,
  taskAssignments,
  taskDefinitions,
  taskEvidence,
  taskEvidenceRejections,
  taskEvidenceSupersessions,
  taskReminders,
  user,
  verification,
};

export type DatabaseSchema = typeof schema;
