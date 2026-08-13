import type { Database } from "../database/client";

import { renderPublishedScheduleCalendar } from "./ical";
import { publishedScheduleOpenApiDocument } from "./openapi";
import { findPublishedSchedule } from "./repository";

const cacheControl = "public, max-age=60, stale-while-revalidate=300";

export async function routePublishedSchedule(
  request: Request,
  database: Database,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/openapi.json") {
    return request.method === "GET"
      ? publicResponse(
          request,
          JSON.stringify(publishedScheduleOpenApiDocument(url.origin)),
          "application/json; charset=utf-8",
        )
      : methodNotAllowed();
  }

  const match = url.pathname.match(
    /^\/api\/v1\/events\/([^/]+)\/schedule(\.ics)?$/,
  );
  if (!match) return undefined;
  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method !== "GET") return methodNotAllowed();

  let slug: string;
  try {
    slug = decodeURIComponent(match[1] ?? "");
  } catch {
    return scheduleNotFound();
  }
  const schedule = await findPublishedSchedule(database, slug, url.origin);
  if (!schedule) return scheduleNotFound();
  const calendar = Boolean(match[2]);
  return publicResponse(
    request,
    calendar
      ? renderPublishedScheduleCalendar(schedule)
      : JSON.stringify(schedule),
    calendar
      ? "text/calendar; charset=utf-8"
      : "application/json; charset=utf-8",
    calendar ? `${slug}.ics` : undefined,
  );
}

function scheduleNotFound(): Response {
  return Response.json(
    { code: "SCHEDULE_NOT_FOUND", message: "Published schedule not found." },
    { status: 404, headers: publicHeaders() },
  );
}

async function publicResponse(
  request: Request,
  body: string,
  contentType: string,
  fileName?: string,
): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const gzip = acceptsGzip(request.headers.get("accept-encoding"));
  const etag = `"${fingerprint}-${gzip ? "gzip" : "identity"}"`;
  const headers = publicHeaders({ "Content-Type": contentType, ETag: etag });
  if (gzip) headers.set("Content-Encoding", "gzip");
  if (fileName) {
    headers.set("Content-Disposition", `inline; filename="${fileName}"`);
  }
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (gzip) {
    return new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
      { headers, encodeBody: "manual" },
    );
  }
  return new Response(bytes, { headers });
}

function acceptsGzip(header: string | null): boolean {
  return (header ?? "").split(",").some((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(";");
    if (encoding !== "gzip") return false;
    return !parameters.some((parameter) =>
      /^q=0(?:\.0*)?$/.test(parameter.trim()),
    );
  });
}

function publicHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", cacheControl);
  headers.set("Vary", "Accept-Encoding");
  return headers;
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: publicHeaders({
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "If-None-Match",
      "Access-Control-Max-Age": "86400",
    }),
  });
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed", {
    status: 405,
    headers: publicHeaders({ Allow: "GET, OPTIONS" }),
  });
}
