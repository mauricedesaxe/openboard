import { readFileSync, writeFileSync } from "node:fs";

const reviewNumber = process.env.PREVIEW_NUMBER;
const previewD1Id =
  process.env.PREVIEW_D1_ID ?? "369223a1-2ad4-4496-aa3d-7208580521ac";
const workersDevSubdomain =
  process.env.WORKERS_DEV_SUBDOMAIN ?? "sweet-mouse-22c9";

if (!reviewNumber) {
  console.error("PREVIEW_NUMBER is required.");
  process.exit(1);
}

const appUrl = `https://openboard-pr-${reviewNumber}.${workersDevSubdomain}.workers.dev`;

function parseJsonc(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

const base = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
delete base.$schema;

base.name = `openboard-pr-${reviewNumber}`;
base.d1_databases = [
  {
    ...base.d1_databases[0],
    database_name: "openboard-preview",
    database_id: previewD1Id,
  },
];
base.vars = {
  APP_ENV: "preview",
  APP_URL: appUrl,
  EMAIL_TRANSPORT: "cloudflare",
  EMAIL_FROM: "auth@alexlazar.dev",
};

writeFileSync("wrangler.preview.jsonc", `${JSON.stringify(base, null, 2)}\n`);
writeFileSync("preview-url.txt", `${appUrl}\n`);
