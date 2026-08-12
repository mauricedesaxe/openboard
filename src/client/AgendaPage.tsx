import { Draggable } from "@fullcalendar/interaction";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { AgendaCalendar, type AgendaCalendarItem } from "./AgendaCalendar";
import { MutationStatus } from "./MutationStatus";
import { addDays, clampVisibleStart } from "./agenda-calendar-model";
import { useTRPC } from "./trpc";

type WorkingAgenda = {
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

type WorkingItem = {
  id: string;
  kind: "program" | "service";
  title: string | null;
  serviceTitle: string | null;
  serviceScope: "event" | "room" | null;
  roomId: string | null;
  roomName: string | null;
  roomArchivedAt: Date | null;
  startsAtLocal: string;
  endsAtLocal: string;
  canceled: boolean;
  trackName: string | null;
  conflicts: Array<"room" | "speaker">;
  speakers: Array<{ displayName: string }>;
};

type UndoAction = { label: string; run: () => void };

export function AgendaPage() {
  const { slug = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const agenda = useQuery(trpc.agendas.working.queryOptions({ slug }));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [track, setTrack] = useState("");
  const [saveError, setSaveError] = useState<{
    itemId: string;
    message: string;
    retry: () => void;
    revert?: () => void;
  }>();
  const [undo, setUndo] = useState<UndoAction>();
  const refresh = () =>
    queryClient.invalidateQueries(trpc.agendas.working.queryFilter({ slug }));
  const placeProgram = useMutation(
    trpc.agendas.placeProgram.mutationOptions({
      onSuccess: () => void refresh(),
    }),
  );
  const placeService = useMutation(
    trpc.agendas.placeService.mutationOptions({
      onSuccess: () => void refresh(),
    }),
  );
  const move = useMutation(trpc.agendas.move.mutationOptions());
  const updateService = useMutation(
    trpc.agendas.updateService.mutationOptions(),
  );
  const cancel = useMutation(trpc.agendas.cancel.mutationOptions());
  const restore = useMutation(trpc.agendas.restore.mutationOptions());
  const unplace = useMutation(trpc.agendas.unplaceProgram.mutationOptions());
  const removeService = useMutation(
    trpc.agendas.removeService.mutationOptions(),
  );
  const publish = useMutation(
    trpc.agendas.publish.mutationOptions({
      onSuccess: () => void refresh(),
    }),
  );
  const pending =
    move.isPending ||
    updateService.isPending ||
    cancel.isPending ||
    restore.isPending ||
    unplace.isPending ||
    removeService.isPending;

  useEffect(() => {
    function warnBeforeLeave(event: BeforeUnloadEvent) {
      if (!pending) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [pending]);

  if (agenda.isPending) return <AgendaStatus label="Opening working agenda" />;
  if (agenda.isError) {
    return (
      <AgendaStatus
        label="Working agenda unavailable"
        detail={agenda.error.message}
      />
    );
  }

  const data = agenda.data as WorkingAgenda;
  const roomId = effectiveRoom(searchParams.get("room"), data.rooms);
  const selectedId = searchParams.get("item");
  const selected = data.items.find((item) => item.id === selectedId) ?? null;
  const visibleStart = clampVisibleStart(
    searchParams.get("start"),
    data.startsOn,
    data.endsOn,
  );
  const conflicts = data.items.filter(
    (item) => !item.canceled && item.conflicts.length > 0,
  ).length;
  const tracks = unique(data.unplacedProgramItems.map((item) => item.track));
  const paletteItems = data.unplacedProgramItems.filter(
    (item) =>
      (!track || item.track === track) &&
      item.title.toLowerCase().includes(search.toLowerCase()),
  );

  function updateUrl(values: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  }

  function saveMove(
    item: WorkingItem,
    startsAtLocal: string,
    endsAtLocal: string,
    room: string | null,
    revert?: () => void,
  ) {
    if (saveError?.itemId === item.id) return;
    const previous = {
      startsAtLocal: item.startsAtLocal,
      endsAtLocal: item.endsAtLocal,
      roomId: item.roomId,
    };
    const input = {
      slug,
      agendaItemId: item.id,
      roomId: room,
      startsAtLocal,
      endsAtLocal,
    };
    move.mutate(input, {
      onSuccess: () => {
        setSaveError(undefined);
        setUndo({
          label: "Move saved",
          run: () =>
            saveMove(
              item,
              previous.startsAtLocal,
              previous.endsAtLocal,
              previous.roomId,
            ),
        });
        void refresh();
      },
      onError: (error) => {
        revert?.();
        setSaveError({
          itemId: item.id,
          message: error.message,
          retry: () => saveMove(item, startsAtLocal, endsAtLocal, room, revert),
          ...(revert ? { revert } : {}),
        });
      },
    });
  }

  function createService(startsAtLocal: string, endsAtLocal: string) {
    placeService.mutate(
      {
        slug,
        title: "New service block",
        scope: roomId ? { type: "room", roomId } : { type: "event" },
        startsAtLocal,
        endsAtLocal,
      },
      {
        onSuccess: (created) => {
          updateUrl({ item: created.id });
          setUndo({
            label: "Service block added",
            run: () =>
              removeService.mutate(
                { slug, agendaItemId: created.id },
                { onSuccess: () => void refresh() },
              ),
          });
        },
      },
    );
  }

  function dropPaletteItem(
    paletteId: string,
    startsAtLocal: string,
    endsAtLocal: string,
  ) {
    if (paletteId === "new-service") {
      createService(startsAtLocal, endsAtLocal);
      return;
    }
    placeProgram.mutate(
      {
        slug,
        programItemId: paletteId,
        roomId: roomId || null,
        startsAtLocal,
        endsAtLocal,
      },
      { onSuccess: (created) => updateUrl({ item: created.id }) },
    );
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
      <header className="agenda-calendar-header">
        <div>
          <div className="eyebrow">
            Working agenda · revision {data.revision}
          </div>
          <h1>Shape the event.</h1>
          <p>{data.timezone}</p>
        </div>
        <div className="agenda-header-controls">
          <label>
            Room
            <select
              onChange={(event) =>
                updateUrl({ room: event.target.value || null })
              }
              value={roomId}
            >
              <option value="">All rooms</option>
              {data.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                  {room.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="agenda-range-controls">
            <button
              className="text-button"
              disabled={visibleStart === data.startsOn}
              onClick={() =>
                updateUrl({
                  start: maxDate(data.startsOn, addDays(visibleStart, -7)),
                })
              }
              type="button"
            >
              Previous
            </button>
            <button
              className="text-button"
              disabled={addDays(visibleStart, 7) > data.endsOn}
              onClick={() => updateUrl({ start: addDays(visibleStart, 7) })}
              type="button"
            >
              Next
            </button>
          </div>
          <button
            className="primary-button"
            disabled={publish.isPending || conflicts > 0}
            onClick={() =>
              publish.mutate({ slug, expectedRevision: data.revision })
            }
            type="button"
          >
            {publish.isPending ? "Publishing…" : "Publish agenda"}
          </button>
        </div>
      </header>
      <div className="agenda-publication-summary">
        <strong>{conflicts} conflicts</strong>
        <span>{data.unplacedProgramItems.length} unplaced</span>
        {conflicts > 0 && <span>Resolve conflicts before publication.</span>}
      </div>
      {(publish.error || placeProgram.error || placeService.error) && (
        <MutationStatus
          error={
            (publish.error ?? placeProgram.error ?? placeService.error)?.message
          }
        />
      )}
      {undo && (
        <div className="agenda-undo" role="status">
          <span>{undo.label}</span>
          <button className="text-button" onClick={undo.run} type="button">
            Undo
          </button>
          <button
            className="text-button"
            onClick={() => setUndo(undefined)}
            type="button"
          >
            Dismiss
          </button>
        </div>
      )}
      <button
        className="agenda-mobile-palette primary-button"
        onClick={() => setPaletteOpen(true)}
        type="button"
      >
        Add to agenda
      </button>
      <div className={`agenda-workspace${selected ? " has-inspector" : ""}`}>
        <AgendaPalette
          items={paletteItems}
          onClose={() => setPaletteOpen(false)}
          open={paletteOpen}
          search={search}
          setSearch={setSearch}
          setTrack={setTrack}
          track={track}
          tracks={tracks}
        />
        <AgendaCalendar
          editable
          endsOn={data.endsOn}
          items={data.items.map(toWorkingCalendarItem)}
          onCreateService={createService}
          onExternalDrop={dropPaletteItem}
          onMove={(id, start, end, revert) => {
            const item = data.items.find((candidate) => candidate.id === id);
            if (item) saveMove(item, start, end, item.roomId, revert);
          }}
          onSelect={(id) => {
            if (!pending) updateUrl({ item: id });
          }}
          onVisibleStartChange={(start) => updateUrl({ start })}
          roomId={roomId}
          selectedId={selectedId}
          startsOn={data.startsOn}
          timezone={data.timezone}
          view="calendar"
          visibleStart={visibleStart}
        />
        {selected && (
          <WorkingInspector
            busy={pending}
            {...(saveError?.itemId === selected.id ? { error: saveError } : {})}
            item={selected}
            onCancel={() => {
              const mutation = selected.canceled ? restore : cancel;
              mutation.mutate(
                { slug, agendaItemId: selected.id },
                {
                  onSuccess: () => {
                    setUndo({
                      label: selected.canceled
                        ? "Placement restored"
                        : "Placement canceled",
                      run: () =>
                        (selected.canceled ? cancel : restore).mutate(
                          { slug, agendaItemId: selected.id },
                          { onSuccess: () => void refresh() },
                        ),
                    });
                    void refresh();
                  },
                },
              );
            }}
            onClose={() => {
              if (!pending) updateUrl({ item: null });
            }}
            onMove={(start, end, room) => saveMove(selected, start, end, room)}
            onRemove={() => {
              const mutation =
                selected.kind === "program" ? unplace : removeService;
              mutation.mutate(
                { slug, agendaItemId: selected.id },
                {
                  onSuccess: () => {
                    updateUrl({ item: null });
                    void refresh();
                  },
                },
              );
            }}
            onUpdateService={(input) => {
              updateService.mutate(
                { slug, agendaItemId: selected.id, ...input },
                {
                  onSuccess: () => void refresh(),
                  onError: (error) =>
                    setSaveError({
                      itemId: selected.id,
                      message: error.message,
                      retry: () => undefined,
                    }),
                },
              );
            }}
            rooms={data.rooms}
          />
        )}
      </div>
    </div>
  );
}

function AgendaPalette({
  items,
  onClose,
  open,
  search,
  setSearch,
  setTrack,
  track,
  tracks,
}: {
  items: WorkingAgenda["unplacedProgramItems"];
  onClose: () => void;
  open: boolean;
  search: string;
  setSearch: (value: string) => void;
  setTrack: (value: string) => void;
  track: string;
  tracks: string[];
}) {
  const paletteRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!paletteRef.current) return;
    const draggable = new Draggable(paletteRef.current, {
      itemSelector: ".agenda-palette-item",
      eventData: (element) => ({
        title: element.getAttribute("data-title") ?? "Agenda item",
        duration: "01:00",
        extendedProps: { paletteId: element.getAttribute("data-palette-id") },
      }),
    });
    return () => draggable.destroy();
  }, []);
  return (
    <aside
      className={`agenda-palette${open ? " is-open" : ""}`}
      ref={paletteRef}
    >
      <div className="agenda-palette-heading">
        <div>
          <div className="eyebrow">Unplaced</div>
          <h2>{items.length ? "Ready to place" : "Agenda complete"}</h2>
        </div>
        <button className="text-button" onClick={onClose} type="button">
          Close
        </button>
      </div>
      <input
        aria-label="Search unplaced items"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search program"
        value={search}
      />
      <select
        aria-label="Filter unplaced items by track"
        onChange={(event) => setTrack(event.target.value)}
        value={track}
      >
        <option value="">All tracks</option>
        {tracks.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <button
        className="agenda-palette-item service-template"
        data-palette-id="new-service"
        data-title="New service block"
        type="button"
      >
        <strong>New service block</strong>
        <span>Drag or click an empty slot</span>
      </button>
      <div className="agenda-palette-items">
        {items.map((item) => (
          <button
            className="agenda-palette-item"
            data-palette-id={item.id}
            data-title={item.title}
            key={item.id}
            type="button"
          >
            <strong>{item.title}</strong>
            <span>
              {item.track} · {item.format}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function WorkingInspector({
  busy,
  error,
  item,
  onCancel,
  onClose,
  onMove,
  onRemove,
  onUpdateService,
  rooms,
}: {
  busy: boolean;
  error?: { message: string; retry: () => void; revert?: () => void };
  item: WorkingItem;
  onCancel: () => void;
  onClose: () => void;
  onMove: (start: string, end: string, room: string | null) => void;
  onRemove: () => void;
  onUpdateService: (input: {
    title: string;
    scope: { type: "event" } | { type: "room"; roomId: string };
    startsAtLocal: string;
    endsAtLocal: string;
  }) => void;
  rooms: WorkingAgenda["rooms"];
}) {
  const [title, setTitle] = useState(item.serviceTitle ?? "");
  const [scope, setScope] = useState<"event" | "room">(
    item.serviceScope ?? "room",
  );
  const [roomId, setRoomId] = useState(item.roomId ?? "");
  const [start, setStart] = useState(item.startsAtLocal);
  const [end, setEnd] = useState(item.endsAtLocal);
  function saveService() {
    if (item.kind !== "service" || !title.trim()) return;
    if (scope === "room" && !roomId) return;
    onUpdateService({
      title,
      scope: scope === "event" ? { type: "event" } : { type: "room", roomId },
      startsAtLocal: start,
      endsAtLocal: end,
    });
  }
  const saveServiceAfterDelay = useEffectEvent(saveService);
  useEffect(() => {
    if (item.kind !== "service" || title === item.serviceTitle) return;
    const timer = window.setTimeout(saveServiceAfterDelay, 500);
    return () => window.clearTimeout(timer);
  }, [item.kind, item.serviceTitle, title]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (item.kind === "service") saveService();
    else onMove(start, end, roomId || null);
  }

  return (
    <aside className="agenda-inspector">
      <div className="agenda-inspector-heading">
        <div>
          <div className="eyebrow">{item.kind} details</div>
          <h2>{item.kind === "program" ? item.title : title}</h2>
        </div>
        <button
          className="text-button"
          disabled={busy}
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
      <form onSubmit={submit}>
        {item.kind === "service" && (
          <>
            <label>
              Title
              <input
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </label>
            <label>
              Scope
              <select
                onChange={(event) =>
                  setScope(event.target.value as "event" | "room")
                }
                value={scope}
              >
                <option value="event">All rooms</option>
                <option value="room">One room</option>
              </select>
            </label>
          </>
        )}
        {(item.kind === "program" || scope === "room") && (
          <label>
            Room
            <select
              onChange={(event) => setRoomId(event.target.value)}
              value={roomId}
            >
              <option value="">Unassigned</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                  {room.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Starts
          <input
            onChange={(event) => setStart(event.target.value)}
            step={900}
            type="datetime-local"
            value={start}
          />
        </label>
        <label>
          Ends
          <input
            onChange={(event) => setEnd(event.target.value)}
            step={900}
            type="datetime-local"
            value={end}
          />
        </label>
        {item.conflicts.length > 0 && (
          <p className="form-error">{item.conflicts.join(" and ")} conflict</p>
        )}
        {item.roomArchivedAt && (
          <p className="form-error">
            This placement references an archived room.
          </p>
        )}
        {error && (
          <div className="agenda-save-error" role="alert">
            <p>{error.message}</p>
            <button className="text-button" onClick={error.retry} type="button">
              Retry
            </button>
            {error.revert && (
              <button
                className="text-button"
                onClick={error.revert}
                type="button"
              >
                Revert
              </button>
            )}
          </div>
        )}
        <button
          className="secondary-button"
          disabled={busy || Boolean(error)}
          type="submit"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </form>
      <div className="agenda-inspector-actions">
        {item.kind === "program" && (
          <button
            className="text-button"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {item.canceled ? "Restore placement" : "Cancel placement"}
          </button>
        )}
        <button
          className="text-button destructive-button"
          disabled={busy}
          onClick={onRemove}
          type="button"
        >
          {item.kind === "program"
            ? "Return to unplaced"
            : "Delete service block"}
        </button>
      </div>
    </aside>
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
  if (agenda.isError)
    return (
      <AgendaStatus
        label="Agenda not published"
        detail={agenda.error.message}
      />
    );
  const data = agenda.data;
  const view = searchParams.get("view") === "list" ? "list" : "calendar";
  const selectedId = searchParams.get("item");
  const selected = data.items.find((item) => item.id === selectedId) ?? null;
  const rooms = unique(
    data.items.flatMap((item) =>
      item.roomId && item.roomName
        ? [{ id: item.roomId, name: item.roomName }]
        : [],
    ),
    (room) => room.id,
  );
  const roomId = rooms.some((room) => room.id === searchParams.get("room"))
    ? (searchParams.get("room") ?? "")
    : "";
  const visibleStart = clampVisibleStart(
    searchParams.get("start"),
    data.event.startsOn,
    data.event.endsOn,
  );
  function updateUrl(values: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  }
  return (
    <main className="public-agenda">
      <header className="public-agenda-header">
        <Link className="wordmark" to="/">
          <span className="wordmark-mark">OB</span>
          <span>{data.event.name}</span>
        </Link>
        <div>
          <div className="eyebrow">
            Published agenda · revision {data.revision}
          </div>
          <h1>Where to be next.</h1>
          <p>{data.event.timezone}</p>
        </div>
      </header>
      <div className="public-agenda-controls">
        <nav className="agenda-view-tabs" aria-label="Agenda views">
          {(["calendar", "list"] as const).map((candidate) => (
            <button
              aria-pressed={view === candidate}
              key={candidate}
              onClick={() => updateUrl({ view: candidate })}
              type="button"
            >
              {candidate}
            </button>
          ))}
        </nav>
        <label>
          Room
          <select
            onChange={(event) =>
              updateUrl({ room: event.target.value || null })
            }
            value={roomId}
          >
            <option value="">All rooms</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className={`public-agenda-workspace${selected ? " has-inspector" : ""}`}
      >
        <AgendaCalendar
          editable={false}
          endsOn={data.event.endsOn}
          items={data.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            roomId: item.roomId,
            roomName: item.roomName,
            startsAt: item.startsAt,
            endsAt: item.endsAt,
            trackName: item.trackName,
            speakers: item.speakers,
          }))}
          onSelect={(id) => updateUrl({ item: id })}
          onVisibleStartChange={(start) => updateUrl({ start })}
          roomId={roomId}
          selectedId={selectedId}
          startsOn={data.event.startsOn}
          timezone={data.event.timezone}
          view={view}
          visibleStart={visibleStart}
        />
        {selected && (
          <aside className="agenda-inspector public-agenda-inspector">
            <button
              className="text-button"
              onClick={() => updateUrl({ item: null })}
              type="button"
            >
              Close
            </button>
            <div className="eyebrow">
              {selected.roomName ?? "All rooms"}
              {selected.trackName ? ` · ${selected.trackName}` : ""}
            </div>
            <h2>{selected.title}</h2>
            <p>
              {formatAgendaRange(
                selected.startsAt,
                selected.endsAt,
                data.event.timezone,
              )}
            </p>
            {selected.speakers.length > 0 && (
              <p>
                {selected.speakers
                  .map((speaker) => speaker.displayName)
                  .join(", ")}
              </p>
            )}
            {selected.abstract && (
              <p className="agenda-abstract">{selected.abstract}</p>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}

function toWorkingCalendarItem(item: WorkingItem): AgendaCalendarItem {
  return {
    id: item.id,
    kind: item.kind,
    title:
      item.kind === "program"
        ? (item.title ?? "Untitled program item")
        : (item.serviceTitle ?? "New service block"),
    roomId: item.roomId,
    roomName: item.roomName,
    startsAt: item.startsAtLocal,
    endsAt: item.endsAtLocal,
    trackName: item.trackName,
    speakers: item.speakers,
    canceled: item.canceled,
    conflicts: item.conflicts,
  };
}

function effectiveRoom(
  requested: string | null,
  rooms: WorkingAgenda["rooms"],
): string {
  return requested && rooms.some((room) => room.id === requested)
    ? requested
    : "";
}

function unique<T>(
  values: T[],
  key: (value: T) => string = (value) => String(value),
): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function maxDate(left: string, right: string): string {
  return left > right ? left : right;
}

function formatAgendaRange(
  start: string,
  end: string,
  timezone: string,
): string {
  const formatter = new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  return `${formatter.format(new Date(start))} – ${formatter.format(new Date(end))}`;
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
