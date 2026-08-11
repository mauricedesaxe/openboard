import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  MIGRATION_DB: D1Database;
  REPLACEMENT_GUARD_MIGRATION: Parameters<typeof applyD1Migrations>[1];
};

test("reconciles duplicate invitation replacements before adding the guard", async () => {
  await migrationEnvironment.MIGRATION_DB.prepare(
    "CREATE TABLE invitations (id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, replacement_for_invitation_id TEXT, resolved_at INTEGER, created_at INTEGER NOT NULL)",
  ).run();
  await migrationEnvironment.MIGRATION_DB.batch([
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('source', 'event', 'revoked', NULL, 1, 1)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('first', 'event', 'pending', 'source', NULL, 2)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('second', 'event', 'pending', 'source', NULL, 3)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('accepted-source', 'event', 'revoked', NULL, 4, 4)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('accepted-source-pending', 'event', 'pending', 'accepted-source', NULL, 5)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO invitations VALUES ('accepted-source-winner', 'event', 'accepted', 'accepted-source', 6, 6)",
    ),
  ]);

  await applyD1Migrations(
    migrationEnvironment.MIGRATION_DB,
    migrationEnvironment.REPLACEMENT_GUARD_MIGRATION,
  );

  const replacements = await migrationEnvironment.MIGRATION_DB.prepare(
    `SELECT id, status, replacement_for_invitation_id AS sourceId,
            resolved_at AS resolvedAt
     FROM invitations
     WHERE id IN ('first', 'second')
     ORDER BY created_at`,
  ).all<{
    id: string;
    status: string;
    sourceId: string | null;
    resolvedAt: number | null;
  }>();
  expect(replacements.results).toEqual([
    { id: "first", status: "pending", sourceId: "source", resolvedAt: null },
    { id: "second", status: "revoked", sourceId: null, resolvedAt: 3 },
  ]);
  const acceptedReplacement = await migrationEnvironment.MIGRATION_DB.prepare(
    `SELECT id, status FROM invitations
     WHERE replacement_for_invitation_id = 'accepted-source'`,
  ).first<{ id: string; status: string }>();
  expect(acceptedReplacement).toEqual({
    id: "accepted-source-winner",
    status: "accepted",
  });
  const supersededPending = await migrationEnvironment.MIGRATION_DB.prepare(
    "SELECT status, replacement_for_invitation_id AS sourceId FROM invitations WHERE id = 'accepted-source-pending'",
  ).first<{ status: string; sourceId: string | null }>();
  expect(supersededPending).toEqual({ status: "revoked", sourceId: null });
  await expect(
    migrationEnvironment.MIGRATION_DB.prepare(
      "UPDATE invitations SET replacement_for_invitation_id = 'source' WHERE id = 'second'",
    ).run(),
  ).rejects.toThrow(/UNIQUE constraint failed/);
});
