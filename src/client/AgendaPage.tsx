import { Draggable } from "@fullcalendar/interaction";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import {
  invalidAgendaTimeRangeMessage,
  isValidAgendaTimeRange,
} from "../shared/agendas";

import { AgendaCalendar, type AgendaCalendarItem } from "./AgendaCalendar";
import { MutationStatus } from "./MutationStatus";
import {
  addDays,
  clampVisibleStart,
  derivePublicVisibleHours,
  moveItemInAgenda,
  placeProgramInAgenda,
  placeServiceInAgenda,
  removeItemFromAgenda,
  replaceAgendaItemId,
  setCanceledInAgenda,
  unplaceProgramInAgenda,
  updateServiceInAgenda,
  type WorkingAgenda,
  type WorkingItem,
} from "./agenda-calendar-model";
import { useTRPC } from "./trpc";

type UndoAction = { label: string; run: () => void };

type ServiceBlockDraft = {
  title: string;
  scope: { type: "event" } | { type: "room"; roomId: string };
  startsAtLocal: string;
  endsAtLocal: string;
};

export function AgendaPage() {
  const { slug = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const workingQuery = trpc.agendas.working.queryOptions({ slug });
  const workingFilter = trpc.agendas.working.queryFilter({ slug });
  const publicationStatusQuery = trpc.agendas.publicationStatus.queryOptions(
    { slug },
    { retry: false, refetchOnWindowFocus: false },
  );
  const publicationStatusFilter = trpc.agendas.publicationStatus.queryFilter({
    slug,
  });
  const agenda = useQuery(workingQuery);
  const publicationStatus = useQuery(publicationStatusQuery);
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
  const refresh = () => queryClient.invalidateQueries(workingFilter);
  const placeProgram = useMutation(trpc.agendas.placeProgram.mutationOptions());
  const placeService = useMutation(trpc.agendas.placeService.mutationOptions());
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
      onSuccess: () => {
        void refresh();
        void queryClient.invalidateQueries(publicationStatusFilter);
      },
    }),
  );
  const pending =
    placeProgram.isPending ||
    placeService.isPending ||
    move.isPending ||
    updateService.isPending ||
    cancel.isPending ||
    restore.isPending ||
    unplace.isPending ||
    removeService.isPending;
  const blockedItemId = saveError?.itemId;

  async function updateWorkingAgenda(
    update: (current: WorkingAgenda) => WorkingAgenda,
  ): Promise<WorkingAgenda | undefined> {
    await queryClient.cancelQueries(workingFilter);
    const previous = queryClient.getQueryData<WorkingAgenda>(
      workingQuery.queryKey,
    );
    queryClient.setQueryData(workingQuery.queryKey, (current) =>
      current ? (update(current) as typeof current) : current,
    );
    return previous;
  }

  function restoreWorkingAgenda(previous: WorkingAgenda | undefined) {
    if (previous) {
      queryClient.setQueryData(workingQuery.queryKey, previous as never);
    }
  }

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

  async function saveMove(
    item: WorkingItem,
    startsAtLocal: string,
    endsAtLocal: string,
    room: string | null,
    revert?: () => void,
    recordUndo = true,
    onSaved?: (revision: number) => void,
  ) {
    if (saveError?.itemId === item.id) setSaveError(undefined);
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
    const previousAgenda = await updateWorkingAgenda((current) =>
      moveItemInAgenda(current, input),
    );
    move.mutate(input, {
      onSuccess: (saved) => {
        setSaveError(undefined);
        onSaved?.(saved.revision);
        if (recordUndo) {
          setUndo({
            label: "Move saved",
            run: () =>
              void saveMove(
                item,
                previous.startsAtLocal,
                previous.endsAtLocal,
                previous.roomId,
                undefined,
                false,
                onSaved,
              ),
          });
        }
      },
      onError: (error) => {
        restoreWorkingAgenda(previousAgenda);
        revert?.();
        setSaveError({
          itemId: item.id,
          message: error.message,
          retry: () => {
            setSaveError(undefined);
            void saveMove(
              item,
              startsAtLocal,
              endsAtLocal,
              room,
              revert,
              recordUndo,
              onSaved,
            );
          },
          ...(revert
            ? {
                revert: () => {
                  revert();
                  setSaveError(undefined);
                },
              }
            : {}),
        });
      },
      onSettled: () => void refresh(),
    });
  }

  async function createService(
    startsAtLocal: string,
    endsAtLocal: string,
    recordUndo = true,
  ) {
    const temporaryId = `optimistic:${crypto.randomUUID()}`;
    const input = {
      slug,
      title: "New service block",
      scope: roomId
        ? ({ type: "room", roomId } as const)
        : ({ type: "event" } as const),
      startsAtLocal,
      endsAtLocal,
    };
    const previousAgenda = await updateWorkingAgenda((current) =>
      placeServiceInAgenda(current, { ...input, temporaryId }),
    );
    placeService.mutate(input, {
      onSuccess: (created) => {
        queryClient.setQueryData<WorkingAgenda>(
          workingQuery.queryKey,
          (current) =>
            current
              ? replaceAgendaItemId(current, temporaryId, created.id)
              : current,
        );
        updateUrl({ item: created.id });
        if (recordUndo) {
          setUndo({
            label: "Service block added",
            run: () => void removeAgendaItem(created.id, "service", false),
          });
        }
      },
      onError: () => restoreWorkingAgenda(previousAgenda),
      onSettled: () => void refresh(),
    });
  }

  async function saveService(
    item: WorkingItem,
    input: ServiceBlockDraft,
    expectedRevision: number,
    onSaved: (revision: number) => void,
  ) {
    if (saveError?.itemId === item.id) setSaveError(undefined);
    const mutationInput = {
      slug,
      agendaItemId: item.id,
      expectedRevision,
      ...input,
    };
    const previousAgenda = await updateWorkingAgenda((current) =>
      updateServiceInAgenda(current, mutationInput),
    );
    updateService.mutate(mutationInput, {
      onSuccess: (saved) => {
        setSaveError(undefined);
        onSaved(saved.revision);
      },
      onError: (error) => {
        restoreWorkingAgenda(previousAgenda);
        setSaveError({
          itemId: item.id,
          message: error.message,
          retry: () => {
            const freshRevision =
              queryClient
                .getQueryData<WorkingAgenda>(workingQuery.queryKey)
                ?.items.find((candidate) => candidate.id === item.id)
                ?.revision ?? expectedRevision;
            void saveService(item, input, freshRevision, onSaved);
          },
        });
      },
      onSettled: () => void refresh(),
    });
  }

  async function dropPaletteItem(
    paletteId: string,
    startsAtLocal: string,
    endsAtLocal: string,
    placementRoomId: string | null = roomId || null,
    recordUndo = true,
  ) {
    if (paletteId === "new-service") {
      await createService(startsAtLocal, endsAtLocal, recordUndo);
      return;
    }
    const temporaryId = `optimistic:${crypto.randomUUID()}`;
    const input = {
      slug,
      programItemId: paletteId,
      roomId: placementRoomId,
      startsAtLocal,
      endsAtLocal,
    };
    const previousAgenda = await updateWorkingAgenda((current) =>
      placeProgramInAgenda(current, { ...input, temporaryId }),
    );
    placeProgram.mutate(input, {
      onSuccess: (created) => {
        queryClient.setQueryData<WorkingAgenda>(
          workingQuery.queryKey,
          (current) =>
            current
              ? replaceAgendaItemId(current, temporaryId, created.id)
              : current,
        );
        updateUrl({ item: created.id });
        if (recordUndo) {
          setUndo({
            label: "Program item placed",
            run: () => void removeAgendaItem(created.id, "program", false),
          });
        }
      },
      onError: () => restoreWorkingAgenda(previousAgenda),
      onSettled: () => void refresh(),
    });
  }

  async function setPlacementCanceled(item: WorkingItem, recordUndo = true) {
    const mutation = item.canceled ? restore : cancel;
    const previousAgenda = await updateWorkingAgenda((current) =>
      setCanceledInAgenda(current, item.id, !item.canceled),
    );
    mutation.mutate(
      { slug, agendaItemId: item.id },
      {
        onSuccess: () => {
          if (recordUndo) {
            setUndo({
              label: item.canceled
                ? "Placement restored"
                : "Placement canceled",
              run: () =>
                void setPlacementCanceled(
                  { ...item, canceled: !item.canceled },
                  false,
                ),
            });
          }
        },
        onError: () => restoreWorkingAgenda(previousAgenda),
        onSettled: () => void refresh(),
      },
    );
  }

  async function removeAgendaItem(
    itemId: string,
    kind: "program" | "service",
    recordUndo = true,
  ) {
    const current = queryClient
      .getQueryData<WorkingAgenda>(workingQuery.queryKey)
      ?.items.find((item) => item.id === itemId);
    if (!current) return;
    const previousAgenda = await updateWorkingAgenda((agendaData) =>
      kind === "program"
        ? unplaceProgramInAgenda(agendaData, itemId)
        : removeItemFromAgenda(agendaData, itemId),
    );
    const mutation = kind === "program" ? unplace : removeService;
    mutation.mutate(
      { slug, agendaItemId: itemId },
      {
        onSuccess: () => {
          updateUrl({ item: null });
          if (recordUndo) {
            setUndo({
              label:
                kind === "program"
                  ? "Program item returned to unplaced"
                  : "Service block deleted",
              run: () => void restoreRemovedItem(current),
            });
          }
        },
        onError: () => restoreWorkingAgenda(previousAgenda),
        onSettled: () => void refresh(),
      },
    );
  }

  async function restoreRemovedItem(item: WorkingItem) {
    if (item.kind === "program" && item.programItemId) {
      await dropPaletteItem(
        item.programItemId,
        item.startsAtLocal,
        item.endsAtLocal,
        item.roomId,
        false,
      );
      return;
    }
    const scope =
      item.serviceScope === "room" && item.roomId
        ? ({ type: "room", roomId: item.roomId } as const)
        : ({ type: "event" } as const);
    const temporaryId = `optimistic:${crypto.randomUUID()}`;
    const input = {
      slug,
      title: item.serviceTitle ?? "New service block",
      scope,
      startsAtLocal: item.startsAtLocal,
      endsAtLocal: item.endsAtLocal,
    };
    const previousAgenda = await updateWorkingAgenda((current) =>
      placeServiceInAgenda(current, { ...input, temporaryId }),
    );
    placeService.mutate(input, {
      onSuccess: (created) =>
        queryClient.setQueryData<WorkingAgenda>(
          workingQuery.queryKey,
          (current) =>
            current
              ? replaceAgendaItemId(current, temporaryId, created.id)
              : current,
        ),
      onError: () => restoreWorkingAgenda(previousAgenda),
      onSettled: () => void refresh(),
    });
  }

  function runUndo() {
    const action = undo;
    if (!action) return;
    setUndo(undefined);
    action.run();
  }

  function placePaletteItem(paletteId: string) {
    const start = `${visibleStart}T09:00`;
    void dropPaletteItem(paletteId, start, addLocalMinutes(start, 60));
    setPaletteOpen(false);
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
            disabled={pending || publish.isPending || conflicts > 0}
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
      {publicationStatus.isSuccess && publicationStatus.data && (
        <AgendaShare slug={slug} revision={publicationStatus.data.revision} />
      )}
      {publicationStatus.isError && (
        <AgendaShareUnavailable
          onRetry={() => void publicationStatus.refetch()}
        />
      )}
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
          <button className="text-button" onClick={runUndo} type="button">
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
        onClick={() => {
          updateUrl({ item: null });
          setPaletteOpen(true);
        }}
        type="button"
      >
        Add to agenda
      </button>
      <div className={`agenda-workspace${selected ? " has-inspector" : ""}`}>
        <AgendaPalette
          items={paletteItems}
          onClose={() => setPaletteOpen(false)}
          onPlace={placePaletteItem}
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
            if (item) void saveMove(item, start, end, item.roomId, revert);
          }}
          onSelect={(id) => {
            if (!pending && !blockedItemId) {
              setPaletteOpen(false);
              updateUrl({ item: id });
            }
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
            key={selected.id}
            blocked={Boolean(saveError?.itemId === selected.id)}
            busy={pending}
            {...(saveError?.itemId === selected.id ? { error: saveError } : {})}
            item={selected}
            onCancel={() => void setPlacementCanceled(selected)}
            onClose={() => {
              if (!pending) updateUrl({ item: null });
            }}
            onMove={(start, end, room, onSaved) =>
              void saveMove(
                selected,
                start,
                end,
                room,
                undefined,
                true,
                onSaved,
              )
            }
            onRemove={() => void removeAgendaItem(selected.id, selected.kind)}
            onUpdateService={(input, expectedRevision, onSaved) =>
              void saveService(selected, input, expectedRevision, onSaved)
            }
            rooms={data.rooms}
          />
        )}
      </div>
    </div>
  );
}

type ShareOutput = "agenda" | "json" | "calendar";

function AgendaShareUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="agenda-share" aria-labelledby="agenda-share-title">
      <div className="agenda-share-heading">
        <div>
          <div className="eyebrow">Published outputs unavailable</div>
          <h2 id="agenda-share-title">Share</h2>
        </div>
        <p>Published links could not be loaded.</p>
      </div>
      <div className="agenda-share-unavailable">
        <span role="status">Share is unavailable. Try again.</span>
        <button className="text-button" onClick={onRetry} type="button">
          Retry Share
        </button>
      </div>
    </section>
  );
}

function AgendaShare({ slug, revision }: { slug: string; revision: number }) {
  const [copyResult, setCopyResult] = useState<{
    output: ShareOutput;
    status: "success" | "error";
  }>();
  const origin = window.location.origin;
  const outputs: Array<{ output: ShareOutput; label: string; url: string }> = [
    {
      output: "agenda",
      label: "Public agenda",
      url: `${origin}/events/${slug}/schedule`,
    },
    {
      output: "json",
      label: "Schedule JSON",
      url: `${origin}/api/v1/events/${slug}/schedule`,
    },
    {
      output: "calendar",
      label: "iCalendar feed",
      url: `${origin}/api/v1/events/${slug}/schedule.ics`,
    },
  ];

  async function copy(output: ShareOutput, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyResult({ output, status: "success" });
    } catch {
      setCopyResult({ output, status: "error" });
    }
  }

  return (
    <section className="agenda-share" aria-labelledby="agenda-share-title">
      <div className="agenda-share-heading">
        <div>
          <div className="eyebrow">Published revision {revision}</div>
          <h2 id="agenda-share-title">Share</h2>
        </div>
        <p>Use or copy any published output.</p>
      </div>
      <div className="agenda-share-outputs">
        {outputs.map(({ output, label, url }) => {
          const result =
            copyResult?.output === output ? copyResult.status : null;
          return (
            <div className="agenda-share-output" key={output}>
              <strong>{label}</strong>
              <a href={url}>{url}</a>
              <div className="agenda-share-action">
                <button
                  aria-label={`Copy ${label} URL`}
                  className="text-button"
                  onClick={() => void copy(output, url)}
                  type="button"
                >
                  Copy
                </button>
                {result && (
                  <span
                    className={result === "error" ? "form-error" : undefined}
                    role="status"
                  >
                    {result === "success"
                      ? "Copied"
                      : "Copy failed. Use the link directly."}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AgendaPalette({
  items,
  onClose,
  onPlace,
  open,
  search,
  setSearch,
  setTrack,
  track,
  tracks,
}: {
  items: WorkingAgenda["unplacedProgramItems"];
  onClose: () => void;
  onPlace: (paletteId: string) => void;
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
        onClick={() => onPlace("new-service")}
        type="button"
      >
        <strong>New service block</strong>
        <span>Drag, or press Enter to place at 09:00</span>
      </button>
      <div className="agenda-palette-items">
        {items.map((item) => (
          <button
            className="agenda-palette-item"
            data-palette-id={item.id}
            data-title={item.title}
            key={item.id}
            onClick={() => onPlace(item.id)}
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
  blocked,
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
  blocked: boolean;
  busy: boolean;
  error?: { message: string; retry: () => void; revert?: () => void };
  item: WorkingItem;
  onCancel: () => void;
  onClose: () => void;
  onMove: (
    start: string,
    end: string,
    room: string | null,
    onSaved: (revision: number) => void,
  ) => void;
  onRemove: () => void;
  onUpdateService: (
    input: ServiceBlockDraft,
    expectedRevision: number,
    onSaved: (revision: number) => void,
  ) => void;
  rooms: WorkingAgenda["rooms"];
}) {
  const [title, setTitle] = useState(item.serviceTitle ?? "");
  const [scope, setScope] = useState<"event" | "room">(
    item.serviceScope ?? "room",
  );
  const [roomId, setRoomId] = useState(item.roomId ?? "");
  const [start, setStart] = useState(item.startsAtLocal);
  const [end, setEnd] = useState(item.endsAtLocal);
  const [revision, setRevision] = useState(item.revision);
  const dirty = useRef({
    title: false,
    scope: false,
    room: false,
    time: false,
  });
  const syncedItem = useRef(item);
  useEffect(() => {
    if (item === syncedItem.current) return;
    syncedItem.current = item;
    if (!dirty.current.title) setTitle(item.serviceTitle ?? "");
    if (!dirty.current.scope) setScope(item.serviceScope ?? "room");
    if (!dirty.current.room) setRoomId(item.roomId ?? "");
    if (!dirty.current.time) {
      setStart(item.startsAtLocal);
      setEnd(item.endsAtLocal);
    }
    setRevision(item.revision);
  }, [item]);
  function savedRevision(value: number) {
    dirty.current = { title: false, scope: false, room: false, time: false };
    setRevision(value);
  }
  const timeRangeValid = isValidAgendaTimeRange({
    startsAtLocal: start,
    endsAtLocal: end,
  });
  function saveService(overrides: Partial<ServiceBlockDraft> = {}) {
    if (item.kind !== "service" || !title.trim()) return;
    const draftScope =
      overrides.scope ??
      (scope === "event"
        ? { type: "event" as const }
        : { type: "room" as const, roomId });
    if (draftScope.type === "room" && !draftScope.roomId) return;
    const draft = {
      title: overrides.title ?? title,
      scope: draftScope,
      startsAtLocal: overrides.startsAtLocal ?? start,
      endsAtLocal: overrides.endsAtLocal ?? end,
    };
    if (!isValidAgendaTimeRange(draft)) return;
    onUpdateService(draft, revision, savedRevision);
  }
  function saveDraft() {
    if (!timeRangeValid) return;
    if (item.kind === "service") saveService();
    else onMove(start, end, roomId || null, savedRevision);
  }
  const saveDraftAfterDelay = useEffectEvent(saveDraft);
  useEffect(() => {
    const scopeChanged = item.kind === "service" && scope !== item.serviceScope;
    const roomChanged = roomId !== (item.roomId ?? "");
    const titleChanged = item.kind === "service" && title !== item.serviceTitle;
    const timeChanged =
      start !== item.startsAtLocal || end !== item.endsAtLocal;
    if (
      blocked ||
      (!scopeChanged && !roomChanged && !titleChanged && !timeChanged)
    ) {
      return;
    }
    const timer = window.setTimeout(saveDraftAfterDelay, 300);
    return () => window.clearTimeout(timer);
  }, [blocked, end, item, roomId, scope, start, title]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!timeRangeValid) return;
    if (item.kind === "service") saveService();
    else onMove(start, end, roomId || null, savedRevision);
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
                disabled={busy}
                maxLength={160}
                onChange={(event) => {
                  dirty.current.title = true;
                  setTitle(event.target.value);
                }}
                value={title}
              />
            </label>
            <label>
              Scope
              <select
                disabled={busy}
                onChange={(event) => {
                  const nextScope = event.target.value as "event" | "room";
                  dirty.current.scope = true;
                  setScope(nextScope);
                }}
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
              disabled={busy}
              onChange={(event) => {
                dirty.current.room = true;
                setRoomId(event.target.value);
              }}
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
            disabled={busy}
            onChange={(event) => {
              dirty.current.time = true;
              setStart(event.target.value);
            }}
            step={900}
            type="datetime-local"
            value={start}
          />
        </label>
        {!timeRangeValid && (
          <p className="form-error" role="alert">
            {invalidAgendaTimeRangeMessage}
          </p>
        )}
        <label>
          Ends
          <input
            disabled={busy}
            onChange={(event) => {
              dirty.current.time = true;
              setEnd(event.target.value);
            }}
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
          disabled={busy || Boolean(error) || !timeRangeValid}
          type="submit"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </form>
      <div className="agenda-inspector-actions">
        {item.kind === "program" && (
          <div>
            <p>
              {item.canceled
                ? "Restore this placement to the next published agenda."
                : "Cancellation keeps this placement and its calendar history."}
            </p>
            <button
              className={`text-button${item.canceled ? "" : " destructive-button"}`}
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              {item.canceled ? "Restore placement" : "Cancel placement"}
            </button>
          </div>
        )}
        {item.kind === "program" && (
          <p>Return this program item to the unplaced palette.</p>
        )}
        <button
          className={`text-button${item.kind === "service" ? " destructive-button" : ""}`}
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
  const visibleHours = derivePublicVisibleHours(
    data.items,
    data.event.timezone,
  );
  function updateUrl(values: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next);
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
          slotMaxTime={visibleHours.slotMaxTime}
          slotMinTime={visibleHours.slotMinTime}
          startsOn={data.event.startsOn}
          scrollTime={visibleHours.scrollTime}
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

function addLocalMinutes(value: string, minutes: number): string {
  const date = new Date(`${value}:00Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 16);
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
