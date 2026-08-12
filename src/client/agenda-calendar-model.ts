import type { EventInput } from "@fullcalendar/core";

import type { AgendaCalendarItem } from "./AgendaCalendar";

export type WorkingAgenda = {
  revision: number;
  timezone: string;
  startsOn: string;
  endsOn: string;
  rooms: Array<{
    id: string;
    name: string;
    position: number;
    archived: boolean;
  }>;
  unplacedProgramItems: Array<{
    id: string;
    title: string;
    format: string;
    track: string;
  }>;
  items: WorkingItem[];
};

export type WorkingItem = {
  id: string;
  kind: "program" | "service";
  programItemId: string | null;
  title: string | null;
  serviceTitle: string | null;
  serviceScope: "event" | "room" | null;
  roomId: string | null;
  roomName: string | null;
  roomArchivedAt: string | null;
  startsAtLocal: string;
  endsAtLocal: string;
  revision: number;
  canceled: boolean;
  format: string | null;
  trackName: string | null;
  conflicts: Array<"room" | "speaker">;
  speakers: Array<{ displayName: string }>;
};

export type PublicVisibleHours = {
  slotMinTime: string;
  slotMaxTime: string;
  scrollTime: string;
};

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

export function placeProgramInAgenda(
  agenda: WorkingAgenda,
  input: {
    temporaryId: string;
    programItemId: string;
    roomId: string | null;
    startsAtLocal: string;
    endsAtLocal: string;
  },
): WorkingAgenda {
  const program = agenda.unplacedProgramItems.find(
    (item) => item.id === input.programItemId,
  );
  if (!program) return agenda;
  return advanceAgenda(agenda, {
    items: [
      ...agenda.items,
      {
        id: input.temporaryId,
        kind: "program",
        programItemId: program.id,
        title: program.title,
        serviceTitle: null,
        serviceScope: null,
        roomId: input.roomId,
        roomName: roomName(agenda, input.roomId),
        roomArchivedAt: null,
        startsAtLocal: input.startsAtLocal,
        endsAtLocal: input.endsAtLocal,
        revision: 1,
        canceled: false,
        format: program.format,
        trackName: program.track,
        conflicts: [],
        speakers: [],
      },
    ],
    unplacedProgramItems: agenda.unplacedProgramItems.filter(
      (item) => item.id !== input.programItemId,
    ),
  });
}

export function placeServiceInAgenda(
  agenda: WorkingAgenda,
  input: {
    temporaryId: string;
    title: string;
    scope: { type: "event" } | { type: "room"; roomId: string };
    startsAtLocal: string;
    endsAtLocal: string;
  },
): WorkingAgenda {
  const roomId = input.scope.type === "room" ? input.scope.roomId : null;
  return advanceAgenda(agenda, {
    items: [
      ...agenda.items,
      {
        id: input.temporaryId,
        kind: "service",
        programItemId: null,
        title: null,
        serviceTitle: input.title,
        serviceScope: input.scope.type,
        roomId,
        roomName: roomName(agenda, roomId),
        roomArchivedAt: null,
        startsAtLocal: input.startsAtLocal,
        endsAtLocal: input.endsAtLocal,
        revision: 1,
        canceled: false,
        format: null,
        trackName: null,
        conflicts: [],
        speakers: [],
      },
    ],
  });
}

export function replaceAgendaItemId(
  agenda: WorkingAgenda,
  temporaryId: string,
  durableId: string,
): WorkingAgenda {
  return {
    ...agenda,
    items: agenda.items.map((item) =>
      item.id === temporaryId ? { ...item, id: durableId } : item,
    ),
  };
}

export function moveItemInAgenda(
  agenda: WorkingAgenda,
  input: {
    agendaItemId: string;
    roomId: string | null;
    startsAtLocal: string;
    endsAtLocal: string;
  },
): WorkingAgenda {
  return updateItem(agenda, input.agendaItemId, (item) => ({
    ...item,
    roomId: input.roomId,
    roomName: roomName(agenda, input.roomId),
    startsAtLocal: input.startsAtLocal,
    endsAtLocal: input.endsAtLocal,
    revision: item.revision + 1,
  }));
}

export function updateServiceInAgenda(
  agenda: WorkingAgenda,
  input: {
    agendaItemId: string;
    title: string;
    scope: { type: "event" } | { type: "room"; roomId: string };
    startsAtLocal: string;
    endsAtLocal: string;
  },
): WorkingAgenda {
  const roomId = input.scope.type === "room" ? input.scope.roomId : null;
  return updateItem(agenda, input.agendaItemId, (item) => ({
    ...item,
    serviceTitle: input.title,
    serviceScope: input.scope.type,
    roomId,
    roomName: roomName(agenda, roomId),
    startsAtLocal: input.startsAtLocal,
    endsAtLocal: input.endsAtLocal,
    revision: item.revision + 1,
  }));
}

export function setCanceledInAgenda(
  agenda: WorkingAgenda,
  agendaItemId: string,
  canceled: boolean,
): WorkingAgenda {
  return updateItem(agenda, agendaItemId, (item) => ({ ...item, canceled }));
}

export function unplaceProgramInAgenda(
  agenda: WorkingAgenda,
  agendaItemId: string,
): WorkingAgenda {
  const item = agenda.items.find((candidate) => candidate.id === agendaItemId);
  if (!item?.programItemId || !item.title || !item.format || !item.trackName) {
    return agenda;
  }
  return advanceAgenda(agenda, {
    items: agenda.items.filter((candidate) => candidate.id !== agendaItemId),
    unplacedProgramItems: [
      ...agenda.unplacedProgramItems,
      {
        id: item.programItemId,
        title: item.title,
        format: item.format,
        track: item.trackName,
      },
    ].sort((left, right) => left.title.localeCompare(right.title)),
  });
}

export function removeItemFromAgenda(
  agenda: WorkingAgenda,
  agendaItemId: string,
): WorkingAgenda {
  return advanceAgenda(agenda, {
    items: agenda.items.filter((item) => item.id !== agendaItemId),
  });
}

export function derivePublicVisibleHours(
  items: Array<{ startsAt: string; endsAt: string }>,
  timezone: string,
): PublicVisibleHours {
  if (items.length === 0) return visibleHours(8, 18);
  const ranges = items.map((item) => {
    const start = localParts(item.startsAt, timezone);
    const end = localParts(item.endsAt, timezone);
    return {
      start,
      end:
        end.minutes === 0 && end.date === addDays(start.date, 1)
          ? { ...end, date: start.date, minutes: 24 * 60 }
          : end,
    };
  });
  if (ranges.some(({ start, end }) => start.date !== end.date)) {
    return visibleHours(0, 24);
  }
  const earliest = Math.min(...ranges.map(({ start }) => start.minutes));
  const latest = Math.max(...ranges.map(({ end }) => end.minutes));
  return visibleHours(
    Math.max(0, Math.floor(earliest / 60) - 1),
    Math.min(24, Math.ceil(latest / 60) + 1),
  );
}

function updateItem(
  agenda: WorkingAgenda,
  agendaItemId: string,
  update: (item: WorkingItem) => WorkingItem,
): WorkingAgenda {
  if (!agenda.items.some((item) => item.id === agendaItemId)) return agenda;
  return advanceAgenda(agenda, {
    items: agenda.items.map((item) =>
      item.id === agendaItemId ? update(item) : item,
    ),
  });
}

function advanceAgenda(
  agenda: WorkingAgenda,
  values: Partial<Pick<WorkingAgenda, "items" | "unplacedProgramItems">>,
): WorkingAgenda {
  return { ...agenda, ...values, revision: agenda.revision + 1 };
}

function roomName(agenda: WorkingAgenda, roomId: string | null): string | null {
  return agenda.rooms.find((room) => room.id === roomId)?.name ?? null;
}

function localParts(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: hour * 60 + minute,
  };
}

function visibleHours(startHour: number, endHour: number): PublicVisibleHours {
  const time = (hour: number) => `${String(hour).padStart(2, "0")}:00:00`;
  return {
    slotMinTime: time(startHour),
    slotMaxTime: time(endHour),
    scrollTime: time(startHour),
  };
}
