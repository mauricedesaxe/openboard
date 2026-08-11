import type { PublishedSchedule } from "../../shared/published-schedule";

export function renderPublishedScheduleCalendar(
  schedule: PublishedSchedule,
): string {
  const tracks = new Map(schedule.tracks.map((track) => [track.id, track]));
  const rooms = new Map(schedule.rooms.map((room) => [room.id, room]));
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//OpenBoard//Published Schedule 1.0//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(schedule.event.name)}`,
    `X-WR-TIMEZONE:${escapeText(schedule.event.timezone)}`,
    `X-OPENBOARD-REVISION:${schedule.revision}`,
  ];

  for (const item of schedule.items) {
    const uid =
      item.kind === "session" ? item.calendar.uid : `${item.id}@openboard`;
    const sequence = item.kind === "session" ? item.calendar.sequence : 0;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(uid)}`,
      `SEQUENCE:${sequence}`,
      `DTSTAMP:${calendarDateTime(schedule.publishedAt)}`,
      `DTSTART:${calendarDateTime(item.startsAt)}`,
      `DTEND:${calendarDateTime(item.endsAt)}`,
      `SUMMARY:${escapeText(item.title)}`,
    );
    if (item.roomId) {
      const room = rooms.get(item.roomId);
      if (room) lines.push(`LOCATION:${escapeText(room.name)}`);
    }
    if (item.kind === "session") {
      const description = [
        item.abstract,
        item.speakers.length > 0
          ? `Speakers: ${item.speakers.map((speaker) => speaker.displayName).join(", ")}`
          : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n");
      if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
      const track = tracks.get(item.trackId);
      if (track) lines.push(`CATEGORIES:${escapeText(track.name)}`);
    }
    lines.push("STATUS:CONFIRMED", "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
}

function calendarDateTime(value: string): string {
  return new Date(value)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function foldLine(line: string): string[] {
  const folded: string[] = [];
  let current = "";
  let limit = 75;
  for (const character of line) {
    const candidate = `${current}${character}`;
    if (
      current.length > 0 &&
      new TextEncoder().encode(candidate).byteLength > limit
    ) {
      folded.push(current);
      current = ` ${character}`;
      limit = 75;
    } else {
      current = candidate;
    }
  }
  folded.push(current);
  return folded;
}
