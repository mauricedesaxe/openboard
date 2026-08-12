import { describe, expect, test } from "vitest";

import {
  addDays,
  agendaLibraryDecision,
  clampVisibleStart,
  derivePublicVisibleHours,
  moveItemInAgenda,
  placeProgramInAgenda,
  placeServiceInAgenda,
  removeItemFromAgenda,
  replaceAgendaItemId,
  setCanceledInAgenda,
  toCalendarEvent,
  trackColor,
  unplaceProgramInAgenda,
  updateServiceInAgenda,
  type WorkingAgenda,
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

  test("updates the complete working projection optimistically", () => {
    const initial = workingAgenda();
    const placedProgram = placeProgramInAgenda(initial, {
      temporaryId: "temporary-program",
      programItemId: "program-1",
      roomId: "room-1",
      startsAtLocal: "2028-08-10T09:00",
      endsAtLocal: "2028-08-10T10:00",
    });
    expect(placedProgram.unplacedProgramItems).toEqual([]);
    expect(placedProgram.items[0]).toMatchObject({
      id: "temporary-program",
      roomName: "Main hall",
      format: "Talk",
    });

    const durable = replaceAgendaItemId(
      placedProgram,
      "temporary-program",
      "agenda-1",
    );
    const moved = moveItemInAgenda(durable, {
      agendaItemId: "agenda-1",
      roomId: null,
      startsAtLocal: "2028-08-10T10:00",
      endsAtLocal: "2028-08-10T11:00",
    });
    expect(moved.items[0]).toMatchObject({
      id: "agenda-1",
      roomName: null,
      startsAtLocal: "2028-08-10T10:00",
      revision: 2,
    });

    const canceled = setCanceledInAgenda(moved, "agenda-1", true);
    expect(canceled.items[0]?.canceled).toBe(true);
    const unplaced = unplaceProgramInAgenda(canceled, "agenda-1");
    expect(unplaced.items).toEqual([]);
    expect(unplaced.unplacedProgramItems).toEqual([
      {
        id: "program-1",
        title: "Compiler stories",
        format: "Talk",
        track: "Engineering",
      },
    ]);
  });

  test("updates and removes optimistic service blocks", () => {
    const placed = placeServiceInAgenda(workingAgenda(), {
      temporaryId: "temporary-service",
      title: "Lunch",
      scope: { type: "event" },
      startsAtLocal: "2028-08-10T12:00",
      endsAtLocal: "2028-08-10T13:00",
    });
    const updated = updateServiceInAgenda(placed, {
      agendaItemId: "temporary-service",
      title: "Lunch break",
      scope: { type: "room", roomId: "room-1" },
      startsAtLocal: "2028-08-10T12:15",
      endsAtLocal: "2028-08-10T13:15",
    });
    expect(updated.items[0]).toMatchObject({
      serviceTitle: "Lunch break",
      serviceScope: "room",
      roomName: "Main hall",
      revision: 2,
    });
    expect(removeItemFromAgenda(updated, "temporary-service").items).toEqual(
      [],
    );
  });

  test("derives padded public hours without clipping early or overnight items", () => {
    expect(
      derivePublicVisibleHours(
        [
          {
            startsAt: "2028-08-10T09:00:00+02:00",
            endsAt: "2028-08-10T17:00:00+02:00",
          },
        ],
        "Europe/Berlin",
      ),
    ).toEqual({
      slotMinTime: "08:00:00",
      slotMaxTime: "18:00:00",
      scrollTime: "08:00:00",
    });
    expect(
      derivePublicVisibleHours(
        [
          {
            startsAt: "2028-08-10T06:00:00+02:00",
            endsAt: "2028-08-10T07:00:00+02:00",
          },
        ],
        "Europe/Berlin",
      ).slotMinTime,
    ).toBe("05:00:00");
    expect(
      derivePublicVisibleHours(
        [
          {
            startsAt: "2028-08-10T23:00:00+02:00",
            endsAt: "2028-08-11T01:00:00+02:00",
          },
        ],
        "Europe/Berlin",
      ),
    ).toEqual({
      slotMinTime: "00:00:00",
      slotMaxTime: "24:00:00",
      scrollTime: "00:00:00",
    });
    expect(
      derivePublicVisibleHours(
        [
          {
            startsAt: "2028-08-10T22:00:00+02:00",
            endsAt: "2028-08-11T00:00:00+02:00",
          },
        ],
        "Europe/Berlin",
      ),
    ).toEqual({
      slotMinTime: "21:00:00",
      slotMaxTime: "24:00:00",
      scrollTime: "21:00:00",
    });
  });
});

function workingAgenda(): WorkingAgenda {
  return {
    revision: 4,
    timezone: "Europe/Berlin",
    startsOn: "2028-08-10",
    endsOn: "2028-08-12",
    rooms: [{ id: "room-1", name: "Main hall", position: 0, archived: false }],
    unplacedProgramItems: [
      {
        id: "program-1",
        title: "Compiler stories",
        format: "Talk",
        track: "Engineering",
      },
    ],
    items: [],
  };
}
