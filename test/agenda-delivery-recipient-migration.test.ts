import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  MIGRATION_DB: D1Database;
  AGENDA_DELIVERY_BASE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  AGENDA_DELIVERY_RECIPIENT_MIGRATION: Parameters<typeof applyD1Migrations>[1];
  AGENDA_DELIVERY_CLAIM_MIGRATION: Parameters<typeof applyD1Migrations>[1];
};

test("preserves calendar work when recipient fan-out is added", async () => {
  const database = migrationEnvironment.MIGRATION_DB;
  await applyD1Migrations(
    database,
    migrationEnvironment.AGENDA_DELIVERY_BASE_MIGRATIONS,
  );
  const now = Date.now();
  await database.batch([
    database
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.com', 1, ?, ?)",
      )
      .bind(now, now),
    database
      .prepare(
        "INSERT INTO events (id, owner_user_id, name, slug, starts_on, ends_on, timezone, created_at, updated_at) VALUES ('event', 'owner', 'Event', 'event', '2028-08-10', '2028-08-10', 'Europe/Berlin', ?, ?)",
      )
      .bind(now, now),
    database
      .prepare(
        "INSERT INTO agendas (id, event_id, created_at, updated_at, revision) VALUES ('agenda', 'event', ?, ?, 0)",
      )
      .bind(now, now),
  ]);
  await database
    .prepare(
      "INSERT INTO agenda_items (id, agenda_id, event_id, kind, service_scope, service_title, starts_at_local, ends_at_local, created_at, updated_at) VALUES ('item', 'agenda', 'event', 'service', 'event', 'Break', '2028-08-10T12:00', '2028-08-10T13:00', ?, ?)",
    )
    .bind(now, now)
    .run();
  await database
    .prepare(
      "INSERT INTO agenda_publications (id, agenda_id, event_id, revision, working_revision, event_name, timezone, starts_on, ends_on, published_by_user_id, created_at) VALUES ('publication', 'agenda', 'event', 1, 1, 'Event', 'Europe/Berlin', '2028-08-10', '2028-08-10', 'owner', ?)",
    )
    .bind(now)
    .run();
  await database
    .prepare(
      "INSERT INTO agenda_delivery_work (id, publication_id, agenda_item_id, action, calendar_uid, calendar_sequence, created_at, status, attempt_count, last_error) VALUES ('work', 'publication', 'item', 'publish', 'item@openboard', 0, ?, 'failed', 1, 'temporary')",
    )
    .bind(now)
    .run();
  await database
    .prepare(
      "INSERT INTO agenda_delivery_attempts (id, work_id, attempt_number, started_at, finished_at, latency_ms, result, error) VALUES ('attempt', 'work', 1, ?, ?, 10, 'failed', 'temporary')",
    )
    .bind(now, now + 10)
    .run();

  await applyD1Migrations(
    database,
    migrationEnvironment.AGENDA_DELIVERY_RECIPIENT_MIGRATION,
  );
  await applyD1Migrations(
    database,
    migrationEnvironment.AGENDA_DELIVERY_CLAIM_MIGRATION,
  );

  expect(
    await database
      .prepare(
        "SELECT status, attempt_count AS attemptCount, recipient_key AS recipientKey FROM agenda_delivery_work WHERE id = 'work'",
      )
      .first(),
  ).toEqual({ status: "failed", attemptCount: 1, recipientKey: null });
  expect(
    await database
      .prepare(
        "SELECT result, latency_ms AS latencyMs FROM agenda_delivery_attempts WHERE id = 'attempt'",
      )
      .first(),
  ).toEqual({ result: "failed", latencyMs: 10 });
  await database.batch([
    database
      .prepare(
        "INSERT INTO agenda_delivery_work (id, publication_id, agenda_item_id, recipient_key, destination, recipient_name, action, calendar_uid, calendar_sequence, created_at) VALUES ('recipient-1', 'publication', 'item', 'user-1', 'one@example.com', 'One', 'publish', 'item@openboard', 0, ?)",
      )
      .bind(now),
    database
      .prepare(
        "INSERT INTO agenda_delivery_work (id, publication_id, agenda_item_id, recipient_key, destination, recipient_name, action, calendar_uid, calendar_sequence, created_at) VALUES ('recipient-2', 'publication', 'item', 'user-2', 'two@example.com', 'Two', 'publish', 'item@openboard', 0, ?)",
      )
      .bind(now),
  ]);
  await database
    .prepare(
      "INSERT INTO agenda_delivery_work (id, publication_id, agenda_item_id, recipient_key, destination, recipient_name, action, calendar_uid, calendar_sequence, created_at) VALUES ('recipient-cancel', 'publication', 'item', 'user-1', 'one@example.com', 'One', 'cancel', 'item@openboard', 0, ?)",
    )
    .bind(now)
    .run();
});
