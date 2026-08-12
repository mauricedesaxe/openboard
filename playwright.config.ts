import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.e2e.ts",
  workers: 1,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: {
    command:
      "pnpm exec wrangler d1 migrations apply openboard-e2e --local --persist-to .wrangler/e2e-final --config wrangler.e2e.jsonc && pnpm dev --mode e2e --host localhost",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
