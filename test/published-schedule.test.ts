import { describe, expect, test } from "vitest";

import {
  renderAgendaCalendarMessage,
  renderPublishedScheduleCalendar,
} from "../src/server/published-schedule/ical";
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
    expect(calendar).not.toContain("METHOD:PUBLISH");
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

  test("renders a safe calendar cancellation message", () => {
    const message = renderAgendaCalendarMessage({
      eventName: "OpenBoard Live",
      timezone: "Europe/Berlin",
      publishedAt: "2028-08-10T07:30:00.000Z",
      destination: "speaker@example.com",
      recipientName: 'A^"B\nC',
      organizerEmail: "calendar@example.com",
      action: "cancel",
      uid: "agenda-1@openboard",
      sequence: 4,
      item: {
        title: "APIs and calendars",
        abstract: "Calendar\rdetails\u0001",
        trackName: "Engineering",
        roomName: "Main hall",
        startsAt: "2028-08-10T08:00:00.000Z",
        endsAt: "2028-08-10T09:00:00.000Z",
        speakers: ["Example Speaker"],
      },
    });

    expect(message.method).toBe("CANCEL");
    expect(message.calendar).toContain("METHOD:CANCEL\r\n");
    expect(message.calendar).toContain(
      "ORGANIZER:mailto:calendar@example.com\r\n",
    );
    expect(message.calendar.replaceAll("\r\n ", "")).toContain(
      'ATTENDEE;CN="A^^^\'B^nC":mailto:speaker@example.com\r\n',
    );
    expect(message.calendar).toContain("STATUS:CANCELLED\r\n");
    expect(message.calendar).toContain("DESCRIPTION:Calendar\\ndetails");
    expect(message.calendar).not.toContain("\u0001");
  });

  test("renders an invitation for a newly published placement", () => {
    const message = renderAgendaCalendarMessage(
      messageInput({ action: "publish" }),
    );

    expect(message.method).toBe("REQUEST");
    expect(message.calendar).toContain("METHOD:REQUEST\r\n");
    expect(message.calendar).toContain("STATUS:CONFIRMED\r\n");
    expect(message.subject).toBe(
      "Invitation: APIs and calendars at OpenBoard Live",
    );
    expect(message.text).toContain("is attached.");
  });

  test("renders an update for an edited placement", () => {
    const message = renderAgendaCalendarMessage(
      messageInput({ action: "update" }),
    );

    expect(message.method).toBe("REQUEST");
    expect(message.calendar).toContain("STATUS:CONFIRMED\r\n");
    expect(message.subject).toBe(
      "Updated: APIs and calendars at OpenBoard Live",
    );
    expect(message.text).toContain("is attached.");
  });

  test("renders a restore as a request with an update subject", () => {
    const message = renderAgendaCalendarMessage(
      messageInput({ action: "restore" }),
    );

    expect(message.method).toBe("REQUEST");
    expect(message.calendar).toContain("STATUS:CONFIRMED\r\n");
    expect(message.subject).toBe(
      "Updated: APIs and calendars at OpenBoard Live",
    );
    expect(message.text).toContain("is attached.");
  });
});

function messageInput(
  overrides: Partial<Parameters<typeof renderAgendaCalendarMessage>[0]> = {},
) {
  return {
    eventName: "OpenBoard Live",
    timezone: "Europe/Berlin",
    publishedAt: "2028-08-10T07:30:00.000Z",
    destination: "speaker@example.com",
    recipientName: "Example Speaker",
    organizerEmail: "calendar@example.com",
    action: "publish" as const,
    uid: "agenda-1@openboard",
    sequence: 1,
    item: {
      title: "APIs and calendars",
      abstract: "Calendar details",
      trackName: "Engineering",
      roomName: "Main hall",
      startsAt: "2028-08-10T08:00:00.000Z",
      endsAt: "2028-08-10T09:00:00.000Z",
      speakers: ["Example Speaker"],
    },
    ...overrides,
  };
}
