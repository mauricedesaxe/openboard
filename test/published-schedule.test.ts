import { describe, expect, test } from "vitest";

import { renderPublishedScheduleCalendar } from "../src/server/published-schedule/ical";
import type { PublishedSchedule } from "../src/shared/published-schedule";

const schedule: PublishedSchedule = {
  version: "1.0",
  revision: 7,
  publishedAt: "2028-08-10T07:30:00.000Z",
  event: {
    name: "OpenBoard Live, Europe",
    slug: "openboard-live",
    timezone: "Europe/Berlin",
    startsOn: "2028-08-10",
    endsOn: "2028-08-11",
  },
  tracks: [{ id: "track-1", name: "Engineering; Web", position: 0 }],
  rooms: [{ id: "room-1", name: "Main hall", position: 0 }],
  items: [
    {
      id: "agenda-1",
      kind: "session",
      title: "APIs, calendars & a deliberately long title with café speakers",
      abstract:
        "First line\nSecond line with a comma, slash \\ and semicolon;.",
      format: "Talk",
      trackId: "track-1",
      roomId: "room-1",
      startsAt: "2028-08-10T08:00:00.000Z",
      endsAt: "2028-08-10T09:00:00.000Z",
      calendar: { uid: "agenda-1@openboard", sequence: 3 },
      speakers: [
        {
          id: "speaker-1",
          displayName: "Zoë Example",
          bio: "Builds calendars.",
          headshotUrl: null,
          position: 0,
        },
      ],
    },
    {
      id: "agenda-2",
      kind: "service",
      title: "Lunch",
      roomId: null,
      startsAt: "2028-08-10T11:00:00.000Z",
      endsAt: "2028-08-10T12:00:00.000Z",
    },
  ],
};

describe("published schedule", () => {
  test("renders one RFC-compliant iCalendar revision", () => {
    const calendar = renderPublishedScheduleCalendar(schedule);
    const unfolded = calendar.replaceAll("\r\n ", "");

    expect(calendar).toContain("X-OPENBOARD-REVISION:7\r\n");
    expect(calendar).toContain("X-WR-TIMEZONE:Europe/Berlin\r\n");
    expect(calendar).toContain("UID:agenda-1@openboard\r\n");
    expect(calendar).toContain("SEQUENCE:3\r\n");
    expect(unfolded).toContain(
      "DESCRIPTION:First line\\nSecond line with a comma\\, slash \\\\ and semicolon\\;.\\nSpeakers: Zoë Example\r\n",
    );
    expect(calendar).toMatch(/\r\n [^\r\n]+\r\n/);
    expect(calendar).not.toMatch(/(^|[^\r])\n/);
    for (const line of calendar.split("\r\n")) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    }
    expect(calendar.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
