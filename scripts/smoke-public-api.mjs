import ICAL from "ical.js";

const [baseUrl, eventSlug] = process.argv.slice(2);

if (!baseUrl || !eventSlug) {
  console.error(
    "Usage: node scripts/smoke-public-api.mjs <base-url> <event-slug>",
  );
  process.exit(1);
}

const endpoints = [
  {
    name: "schedule JSON",
    path: `/api/v1/events/${encodeURIComponent(eventSlug)}/schedule`,
    parse: parseJson,
  },
  {
    name: "iCalendar feed",
    path: `/api/v1/events/${encodeURIComponent(eventSlug)}/schedule.ics`,
    parse: parseCalendar,
  },
  {
    name: "OpenAPI document",
    path: "/api/v1/openapi.json",
    parse: parseJson,
  },
];

for (const endpoint of endpoints) {
  await verifyResponse(endpoint, "gzip", "gzip");
  await verifyResponse(endpoint, "identity", null);
}

console.log("Public API smoke checks passed.");

async function verifyResponse(endpoint, acceptEncoding, expectedEncoding) {
  const response = await fetch(new URL(endpoint.path, baseUrl), {
    headers: { "Accept-Encoding": acceptEncoding },
  });
  if (!response.ok) {
    throw new Error(`${endpoint.name} returned HTTP ${response.status}`);
  }
  if (response.headers.get("content-encoding") !== expectedEncoding) {
    throw new Error(`${endpoint.name} returned the wrong content encoding`);
  }
  if (
    !response.headers.get("vary")?.toLowerCase().includes("accept-encoding")
  ) {
    throw new Error(`${endpoint.name} does not vary by Accept-Encoding`);
  }
  endpoint.parse(await response.text());
}

function parseJson(body) {
  JSON.parse(body);
}

function parseCalendar(body) {
  const calendar = new ICAL.Component(ICAL.parse(body));
  if (calendar.name !== "vcalendar") throw new Error("Expected VCALENDAR");
  if (calendar.getFirstPropertyValue("version") !== "2.0") {
    throw new Error("Expected iCalendar version 2.0");
  }
}
