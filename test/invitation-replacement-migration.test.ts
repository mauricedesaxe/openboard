import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  MIGRATION_DB: D1Database;
  REPLACEMENT_GUARD_MIGRATION: Parameters<typeof applyD1Migrations>[1];
};

test("reconciles duplicate invitation replacements before adding the guard", async () => {
  await migrationEnvironment.MIGRATION_DB.prepare(
    "CREATE TABLE invitations (id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, replacement_for_invitation_id TEXT, created_at INTEGER NOT NULL)",
  ).run();
  await migrationEnvironment.MIGRATION_DB.batch([
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('source', 'event', 'revoked', NULL, 1)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('first', 'event', 'pending', 'source', 2)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('second', 'event', 'revoked', 'source', 3)",
    ),
  ]);

  await applyD1Migrations(
    migrationEnvironment.MIGRATION_DB,
    migrationEnvironment.REPLACEMENT_GUARD_MIGRATION,
  );

  const replacements = await migrationEnvironment.MIGRATION_DB.prepare(
    `SELECT id, replacement_for_invitation_id AS sourceId
     FROM invitations
     WHERE id IN ('first', 'second')
     ORDER BY created_at`,
  ).all<{ id: string; sourceId: string | null }>();
  expect(replacements.results).toEqual([
    { id: "first", sourceId: "source" },
    { id: "second", sourceId: null },
  ]);
  await expect(
    migrationEnvironment.MIGRATION_DB.prepare(
      "UPDATE invitations SET replacement_for_invitation_id = 'source' WHERE id = 'second'",
    ).run(),
  ).rejects.toThrow(/UNIQUE constraint failed/);
});
