import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  MIGRATION_DB: D1Database;
  TEMPLATED_COMMUNICATIONS_MIGRATION: Parameters<typeof applyD1Migrations>[1];
};

test("gives legacy decision communications stable event recipient keys", async () => {
  const database = migrationEnvironment.MIGRATION_DB;
  await database.batch([
    database.prepare("CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL)"),
    database.prepare(
      "CREATE TABLE submissions (id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL)",
    ),
    database.prepare(
      "CREATE TABLE submission_speaker_invitations (id TEXT PRIMARY KEY NOT NULL)",
    ),
    database.prepare(
      "CREATE TABLE communications (id TEXT PRIMARY KEY NOT NULL, submission_id TEXT, recipient_user_id TEXT, destination TEXT NOT NULL, purpose TEXT NOT NULL, created_at INTEGER NOT NULL)",
    ),
    database.prepare(
      "CREATE TABLE agenda_delivery_work (id TEXT PRIMARY KEY NOT NULL)",
    ),
    database.prepare("INSERT INTO events (id) VALUES ('event')"),
    database.prepare(
      "INSERT INTO submissions (id, event_id) VALUES ('submission', 'event')",
    ),
    database.prepare(
      "INSERT INTO communications (id, submission_id, recipient_user_id, destination, purpose, created_at) VALUES ('communication', 'submission', 'owner', 'owner@example.com', 'decision_acceptance', 1)",
    ),
  ]);

  await applyD1Migrations(
    database,
    migrationEnvironment.TEMPLATED_COMMUNICATIONS_MIGRATION,
  );

  expect(
    await database
      .prepare(
        "SELECT event_id AS eventId, recipient_key AS recipientKey FROM communications WHERE id = 'communication'",
      )
      .first(),
  ).toEqual({ eventId: "event", recipientKey: "user:owner" });
});
