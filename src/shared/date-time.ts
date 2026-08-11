const timezoneCorrectionAttempts = 3;

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

export function unambiguousEventLocalDateTimeToIso(
  value: string,
  timezone: string,
): string | undefined {
  const resolved = eventLocalDateTimeToIso(value, timezone);
  if (!resolved) return undefined;
  const resolvedTime = new Date(resolved).getTime();
  const matchingInstants = new Set<number>();
  for (let offsetMinutes = -180; offsetMinutes <= 180; offsetMinutes += 1) {
    const candidate = resolvedTime + offsetMinutes * 60_000;
    if (
      isoToEventLocalDateTime(new Date(candidate).toISOString(), timezone) ===
      value
    ) {
      matchingInstants.add(candidate);
    }
  }
  return matchingInstants.size === 1 ? resolved : undefined;
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
