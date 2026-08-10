import { sql } from "drizzle-orm";
import {
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

export const reviewerAssignments = sqliteTable(
  "reviewer_assignments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    reviewRoundId: text("review_round_id").notNull(),
    submissionId: text("submission_id").notNull(),
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

export const schema = {
  account,
  agendas,
  eventRoles,
  cfps,
  events,
  invitations,
  rateLimit,
  reviewerAssignments,
  rooms,
  session,
  tracks,
  user,
  verification,
};

export type DatabaseSchema = typeof schema;
