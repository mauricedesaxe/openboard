import { z } from "zod";

import { publishedScheduleSchema } from "../../shared/published-schedule";

export function publishedScheduleOpenApiDocument(origin: string) {
  const scheduleResponse = {
    description: "The latest immutable published schedule revision.",
    headers: {
      ETag: { schema: { type: "string" } },
      "Cache-Control": { schema: { type: "string" } },
    },
  };
  return {
    openapi: "3.1.0",
    info: { title: "OpenBoard Published Schedule API", version: "1.0.0" },
    servers: [{ url: origin }],
    paths: {
      "/api/v1/events/{eventSlug}/schedule": {
        get: {
          operationId: "getPublishedSchedule",
          parameters: [eventSlugParameter],
          responses: {
            "200": {
              ...scheduleResponse,
              content: {
                "application/json": {
                  schema: z.toJSONSchema(publishedScheduleSchema),
                },
              },
            },
            "304": { description: "The cached revision is current." },
            "404": { description: "No published event was found." },
          },
        },
      },
      "/api/v1/events/{eventSlug}/schedule.ics": {
        get: {
          operationId: "getPublishedScheduleCalendar",
          parameters: [eventSlugParameter],
          responses: {
            "200": {
              ...scheduleResponse,
              content: {
                "text/calendar": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "304": { description: "The cached revision is current." },
            "404": { description: "No published event was found." },
          },
        },
      },
    },
  };
}

const eventSlugParameter = {
  name: "eventSlug",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;
