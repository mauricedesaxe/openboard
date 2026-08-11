import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  MIGRATION_DB: D1Database;
  AGENDA_BASE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  AGENDA_FINALIZATION_MIGRATION: Parameters<typeof applyD1Migrations>[1];
};

test("finalizes existing agenda revisions during upgrade", async () => {
  await applyD1Migrations(
    migrationEnvironment.MIGRATION_DB,
    migrationEnvironment.AGENDA_BASE_MIGRATIONS,
  );
  const createdAt = Date.now();
  await migrationEnvironment.MIGRATION_DB.batch([
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.com', 1, ?, ?)",
    ).bind(createdAt, createdAt),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO events (id, owner_user_id, name, slug, starts_on, ends_on, timezone, created_at, updated_at) VALUES ('event', 'owner', 'Event', 'event', '2028-08-10', '2028-08-10', 'Europe/Berlin', ?, ?)",
    ).bind(createdAt, createdAt),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO agendas (id, event_id, created_at, updated_at, revision) VALUES ('agenda', 'event', ?, ?, 0)",
    ).bind(createdAt, createdAt),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO agenda_publications (id, agenda_id, event_id, revision, working_revision, event_name, timezone, starts_on, ends_on, published_by_user_id, created_at) VALUES ('publication', 'agenda', 'event', 1, 0, 'Event', 'Europe/Berlin', '2028-08-10', '2028-08-10', 'owner', ?)",
    ).bind(createdAt),
  ]);

  await applyD1Migrations(
    migrationEnvironment.MIGRATION_DB,
    migrationEnvironment.AGENDA_FINALIZATION_MIGRATION,
  );

  const publication = await migrationEnvironment.MIGRATION_DB.prepare(
    "SELECT finalized_at AS finalizedAt FROM agenda_publications WHERE id = 'publication'",
  ).first<{ finalizedAt: number }>();
  expect(publication).toEqual({ finalizedAt: createdAt });
  await expect(
    migrationEnvironment.MIGRATION_DB.prepare(
      "UPDATE agenda_publications SET finalized_at = finalized_at + 1 WHERE id = 'publication'",
    ).run(),
  ).rejects.toThrow("immutable_agenda_publication");
});
