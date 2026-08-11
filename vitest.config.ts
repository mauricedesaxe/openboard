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

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
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
