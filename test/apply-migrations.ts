import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

type MigrationEnvironment = {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const migrationEnvironment = env as unknown as MigrationEnvironment;
await applyD1Migrations(
  migrationEnvironment.DB,
  migrationEnvironment.TEST_MIGRATIONS,
);
