import { describe, expect, test } from "vitest";

import {
  eventLocalDateTimeToIso,
  instantFallsAfterLocalDate,
  isoToEventLocalDateTime,
  unambiguousEventLocalDateTimeToIso,
} from "../src/shared/date-time";

describe("event deadline timezones", () => {
  test("preserves event wall time independently of the browser timezone", () => {
    const instant = eventLocalDateTimeToIso(
      "2027-04-30T17:00",
      "Europe/Berlin",
    );

    expect(instant).toBe("2027-04-30T15:00:00.000Z");
    expect(isoToEventLocalDateTime(instant ?? "", "America/New_York")).toBe(
      "2027-04-30T11:00",
    );
    expect(isoToEventLocalDateTime(instant ?? "", "Europe/Berlin")).toBe(
      "2027-04-30T17:00",
    );
  });

  test("rejects local times skipped by daylight saving changes", () => {
    expect(
      eventLocalDateTimeToIso("2027-03-28T02:30", "Europe/Berlin"),
    ).toBeUndefined();
  });

  test("rejects local times repeated by daylight saving changes", () => {
    expect(
      unambiguousEventLocalDateTimeToIso("2027-10-31T02:30", "Europe/Berlin"),
    ).toBeUndefined();
    expect(
      unambiguousEventLocalDateTimeToIso("2027-10-31T03:30", "Europe/Berlin"),
    ).toBe("2027-10-31T02:30:00.000Z");
  });

  test("compares an instant with the event end date", () => {
    expect(
      instantFallsAfterLocalDate(
        "2027-08-12T23:30:00Z",
        "2027-08-12",
        "Europe/Berlin",
      ),
    ).toBe(true);
    expect(
      instantFallsAfterLocalDate(
        "2027-08-12T21:30:00Z",
        "2027-08-12",
        "Europe/Berlin",
      ),
    ).toBe(false);
  });
});
