import { describe, expect, test } from "vitest";

import {
  buildPreviewConfig,
  parseJsonc,
} from "../scripts/write-preview-config.mjs";

const jsoncWithCommentAndTrailingComma = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "openboard",
  "main": "src/worker.ts",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "openboard-local",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations",
    },
  ],
  "vars": { "APP_ENV": "local", },
}`;

const jsoncWithComment = `{
  "bogus": "value", // a comment that JSON.parse rejects
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "openboard",
}`;

describe("preview config generation", () => {
  test("parses JSONC with trailing commas", () => {
    expect(parseJsonc(jsoncWithCommentAndTrailingComma)).toMatchObject({
      name: "openboard",
    });
  });

  test("parses JSONC with comments", () => {
    expect(parseJsonc(jsoncWithComment)).toMatchObject({ name: "openboard" });
  });

  test("builds a preview config against the shared preview D1", () => {
    const { config, appUrl } = buildPreviewConfig({
      baseConfigText: jsoncWithCommentAndTrailingComma,
      reviewNumber: "42",
    });

    expect(appUrl).toBe("https://openboard-pr-42.sweet-mouse-22c9.workers.dev");
    expect(config).toMatchObject({
      name: "openboard-pr-42",
      vars: {
        APP_ENV: "preview",
        APP_URL: "https://openboard-pr-42.sweet-mouse-22c9.workers.dev",
        EMAIL_TRANSPORT: "cloudflare",
        EMAIL_FROM: "auth@alexlazar.dev",
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "openboard-preview",
          database_id: "369223a1-2ad4-4496-aa3d-7208580521ac",
        },
      ],
    });
  });

  test("builds a preview config against a per-PR D1", () => {
    const { config, appUrl } = buildPreviewConfig({
      baseConfigText: jsoncWithCommentAndTrailingComma,
      reviewNumber: "42",
      previewD1Id: "11111111-2222-4333-8444-555566667777",
    });

    expect(appUrl).toBe("https://openboard-pr-42.sweet-mouse-22c9.workers.dev");
    expect(config).toMatchObject({
      d1_databases: [
        {
          binding: "DB",
          database_name: "openboard-pr-42",
          database_id: "11111111-2222-4333-8444-555566667777",
        },
      ],
    });
  });
});
