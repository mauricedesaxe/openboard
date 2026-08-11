import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations"),
  );
  const replacementGuardMigration = migrations.filter(
    ({ name }) => name === "0025_invitation_replacement_guard.sql",
  );
  const submissionRevisionMigration = migrations.filter(
    ({ name }) => name === "0026_submission_revision.sql",
  );
  const agendaBaseMigrations = migrations.filter(
    ({ name }) => name < "0028_finalize_agenda_publications.sql",
  );
  const agendaFinalizationMigration = migrations.filter(
    ({ name }) => name === "0028_finalize_agenda_publications.sql",
  );
  const agendaDeliveryBaseMigrations = migrations.filter(
    ({ name }) => name <= "0029_published_schedule_calendar_work.sql",
  );
  const agendaDeliveryRecipientMigration = migrations.filter(
    ({ name }) => name === "0030_agenda_delivery_recipients.sql",
  );
  const agendaDeliveryClaimMigration = migrations.filter(
    ({ name }) => name === "0031_agenda_delivery_claims.sql",
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            AGENDA_BASE_MIGRATIONS: agendaBaseMigrations,
            AGENDA_DELIVERY_BASE_MIGRATIONS: agendaDeliveryBaseMigrations,
            AGENDA_DELIVERY_RECIPIENT_MIGRATION:
              agendaDeliveryRecipientMigration,
            AGENDA_DELIVERY_CLAIM_MIGRATION: agendaDeliveryClaimMigration,
            AGENDA_FINALIZATION_MIGRATION: agendaFinalizationMigration,
            REPLACEMENT_GUARD_MIGRATION: replacementGuardMigration,
            SUBMISSION_REVISION_MIGRATION: submissionRevisionMigration,
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
