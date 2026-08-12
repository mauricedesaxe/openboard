import { describe, expect, test } from "vitest";

import {
  addDays,
  agendaLibraryDecision,
  clampVisibleStart,
  toCalendarEvent,
  trackColor,
} from "../src/client/agenda-calendar-model";

describe("shared agenda calendar", () => {
  test("preserves calendar correctness fields in the library adapter", () => {
    const event = toCalendarEvent({
      id: "overnight",
      kind: "program",
      title: "Night systems",
      roomId: null,
      roomName: null,
      startsAt: "2028-08-10T23:30",
      endsAt: "2028-08-11T01:00",
      trackName: "Engineering",
      speakers: [{ displayName: "Ada" }],
      canceled: true,
      conflicts: ["speaker"],
    });

    expect(event).toMatchObject({
      id: "overnight",
      start: "2028-08-10T23:30",
      end: "2028-08-11T01:00",
      extendedProps: {
        roomId: null,
        roomName: null,
        canceled: true,
        conflicts: ["speaker"],
      },
    });
    expect(event.classNames).toEqual([
      "agenda-event-program",
      "agenda-event-conflict",
      "agenda-event-canceled",
    ]);
  });

  test("bounds the URL-controlled range to event dates", () => {
    expect(clampVisibleStart(null, "2028-08-10", "2028-08-20")).toBe(
      "2028-08-10",
    );
    expect(clampVisibleStart("2028-08-15", "2028-08-10", "2028-08-20")).toBe(
      "2028-08-15",
    );
    expect(clampVisibleStart("2028-08-30", "2028-08-10", "2028-08-20")).toBe(
      "2028-08-20",
    );
    expect(addDays("2028-08-10", 7)).toBe("2028-08-17");
  });

  test("assigns stable automatic track colors", () => {
    expect(trackColor("Engineering")).toBe(trackColor("Engineering"));
    expect(trackColor("Engineering")).not.toBe(trackColor("Design"));
    expect(trackColor(null)).toMatch(/^#/);
  });

  test("records the selected library cost and keyboard limitation", () => {
    expect(agendaLibraryDecision).toEqual({
      library: "FullCalendar Standard 6.1.21",
      license: "MIT",
      cost: "$0",
      keyboardEditing:
        "Inspector controls provide the precise keyboard path because keyboard drag and slot selection are not supported.",
    });
  });
});
