const timezoneCorrectionAttempts = 3;
const maximumTimezoneOverlapMinutes = 180;
const millisecondsPerMinute = 60_000;

export type EventLocalDateTimeResolution =
  | { status: "resolved"; iso: string }
  | { status: "invalid" }
  | { status: "ambiguous" };

/** Resolves event wall time through repeated offset checks so DST changes settle without using the browser timezone. */
export function eventLocalDateTimeToIso(
  value: string,
  timezone: string,
): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;

  const desired = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let instant = desired;
  for (let attempt = 0; attempt < timezoneCorrectionAttempts; attempt += 1) {
    instant += desired - datePartsAsUtc(new Date(instant), timezone);
  }

  return isoToEventLocalDateTime(new Date(instant).toISOString(), timezone) ===
    value
    ? new Date(instant).toISOString()
    : undefined;
}

export function resolveEventLocalDateTime(
  value: string,
  timezone: string,
): EventLocalDateTimeResolution {
  const resolved = eventLocalDateTimeToIso(value, timezone);
  if (!resolved) return { status: "invalid" };
  const resolvedTime = new Date(resolved).getTime();
  const matchingInstants = new Set<number>();
  for (
    let offsetMinutes = -maximumTimezoneOverlapMinutes;
    offsetMinutes <= maximumTimezoneOverlapMinutes;
    offsetMinutes += 1
  ) {
    const candidate = resolvedTime + offsetMinutes * millisecondsPerMinute;
    if (
      isoToEventLocalDateTime(new Date(candidate).toISOString(), timezone) ===
      value
    ) {
      matchingInstants.add(candidate);
    }
  }
  return matchingInstants.size === 1
    ? { status: "resolved", iso: resolved }
    : { status: "ambiguous" };
}

export function isoToEventLocalDateTime(
  value: string,
  timezone: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = dateTimeParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function instantFallsAfterLocalDate(
  instant: string,
  localDate: string,
  timezone: string,
): boolean {
  return isoToEventLocalDateTime(instant, timezone).slice(0, 10) > localDate;
}

export function instantFallsBeforeLocalDate(
  instant: string,
  localDate: string,
  timezone: string,
): boolean {
  return isoToEventLocalDateTime(instant, timezone).slice(0, 10) < localDate;
}

export function defaultCfpDeadline(startsOn: string, timezone: string): string {
  return (
    eventLocalDateTimeToIso(`${startsOn}T00:00`, timezone) ??
    `${startsOn}T00:00:00.000Z`
  );
}

export function formatEventDateRange(startsOn: string, endsOn: string): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const start = formatter.format(new Date(`${startsOn}T00:00:00Z`));
  const end = formatter.format(new Date(`${endsOn}T00:00:00Z`));
  return start === end ? start : `${start} – ${end}`;
}

function datePartsAsUtc(date: Date, timezone: string): number {
  const parts = dateTimeParts(date, timezone);
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
}

function dateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    month: value("month"),
    year: value("year"),
  };
}
