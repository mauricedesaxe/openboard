import { defineConfig } from "@playwright/test";

const baseURL = process.env.PREVIEW_URL;
if (!baseURL) throw new Error("PREVIEW_URL is required.");

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/published-outputs.preview.e2e.ts",
  workers: 1,
  use: { baseURL, trace: "retain-on-failure" },
});
