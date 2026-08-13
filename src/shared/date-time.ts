const timezoneCorrectionAttempts = 3;
const maximumTimezoneOverlapMinutes = 180;
const millisecondsPerMinute = 60_000;
const preferredCfpDeadlineTime = "17:00";
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export type EventLocalDateTimeResolution =
  | { status: "resolved"; iso: string }
  | { status: "invalid" }
  | { status: "ambiguous" };

/** Resolves event wall time through repeated offset checks so DST changes settle without using the browser timezone. */
export function eventLocalDateTimeToIso(input: {
  localDateTime: string;
  timezone: string;
}): string | undefined {
  const { localDateTime: value, timezone } = input;
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

  return isoToEventLocalDateTime({
    instant: new Date(instant).toISOString(),
    timezone,
  }) === value
    ? new Date(instant).toISOString()
    : undefined;
}

export function resolveEventLocalDateTime(input: {
  localDateTime: string;
  timezone: string;
}): EventLocalDateTimeResolution {
  const { localDateTime: value, timezone } = input;
  const resolved = eventLocalDateTimeToIso(input);
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
      isoToEventLocalDateTime({
        instant: new Date(candidate).toISOString(),
        timezone,
      }) === value
    ) {
      matchingInstants.add(candidate);
    }
  }
  return matchingInstants.size === 1
    ? { status: "resolved", iso: resolved }
    : { status: "ambiguous" };
}

export function isoToEventLocalDateTime(input: {
  instant: string;
  timezone: string;
}): string {
  const { instant: value, timezone } = input;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = dateTimeParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function instantFallsAfterLocalDate(input: {
  instant: string;
  localDate: string;
  timezone: string;
}): boolean {
  return isoToEventLocalDateTime(input).slice(0, 10) > input.localDate;
}

export function instantFallsBeforeLocalDate(input: {
  instant: string;
  localDate: string;
  timezone: string;
}): boolean {
  return isoToEventLocalDateTime(input).slice(0, 10) < input.localDate;
}

export function defaultCfpDeadline(input: {
  startsOn: string;
  endsOn: string;
  timezone: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const preferred = eventLocalDateTimeToIso({
    localDateTime: `${input.startsOn}T${preferredCfpDeadlineTime}`,
    timezone: input.timezone,
  });
  if (preferred && new Date(preferred) > now) return preferred;

  const nextMinute = new Date(
    Math.floor(now.getTime() / millisecondsPerMinute) * millisecondsPerMinute +
      2 * millisecondsPerMinute,
  );
  const nextLocalDate = isoToEventLocalDateTime({
    instant: nextMinute.toISOString(),
    timezone: input.timezone,
  }).slice(0, 10);
  return nextLocalDate >= input.startsOn && nextLocalDate <= input.endsOn
    ? nextMinute.toISOString()
    : "";
}

export function cfpDeadlineInputBounds(input: {
  endsOn: string;
  timezone: string;
  now?: Date;
}): { min: string; max: string } {
  const now = input.now ?? new Date();
  const nextMinute = new Date(
    Math.floor(now.getTime() / millisecondsPerMinute) * millisecondsPerMinute +
      millisecondsPerMinute,
  );
  const localDateTimes = new Map<string, number>();
  for (
    let offsetMinutes = -maximumTimezoneOverlapMinutes;
    offsetMinutes <= maximumTimezoneOverlapMinutes * 2;
    offsetMinutes += 1
  ) {
    const instant = new Date(
      nextMinute.getTime() + offsetMinutes * millisecondsPerMinute,
    );
    const localDateTime = isoToEventLocalDateTime({
      instant: instant.toISOString(),
      timezone: input.timezone,
    });
    localDateTimes.set(
      localDateTime,
      (localDateTimes.get(localDateTime) ?? 0) + 1,
    );
  }

  let min = "";
  for (
    let attempt = 0;
    attempt <= maximumTimezoneOverlapMinutes;
    attempt += 1
  ) {
    const candidate = new Date(
      nextMinute.getTime() + attempt * millisecondsPerMinute,
    );
    const localDateTime = isoToEventLocalDateTime({
      instant: candidate.toISOString(),
      timezone: input.timezone,
    });
    if (localDateTimes.get(localDateTime) === 1) {
      min = localDateTime;
      break;
    }
  }
  return {
    min,
    max: `${input.endsOn}T23:59`,
  };
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
  let formatter = dateTimeFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });
    dateTimeFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(date);
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
