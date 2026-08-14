import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  MIGRATION_DB: D1Database;
  EVENT_OWNER_ROLES_MIGRATION: Parameters<typeof applyD1Migrations>[1];
};

test("backfills active organizer and reviewer roles for event owners", async () => {
  const database = migrationEnvironment.MIGRATION_DB;
  await database.batch([
    database.prepare("CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL)"),
    database.prepare(
      "CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL REFERENCES user(id))",
    ),
    database.prepare(
      "CREATE TABLE event_roles (id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL REFERENCES user(id), role TEXT NOT NULL, invitation_id TEXT, granted_by_user_id TEXT NOT NULL REFERENCES user(id), revoked_at INTEGER, revoked_by_user_id TEXT, created_at INTEGER NOT NULL)",
    ),
    database.prepare(
      "CREATE UNIQUE INDEX event_roles_active_grant_idx ON event_roles(event_id, user_id, role) WHERE revoked_at IS NULL",
    ),
    database.prepare("INSERT INTO user (id) VALUES ('owner')"),
    database.prepare(
      "INSERT INTO events (id, owner_user_id) VALUES ('event', 'owner')",
    ),
    database.prepare(
      "INSERT INTO event_roles (id, event_id, user_id, role, granted_by_user_id, created_at) VALUES ('existing', 'event', 'owner', 'organizer', 'owner', 0)",
    ),
  ]);

  await applyD1Migrations(
    database,
    migrationEnvironment.EVENT_OWNER_ROLES_MIGRATION,
  );

  const roles = await database
    .prepare(
      "SELECT role, granted_by_user_id AS grantedByUserId FROM event_roles WHERE event_id = 'event' AND user_id = 'owner' AND revoked_at IS NULL ORDER BY role",
    )
    .all<{ role: string; grantedByUserId: string }>();
  expect(roles.results).toEqual([
    { role: "organizer", grantedByUserId: "owner" },
    { role: "reviewer", grantedByUserId: "owner" },
  ]);
});
