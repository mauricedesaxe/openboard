import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import stripJsonComments from "strip-json-comments";

const defaultPreviewD1Id = "369223a1-2ad4-4496-aa3d-7208580521ac";
const defaultWorkersDevSubdomain = "sweet-mouse-22c9";

export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1"));
}

export function buildPreviewConfig({
  baseConfigText,
  reviewNumber,
  previewD1Id,
  previewD1Name,
  workersDevSubdomain = defaultWorkersDevSubdomain,
}) {
  const appUrl = `https://openboard-pr-${reviewNumber}.${workersDevSubdomain}.workers.dev`;
  const base = parseJsonc(baseConfigText);
  delete base.$schema;

  const databaseName =
    previewD1Id == null
      ? "openboard-preview"
      : (previewD1Name ?? `openboard-pr-${reviewNumber}`);

  base.name = `openboard-pr-${reviewNumber}`;
  base.d1_databases = [
    {
      ...base.d1_databases[0],
      database_name: databaseName,
      database_id: previewD1Id ?? defaultPreviewD1Id,
    },
  ];
  base.vars = {
    APP_ENV: "preview",
    APP_URL: appUrl,
    EMAIL_TRANSPORT: "cloudflare",
    EMAIL_FROM: "auth@alexlazar.dev",
  };

  return { config: base, appUrl };
}

function main() {
  const reviewNumber = process.env.PREVIEW_NUMBER;
  if (!reviewNumber) {
    console.error("PREVIEW_NUMBER is required.");
    process.exit(1);
  }

  const { config, appUrl } = buildPreviewConfig({
    baseConfigText: readFileSync("wrangler.jsonc", "utf8"),
    reviewNumber,
    previewD1Id: process.env.PREVIEW_D1_ID,
    previewD1Name: process.env.PREVIEW_D1_NAME,
    workersDevSubdomain: process.env.WORKERS_DEV_SUBDOMAIN,
  });

  writeFileSync(
    "wrangler.preview.jsonc",
    `${JSON.stringify(config, null, 2)}\n`,
  );
  writeFileSync("preview-url.txt", `${appUrl}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
