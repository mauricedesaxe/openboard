import type {
  DatesSetArg,
  EventClickArg,
  EventContentArg,
  EventDropArg,
} from "@fullcalendar/core";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import momentTimezonePlugin from "@fullcalendar/moment-timezone";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { useEffect, useRef } from "react";

import { addDays, toCalendarEvent, trackColor } from "./agenda-calendar-model";

type DateClickArg = { dateStr: string };

export type AgendaCalendarItem = {
  id: string;
  kind: "program" | "service";
  title: string;
  roomId: string | null;
  roomName: string | null;
  startsAt: string;
  endsAt: string;
  trackName: string | null;
  speakers: Array<{ displayName: string }>;
  canceled?: boolean;
  conflicts?: Array<"room" | "speaker">;
};

type AgendaCalendarProps = {
  editable: boolean;
  endsOn: string;
  items: AgendaCalendarItem[];
  onCreateService?: (startsAt: string, endsAt: string) => void;
  onExternalDrop?: (
    paletteId: string,
    startsAt: string,
    endsAt: string,
  ) => void;
  onMove?: (
    id: string,
    startsAt: string,
    endsAt: string,
    revert: () => void,
  ) => void;
  onSelect: (id: string) => void;
  onVisibleStartChange: (start: string) => void;
  roomId: string;
  selectedId: string | null;
  startsOn: string;
  timezone: string;
  view: "calendar" | "list";
  visibleStart: string;
};

export function AgendaCalendar({
  editable,
  endsOn,
  items,
  onCreateService,
  onExternalDrop,
  onMove,
  onSelect,
  onVisibleStartChange,
  roomId,
  selectedId,
  startsOn,
  timezone,
  view,
  visibleStart,
}: AgendaCalendarProps) {
  const calendarRef = useRef<FullCalendar>(null);
  const visibleEnd = addDays(
    visibleStart,
    Math.min(7, daysBetween(visibleStart, endsOn) + 1),
  );
  const visibleItems = items.filter(
    (item) => !roomId || item.roomId === roomId || item.roomId === null,
  );

  useEffect(() => {
    const calendar = calendarRef.current?.getApi();
    if (!calendar) return;
    calendar.changeView(view === "list" ? "listAgenda" : "agendaRange", {
      start: visibleStart,
      end: visibleEnd,
    });
  }, [view, visibleEnd, visibleStart]);

  function datesChanged(info: DatesSetArg) {
    const start = info.startStr.slice(0, 10);
    if (start !== visibleStart) onVisibleStartChange(start);
  }

  function selectEvent(info: EventClickArg) {
    onSelect(info.event.id);
  }

  function moveEvent(info: EventDropArg | EventResizeDoneArg) {
    if (!onMove) return;
    const start = info.event.startStr.slice(0, 16);
    const end = (info.event.endStr || info.event.startStr).slice(0, 16);
    onMove(info.event.id, start, end, info.revert);
  }

  function createService(info: DateClickArg) {
    if (!onCreateService) return;
    const start = info.dateStr.slice(0, 16);
    onCreateService(start, addLocalMinutes(start, 60));
  }

  return (
    <div className="agenda-calendar" data-testid="agenda-calendar">
      <FullCalendar
        allDaySlot={false}
        {...(editable ? { dateClick: createService } : {})}
        datesSet={datesChanged}
        editable={editable}
        droppable={editable}
        eventClick={selectEvent}
        eventContent={(info) => (
          <AgendaEventCard info={info} selectedId={selectedId} />
        )}
        eventDrop={moveEvent}
        eventDurationEditable={editable}
        eventInteractive
        eventMaxStack={3}
        eventReceive={(info) => {
          const paletteId = info.event.extendedProps.paletteId as string;
          const startsAt = info.event.startStr.slice(0, 16);
          const endsAt = (
            info.event.endStr || addLocalMinutes(startsAt, 60)
          ).slice(0, 16);
          info.event.remove();
          onExternalDrop?.(paletteId, startsAt, endsAt);
        }}
        eventResize={moveEvent}
        events={visibleItems.map(toCalendarEvent)}
        headerToolbar={false}
        height="auto"
        initialDate={visibleStart}
        initialView={view === "list" ? "listAgenda" : "agendaRange"}
        nowIndicator
        plugins={[
          timeGridPlugin,
          interactionPlugin,
          listPlugin,
          momentTimezonePlugin,
        ]}
        ref={calendarRef}
        selectable={editable}
        scrollTime="08:00:00"
        slotDuration="00:15:00"
        slotEventOverlap
        snapDuration="00:15:00"
        timeZone={timezone}
        validRange={{ start: startsOn, end: addDays(endsOn, 1) }}
        views={{
          agendaRange: {
            type: "timeGrid",
            visibleRange: { start: visibleStart, end: visibleEnd },
          },
          listAgenda: {
            type: "list",
            visibleRange: { start: visibleStart, end: visibleEnd },
          },
        }}
      />
    </div>
  );
}

function AgendaEventCard({
  info,
  selectedId,
}: {
  info: EventContentArg;
  selectedId: string | null;
}) {
  const item = info.event.extendedProps as Omit<AgendaCalendarItem, "id">;
  return (
    <div
      className={`agenda-calendar-card${info.event.id === selectedId ? " is-selected" : ""}${item.canceled ? " is-canceled" : ""}`}
      style={
        { "--track-color": trackColor(item.trackName) } as React.CSSProperties
      }
    >
      <strong>{info.event.title}</strong>
      <span>
        {item.roomName ??
          (item.kind === "service" ? "All rooms" : "Unassigned")}
      </span>
      {(item.speakers?.length ?? 0) > 0 && (
        <small>
          {item.speakers?.map((speaker) => speaker.displayName).join(", ")}
        </small>
      )}
      <div className="agenda-calendar-card-status">
        {item.conflicts?.map((conflict) => (
          <b key={conflict}>{conflict} conflict</b>
        ))}
        {item.canceled && <b>Canceled</b>}
      </div>
    </div>
  );
}

function daysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86_400_000,
  );
}

function addLocalMinutes(value: string, minutes: number): string {
  const date = new Date(`${value}:00Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 16);
}
