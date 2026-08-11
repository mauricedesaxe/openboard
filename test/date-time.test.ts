import { describe, expect, test } from "vitest";

import {
  defaultCfpDeadline,
  eventLocalDateTimeToIso,
  instantFallsAfterLocalDate,
  instantFallsBeforeLocalDate,
  isoToEventLocalDateTime,
  resolveEventLocalDateTime,
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
      resolveEventLocalDateTime("2027-10-31T02:30", "Europe/Berlin"),
    ).toEqual({ status: "ambiguous" });
    expect(
      resolveEventLocalDateTime("2027-10-31T03:30", "Europe/Berlin"),
    ).toEqual({ status: "resolved", iso: "2027-10-31T02:30:00.000Z" });
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

  test("compares an instant with the event start date", () => {
    expect(
      instantFallsBeforeLocalDate(
        "2027-08-08T22:00:00Z",
        "2027-08-10",
        "Europe/Berlin",
      ),
    ).toBe(true);
    expect(
      instantFallsBeforeLocalDate(
        "2027-08-09T22:00:00Z",
        "2027-08-10",
        "Europe/Berlin",
      ),
    ).toBe(false);
  });

  test("defaults a new CFP deadline to the event start in the event timezone", () => {
    expect(defaultCfpDeadline("2027-08-10", "Europe/Berlin")).toBe(
      "2027-08-09T22:00:00.000Z",
    );
    expect(defaultCfpDeadline("2027-01-10", "Europe/Berlin")).toBe(
      "2027-01-09T23:00:00.000Z",
    );
  });
});
