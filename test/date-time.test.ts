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
    const instant = eventLocalDateTimeToIso({
      localDateTime: "2027-04-30T17:00",
      timezone: "Europe/Berlin",
    });

    expect(instant).toBe("2027-04-30T15:00:00.000Z");
    expect(
      isoToEventLocalDateTime({
        instant: instant ?? "",
        timezone: "America/New_York",
      }),
    ).toBe("2027-04-30T11:00");
    expect(
      isoToEventLocalDateTime({
        instant: instant ?? "",
        timezone: "Europe/Berlin",
      }),
    ).toBe("2027-04-30T17:00");
  });

  test("rejects local times skipped by daylight saving changes", () => {
    expect(
      eventLocalDateTimeToIso({
        localDateTime: "2027-03-28T02:30",
        timezone: "Europe/Berlin",
      }),
    ).toBeUndefined();
  });

  test("rejects local times repeated by daylight saving changes", () => {
    expect(
      resolveEventLocalDateTime({
        localDateTime: "2027-10-31T02:30",
        timezone: "Europe/Berlin",
      }),
    ).toEqual({ status: "ambiguous" });
    expect(
      resolveEventLocalDateTime({
        localDateTime: "2027-10-31T03:30",
        timezone: "Europe/Berlin",
      }),
    ).toEqual({ status: "resolved", iso: "2027-10-31T02:30:00.000Z" });
  });

  test("compares an instant with the event end date", () => {
    expect(
      instantFallsAfterLocalDate({
        instant: "2027-08-12T23:30:00Z",
        localDate: "2027-08-12",
        timezone: "Europe/Berlin",
      }),
    ).toBe(true);
    expect(
      instantFallsAfterLocalDate({
        instant: "2027-08-12T21:30:00Z",
        localDate: "2027-08-12",
        timezone: "Europe/Berlin",
      }),
    ).toBe(false);
  });

  test("compares an instant with the event start date", () => {
    expect(
      instantFallsBeforeLocalDate({
        instant: "2027-08-08T22:00:00Z",
        localDate: "2027-08-10",
        timezone: "Europe/Berlin",
      }),
    ).toBe(true);
    expect(
      instantFallsBeforeLocalDate({
        instant: "2027-08-09T22:00:00Z",
        localDate: "2027-08-10",
        timezone: "Europe/Berlin",
      }),
    ).toBe(false);
  });

  test("defaults a new CFP deadline to the event start in the event timezone", () => {
    expect(
      defaultCfpDeadline({ startsOn: "2027-08-10", timezone: "Europe/Berlin" }),
    ).toBe("2027-08-10T15:00:00.000Z");
    expect(
      defaultCfpDeadline({ startsOn: "2027-01-10", timezone: "Europe/Berlin" }),
    ).toBe("2027-01-10T16:00:00.000Z");
  });

  test("keeps a same-day CFP deadline in the future", () => {
    expect(
      defaultCfpDeadline({
        startsOn: "2027-08-10",
        timezone: "Europe/Berlin",
        now: new Date("2027-08-10T18:00:00Z"),
      }),
    ).toBe("2027-08-10T21:59:00.000Z");
  });
});
