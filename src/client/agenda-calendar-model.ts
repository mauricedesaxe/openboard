import type { EventInput } from "@fullcalendar/core";

import type { AgendaCalendarItem } from "./AgendaCalendar";

export const agendaLibraryDecision = {
  library: "FullCalendar Standard 6.1.21",
  license: "MIT",
  cost: "$0",
  keyboardEditing:
    "Inspector controls provide the precise keyboard path because keyboard drag and slot selection are not supported.",
};

export function toCalendarEvent(item: AgendaCalendarItem): EventInput {
  return {
    id: item.id,
    title: item.title,
    start: item.startsAt,
    end: item.endsAt,
    classNames: [
      `agenda-event-${item.kind}`,
      ...(item.conflicts?.length ? ["agenda-event-conflict"] : []),
      ...(item.canceled ? ["agenda-event-canceled"] : []),
    ],
    extendedProps: item,
  };
}

export function trackColor(trackName: string | null): string {
  if (!trackName) return "#355c52";
  const palette = ["#355c52", "#d45d3a", "#6557a5", "#237c8c", "#9a6b16"];
  let hash = 0;
  for (const character of trackName) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return palette[hash % palette.length] ?? "#355c52";
}

export function clampVisibleStart(
  requested: string | null,
  startsOn: string,
  endsOn: string,
): string {
  if (!requested || requested < startsOn) return startsOn;
  if (requested > endsOn) return endsOn;
  return requested;
}

export function addDays(value: string, count: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
