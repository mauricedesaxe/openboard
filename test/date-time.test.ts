import { describe, expect, test } from "vitest";

import {
  eventLocalDateTimeToIso,
  isoToEventLocalDateTime,
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
});
