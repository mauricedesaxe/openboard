import type { PublishedSchedule } from "../../shared/published-schedule";

export type AgendaCalendarMessageInput = {
  eventName: string;
  timezone: string;
  publishedAt: string;
  destination: string;
  recipientName: string;
  organizerEmail: string;
  action: "publish" | "update" | "cancel" | "restore";
  uid: string;
  sequence: number;
  item: {
    title: string;
    abstract: string | null;
    trackName: string | null;
    roomName: string | null;
    startsAt: string;
    endsAt: string;
    speakers: string[];
  };
};

/** RFC 5545 limits content lines to 75 UTF-8 octets before folding. */
const icalContentLineOctetLimit = 75;

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

export function renderAgendaCalendarMessage(input: AgendaCalendarMessageInput) {
  const canceled = input.action === "cancel";
  const method: "CANCEL" | "REQUEST" = canceled ? "CANCEL" : "REQUEST";
  const description = [
    input.item.abstract,
    input.item.speakers.length > 0
      ? `Speakers: ${input.item.speakers.join(", ")}`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//OpenBoard//Agenda Delivery 1.0//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    `X-WR-TIMEZONE:${escapeText(input.timezone)}`,
    "BEGIN:VEVENT",
    `UID:${escapeText(input.uid)}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${calendarDateTime(input.publishedAt)}`,
    `DTSTART:${calendarDateTime(input.item.startsAt)}`,
    `DTEND:${calendarDateTime(input.item.endsAt)}`,
    `SUMMARY:${escapeText(input.item.title)}`,
    `ORGANIZER:mailto:${input.organizerEmail}`,
    `ATTENDEE;CN=${escapeParameter(input.recipientName)}:mailto:${input.destination}`,
  ];
  if (input.item.roomName) {
    lines.push(`LOCATION:${escapeText(input.item.roomName)}`);
  }
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (input.item.trackName) {
    lines.push(`CATEGORIES:${escapeText(input.item.trackName)}`);
  }
  lines.push(
    `STATUS:${canceled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  );
  const calendar = `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
  const action =
    input.action === "publish"
      ? "Invitation"
      : input.action === "cancel"
        ? "Canceled"
        : "Updated";
  return {
    method,
    subject: `${action}: ${input.item.title} at ${input.eventName}`,
    text: `${input.recipientName}, your calendar entry for ${input.item.title} at ${input.eventName} is ${canceled ? "canceled" : "attached"}.`,
    calendar,
  };
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

function escapeParameter(value: string): string {
  return `"${value
    .replaceAll("^", "^^")
    .replaceAll("\r\n", "^n")
    .replaceAll("\r", "^n")
    .replaceAll("\n", "^n")
    .replaceAll('"', "^'")}"`;
}

function foldLine(line: string): string[] {
  const folded: string[] = [];
  let current = "";
  let limit = icalContentLineOctetLimit;
  for (const character of line) {
    const candidate = `${current}${character}`;
    if (
      current.length > 0 &&
      new TextEncoder().encode(candidate).byteLength > limit
    ) {
      folded.push(current);
      current = ` ${character}`;
      limit = icalContentLineOctetLimit;
    } else {
      current = candidate;
    }
  }
  folded.push(current);
  return folded;
}
