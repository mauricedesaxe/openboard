import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { formatEventDateRange } from "../shared/date-time";

import { MutationStatus } from "./MutationStatus";
import { useMutationStatuses } from "./mutation-feedback";
import { useTRPC } from "./trpc";

const defaultAgendaStartTime = "09:00";
const defaultAgendaEndTime = "10:00";

export function AgendaPage() {
  const { slug = "" } = useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const agenda = useQuery(trpc.agendas.working.queryOptions({ slug }));
  const communicationFailures = useQuery(
    trpc.communications.failures.queryOptions({ slug }),
  );
  const [programItemId, setProgramItemId] = useState("");
  const [programRoomId, setProgramRoomId] = useState("");
  const [programStart, setProgramStart] = useState<string>();
  const [programEnd, setProgramEnd] = useState<string>();
  const [serviceTitle, setServiceTitle] = useState("");
  const [serviceScope, setServiceScope] = useState<"event" | "room">("event");
  const [serviceRoomId, setServiceRoomId] = useState("");
  const [serviceStart, setServiceStart] = useState<string>();
  const [serviceEnd, setServiceEnd] = useState<string>();
  const refresh = () =>
    queryClient.invalidateQueries(trpc.agendas.working.queryFilter({ slug }));
  const placeProgram = useMutation(
    trpc.agendas.placeProgram.mutationOptions({
      onSuccess: async () => {
        setProgramItemId("");
        await refresh();
      },
    }),
  );
  const placeService = useMutation(
    trpc.agendas.placeService.mutationOptions({
      onSuccess: async () => {
        setServiceTitle("");
        await refresh();
      },
    }),
  );
  const move = useMutation(
    trpc.agendas.move.mutationOptions({ onSuccess: refresh }),
  );
  const cancel = useMutation(
    trpc.agendas.cancel.mutationOptions({ onSuccess: refresh }),
  );
  const restore = useMutation(
    trpc.agendas.restore.mutationOptions({ onSuccess: refresh }),
  );
  const removeService = useMutation(
    trpc.agendas.removeService.mutationOptions({ onSuccess: refresh }),
  );
  const publish = useMutation(
    trpc.agendas.publish.mutationOptions({
      onSuccess: async () => {
        await refresh();
        await queryClient.invalidateQueries(
          trpc.agendas.published.queryFilter({ slug }),
        );
      },
    }),
  );
  const agendaStatus = useMutationStatuses([
    {
      mutation: placeProgram,
      mutationKey: trpc.agendas.placeProgram.mutationKey(),
      success: "Program item placed",
    },
    {
      mutation: placeService,
      mutationKey: trpc.agendas.placeService.mutationKey(),
      success: "Service block added",
    },
    {
      mutation: move,
      mutationKey: trpc.agendas.move.mutationKey(),
      success: "Placement moved",
    },
    {
      mutation: cancel,
      mutationKey: trpc.agendas.cancel.mutationKey(),
      success: "Placement canceled",
    },
    {
      mutation: restore,
      mutationKey: trpc.agendas.restore.mutationKey(),
      success: "Placement restored",
    },
    {
      mutation: removeService,
      mutationKey: trpc.agendas.removeService.mutationKey(),
      success: "Service block removed",
    },
  ]);

  if (agenda.isPending) return <AgendaStatus label="Opening working agenda" />;
  if (agenda.isError) {
    return (
      <AgendaStatus
        label="Working agenda unavailable"
        detail={agenda.error.message}
      />
    );
  }

  const eventTimeWindow = agendaTimeWindow(agenda.data);
  const resolvedProgramStart = programStart ?? eventTimeWindow.defaultStart;
  const resolvedProgramEnd = programEnd ?? eventTimeWindow.defaultEnd;
  const resolvedServiceStart = serviceStart ?? eventTimeWindow.defaultStart;
  const resolvedServiceEnd = serviceEnd ?? eventTimeWindow.defaultEnd;

  function submitProgram(event: FormEvent) {
    event.preventDefault();
    if (!programItemId) return;
    placeProgram.mutate({
      slug,
      programItemId,
      roomId: programRoomId || null,
      startsAtLocal: resolvedProgramStart,
      endsAtLocal: resolvedProgramEnd,
    });
  }

  function submitService(event: FormEvent) {
    event.preventDefault();
    if (!serviceTitle) return;
    placeService.mutate({
      slug,
      title: serviceTitle,
      scope:
        serviceScope === "event"
          ? { type: "event" }
          : { type: "room", roomId: serviceRoomId },
      startsAtLocal: resolvedServiceStart,
      endsAtLocal: resolvedServiceEnd,
    });
  }

  return (
    <div className="page agenda-page">
      <div className="agenda-page-nav">
        <Link className="arrow-link" to={`/events/${slug}`}>
          ← Event overview
        </Link>
        <Link className="text-button" to={`/events/${slug}/schedule`}>
          View public agenda
        </Link>
      </div>
      <header className="agenda-heading">
        <div>
          <div className="eyebrow">
            Private workspace · revision {agenda.data.revision}
          </div>
          <h1>Build the agenda.</h1>
          <p>
            Conflicts stay saveable here. Publication checks the current event
            and only releases a coherent snapshot.
          </p>
        </div>
        <button
          className="primary-button"
          disabled={publish.isPending}
          onClick={() =>
            publish.mutate({ slug, expectedRevision: agenda.data.revision })
          }
          type="button"
        >
          {publish.isPending ? "Publishing…" : "Publish agenda"}
        </button>
      </header>

      <MutationStatus
        error={agendaStatus.error}
        success={agendaStatus.success}
      />
      {publish.error && <MutationStatus error={publish.error.message} />}
      {communicationFailures.data?.some((failure) =>
        failure.purpose.startsWith("agenda_"),
      ) && (
        <p className="form-error" role="alert">
          A calendar message failed. Open communications to retry delivery.
        </p>
      )}
      {communicationFailures.isError && (
        <p className="form-error" role="alert">
          Calendar delivery status is unavailable. Try again before you leave
          this agenda.
        </p>
      )}
      {publish.isSuccess && (
        <p className="agenda-published" role="status">
          Public revision {publish.data.revision} is live.{" "}
          {publish.data.deliveryWork} calendar update
          {publish.data.deliveryWork === 1 ? "" : "s"} recorded.
        </p>
      )}

      <section className="agenda-composer">
        <form onSubmit={submitProgram}>
          <div className="eyebrow">Program placement</div>
          <h2>Schedule an accepted item</h2>
          <label>
            Program item
            <select
              onChange={(event) => setProgramItemId(event.target.value)}
              required
              value={programItemId}
            >
              <option value="">Choose accepted item</option>
              {agenda.data.unplacedProgramItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.track}
                </option>
              ))}
            </select>
          </label>
          <AgendaRoomSelect
            allowEmpty
            label="Room"
            onChange={setProgramRoomId}
            rooms={agenda.data.rooms}
            value={programRoomId}
          />
          <AgendaTimeFields
            end={resolvedProgramEnd}
            max={eventTimeWindow.max}
            min={eventTimeWindow.min}
            onEnd={setProgramEnd}
            onStart={setProgramStart}
            start={resolvedProgramStart}
          />
          <AgendaEventContext eventTimeWindow={eventTimeWindow} />
          <button
            className="secondary-button"
            disabled={placeProgram.isPending}
            type="submit"
          >
            {placeProgram.isPending ? "Placing…" : "Place program item"}
          </button>
        </form>

        <form onSubmit={submitService}>
          <div className="eyebrow">Service block</div>
          <h2>Block event time</h2>
          <label>
            Title
            <input
              maxLength={160}
              onChange={(event) => setServiceTitle(event.target.value)}
              required
              value={serviceTitle}
            />
          </label>
          <label>
            Scope
            <select
              onChange={(event) =>
                setServiceScope(event.target.value as "event" | "room")
              }
              value={serviceScope}
            >
              <option value="event">All rooms</option>
              <option value="room">One room</option>
            </select>
          </label>
          {serviceScope === "room" && (
            <AgendaRoomSelect
              label="Room"
              onChange={setServiceRoomId}
              rooms={agenda.data.rooms}
              value={serviceRoomId}
            />
          )}
          <AgendaTimeFields
            end={resolvedServiceEnd}
            max={eventTimeWindow.max}
            min={eventTimeWindow.min}
            onEnd={setServiceEnd}
            onStart={setServiceStart}
            start={resolvedServiceStart}
          />
          <AgendaEventContext eventTimeWindow={eventTimeWindow} />
          <button
            className="secondary-button"
            disabled={placeService.isPending}
            type="submit"
          >
            {placeService.isPending ? "Adding…" : "Add service block"}
          </button>
        </form>
      </section>

      <section className="working-agenda-list">
        <div className="agenda-list-heading">
          <div>
            <div className="eyebrow">Working agenda</div>
            <h2>
              {agenda.data.items.length} durable item
              {agenda.data.items.length === 1 ? "" : "s"}
            </h2>
          </div>
          <span>{agenda.data.timezone}</span>
        </div>
        {agenda.data.items.length === 0 ? (
          <p className="empty-copy">
            Accepted program items and service blocks appear here.
          </p>
        ) : (
          agenda.data.items.map((item) => (
            <AgendaItemEditor
              busy={
                agendaStatus.isPendingFor(move, "agendaItemId", item.id)
                  ? "move"
                  : agendaStatus.isPendingFor(cancel, "agendaItemId", item.id)
                    ? "cancel"
                    : agendaStatus.isPendingFor(
                          restore,
                          "agendaItemId",
                          item.id,
                        )
                      ? "restore"
                      : agendaStatus.isPendingFor(
                            removeService,
                            "agendaItemId",
                            item.id,
                          )
                        ? "remove"
                        : undefined
              }
              item={item}
              key={item.id}
              eventTimeWindow={eventTimeWindow}
              onCancel={() => cancel.mutate({ slug, agendaItemId: item.id })}
              onMove={(input) =>
                move.mutate({ slug, agendaItemId: item.id, ...input })
              }
              onRemove={() =>
                removeService.mutate({ slug, agendaItemId: item.id })
              }
              onRestore={() => restore.mutate({ slug, agendaItemId: item.id })}
              rooms={agenda.data.rooms}
            />
          ))
        )}
      </section>
    </div>
  );
}

export function PublicAgendaPage() {
  const { slug = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const trpc = useTRPC();
  const agenda = useQuery(
    trpc.agendas.published.queryOptions(
      { slug },
      { retry: false, refetchOnWindowFocus: false },
    ),
  );
  if (agenda.isPending) return <AgendaStatus label="Opening public agenda" />;
  if (agenda.isError) {
    return (
      <AgendaStatus
        label="Agenda not published"
        detail={agenda.error.message}
      />
    );
  }
  const view = searchParams.get("view") ?? "list";
  const track = searchParams.get("track");
  const room = searchParams.get("room");
  const date = searchParams.get("date");
  const tracks = unique(
    agenda.data.items.flatMap((item) => item.trackName ?? []),
  );
  const rooms = unique(
    agenda.data.items.flatMap((item) => item.roomName ?? []),
  );
  const dates = unique(
    agenda.data.items.map((item) =>
      localDate(item.startsAt, agenda.data.event.timezone),
    ),
  );
  const weeks = unique(dates.map(localWeekStart));
  const selectedTrack = effectiveFilter(track, tracks);
  const selectedRoom = effectiveFilter(room, rooms);
  const selectedDate = effectiveFilter(date, dates);
  const selectedWeek = effectiveFilter(searchParams.get("week"), weeks);
  const visible = agenda.data.items.filter((item) => {
    const eventWideService = item.kind === "service" && item.roomName === null;
    if (view === "track" && selectedTrack) {
      return eventWideService || item.trackName === selectedTrack;
    }
    if (view === "room" && selectedRoom) {
      return eventWideService || item.roomName === selectedRoom;
    }
    const itemDate = localDate(item.startsAt, agenda.data.event.timezone);
    if (view === "day" && selectedDate) {
      return itemDate === selectedDate;
    }
    if (view === "week" && selectedWeek) {
      return localWeekStart(itemDate) === selectedWeek;
    }
    return true;
  });

  function chooseView(nextView: string) {
    const next = new URLSearchParams();
    next.set("view", nextView);
    if (nextView === "track" && tracks[0]) next.set("track", tracks[0]);
    if (nextView === "room" && rooms[0]) next.set("room", rooms[0]);
    if (nextView === "day" && dates[0]) next.set("date", dates[0]);
    if (nextView === "week" && weeks[0]) next.set("week", weeks[0]);
    setSearchParams(next);
  }

  return (
    <main className="public-agenda">
      <header className="public-agenda-header">
        <Link className="wordmark" to="/">
          <span className="wordmark-mark">OB</span>
          <span>{agenda.data.event.name}</span>
        </Link>
        <div>
          <div className="eyebrow">
            Published agenda · revision {agenda.data.revision}
          </div>
          <h1>Where to be next.</h1>
          <p>{agenda.data.event.timezone}</p>
        </div>
      </header>
      <nav className="agenda-view-tabs" aria-label="Agenda views">
        {["list", "day", "week", "track", "room"].map((candidate) => (
          <button
            aria-pressed={view === candidate}
            key={candidate}
            onClick={() => chooseView(candidate)}
            type="button"
          >
            {candidate}
          </button>
        ))}
      </nav>
      {view === "day" && (
        <AgendaFilter
          label="Day"
          onChange={(value) => setSearchParams({ view, date: value })}
          options={dates}
          value={selectedDate ?? ""}
        />
      )}
      {view === "week" && (
        <AgendaFilter
          label="Week"
          onChange={(value) => setSearchParams({ view, week: value })}
          optionLabel={formatWeek}
          options={weeks}
          value={selectedWeek ?? ""}
        />
      )}
      {view === "track" && (
        <AgendaFilter
          label="Track"
          onChange={(value) => setSearchParams({ view, track: value })}
          options={tracks}
          value={selectedTrack ?? ""}
        />
      )}
      {view === "room" && (
        <AgendaFilter
          label="Room"
          onChange={(value) => setSearchParams({ view, room: value })}
          options={rooms}
          value={selectedRoom ?? ""}
        />
      )}
      <div className={`public-agenda-items public-agenda-${view}`}>
        {visible.length === 0 ? (
          <p className="empty-copy">No published items match this view.</p>
        ) : (
          visible.map((item) => (
            <article className="public-agenda-item" key={item.id}>
              <time>
                {formatAgendaTime(item.startsAt, agenda.data.event.timezone)}
                <span>
                  – {formatAgendaTime(item.endsAt, agenda.data.event.timezone)}
                </span>
              </time>
              <div>
                <div className="agenda-item-tags">
                  <span>{item.roomName ?? "All rooms"}</span>
                  {item.trackName && <span>{item.trackName}</span>}
                </div>
                <h2>{item.title}</h2>
                {item.speakers.length > 0 && (
                  <p>
                    {item.speakers
                      .map((speaker) => speaker.displayName)
                      .join(", ")}
                  </p>
                )}
                {item.abstract && (
                  <p className="agenda-abstract">{item.abstract}</p>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </main>
  );
}

function AgendaItemEditor({
  item,
  eventTimeWindow,
  rooms,
  onMove,
  onCancel,
  onRestore,
  onRemove,
  busy,
}: {
  item: {
    id: string;
    kind: "program" | "service";
    title: string | null;
    serviceTitle: string | null;
    serviceScope: "event" | "room" | null;
    roomId: string | null;
    roomName: string | null;
    startsAtLocal: string;
    endsAtLocal: string;
    canceled: boolean;
    conflicts: Array<"room" | "speaker">;
    speakers: Array<{ displayName: string }>;
  };
  eventTimeWindow: AgendaTimeWindow;
  rooms: Array<{ id: string; name: string }>;
  onMove: (input: {
    roomId: string | null;
    startsAtLocal: string;
    endsAtLocal: string;
  }) => void;
  onCancel: () => void;
  onRestore: () => void;
  onRemove: () => void;
  busy?: "move" | "cancel" | "restore" | "remove" | undefined;
}) {
  const [roomId, setRoomId] = useState(item.roomId ?? "");
  const [start, setStart] = useState(item.startsAtLocal);
  const [end, setEnd] = useState(item.endsAtLocal);
  return (
    <article
      className={`working-agenda-item${item.canceled ? " is-canceled" : ""}`}
    >
      <div className="working-item-summary">
        <div className="agenda-item-tags">
          <span>
            {item.kind === "program"
              ? "Program"
              : item.serviceScope === "event"
                ? "All rooms"
                : "Room block"}
          </span>
          {item.conflicts.map((conflict) => (
            <strong key={conflict}>{conflict} conflict</strong>
          ))}
          {item.canceled && <strong>Canceled</strong>}
        </div>
        <h3>{item.kind === "program" ? item.title : item.serviceTitle}</h3>
        {item.speakers.length > 0 && (
          <p>
            {item.speakers.map((speaker) => speaker.displayName).join(", ")}
          </p>
        )}
      </div>
      <form
        className="working-item-controls"
        onSubmit={(event) => {
          event.preventDefault();
          onMove({
            roomId: item.serviceScope === "event" ? null : roomId || null,
            startsAtLocal: start,
            endsAtLocal: end,
          });
        }}
      >
        {item.serviceScope !== "event" && (
          <AgendaRoomSelect
            allowEmpty={item.kind === "program"}
            label="Room"
            onChange={setRoomId}
            rooms={rooms}
            value={roomId}
          />
        )}
        <AgendaTimeFields
          end={end}
          max={eventTimeWindow.max}
          min={eventTimeWindow.min}
          onEnd={setEnd}
          onStart={setStart}
          start={start}
        />
        <AgendaEventContext eventTimeWindow={eventTimeWindow} />
        <div className="working-item-actions">
          <button
            className="text-button"
            disabled={busy === "move"}
            type="submit"
          >
            {busy === "move" ? "Saving…" : "Save move"}
          </button>
          {item.kind === "program" ? (
            <button
              className="text-button"
              disabled={busy === "cancel" || busy === "restore"}
              onClick={item.canceled ? onRestore : onCancel}
              type="button"
            >
              {item.canceled
                ? busy === "restore"
                  ? "Restoring…"
                  : "Restore"
                : busy === "cancel"
                  ? "Canceling…"
                  : "Cancel"}
            </button>
          ) : (
            <button
              className="text-button"
              disabled={busy === "remove"}
              onClick={onRemove}
              type="button"
            >
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
      </form>
    </article>
  );
}

function AgendaRoomSelect({
  label,
  rooms,
  value,
  onChange,
  allowEmpty = false,
}: {
  label: string;
  rooms: Array<{ id: string; name: string }>;
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
}) {
  return (
    <label>
      {label}
      <select
        onChange={(event) => onChange(event.target.value)}
        required={!allowEmpty}
        value={value}
      >
        <option value="">{allowEmpty ? "Unassigned" : "Choose room"}</option>
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AgendaTimeFields({
  start,
  end,
  min,
  max,
  onStart,
  onEnd,
}: {
  start: string;
  end: string;
  min: string;
  max: string;
  onStart: (value: string) => void;
  onEnd: (value: string) => void;
}) {
  return (
    <div className="agenda-time-fields">
      <label>
        Starts
        <input
          max={max}
          min={min}
          onChange={(event) => onStart(event.target.value)}
          required
          type="datetime-local"
          value={start}
        />
      </label>
      <label>
        Ends
        <input
          max={max}
          min={min}
          onChange={(event) => onEnd(event.target.value)}
          required
          type="datetime-local"
          value={end}
        />
      </label>
    </div>
  );
}

function AgendaEventContext({
  eventTimeWindow,
}: {
  eventTimeWindow: AgendaTimeWindow;
}) {
  return (
    <p className="agenda-event-context">
      Event{" "}
      {formatEventDateRange(eventTimeWindow.startsOn, eventTimeWindow.endsOn)} ·{" "}
      {eventTimeWindow.timezone}
    </p>
  );
}

type AgendaTimeWindow = {
  startsOn: string;
  endsOn: string;
  timezone: string;
  min: string;
  max: string;
  defaultStart: string;
  defaultEnd: string;
};

function agendaTimeWindow(event: {
  startsOn: string;
  endsOn: string;
  timezone: string;
}): AgendaTimeWindow {
  return {
    ...event,
    min: `${event.startsOn}T00:00`,
    max: `${event.endsOn}T23:59`,
    defaultStart: `${event.startsOn}T${defaultAgendaStartTime}`,
    defaultEnd: `${event.startsOn}T${defaultAgendaEndTime}`,
  };
}

function AgendaFilter({
  label,
  options,
  value,
  onChange,
  optionLabel = (option) => option,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  optionLabel?: (option: string) => string;
}) {
  return (
    <label className="agenda-public-filter">
      {label}
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function AgendaStatus({ label, detail }: { label: string; detail?: string }) {
  return (
    <main className="public-agenda agenda-status">
      <div className="eyebrow">OpenBoard agenda</div>
      <h1>{label}</h1>
      {detail && <p>{detail}</p>}
    </main>
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function effectiveFilter(
  requested: string | null,
  options: string[],
): string | null {
  return requested && options.includes(requested)
    ? requested
    : (options[0] ?? null);
}

function localDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function localWeekStart(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function formatWeek(value: string): string {
  return `Week of ${new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`))}`;
}

function formatAgendaTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(value));
}
