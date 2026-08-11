import { and, asc, desc, eq, inArray } from "drizzle-orm";

import {
  publishedScheduleSchema,
  type PublishedSchedule,
} from "../../shared/published-schedule";
import type { Database } from "../database/client";
import {
  agendaPublications,
  events,
  publishedAgendaItems,
  publishedAgendaSpeakers,
} from "../database/schema";

export async function findPublishedSchedule(
  database: Database,
  slug: string,
  origin: string,
): Promise<PublishedSchedule | undefined> {
  const [publication] = await database
    .select({
      id: agendaPublications.id,
      revision: agendaPublications.revision,
      eventName: agendaPublications.eventName,
      timezone: agendaPublications.timezone,
      startsOn: agendaPublications.startsOn,
      endsOn: agendaPublications.endsOn,
      publishedAt: agendaPublications.createdAt,
    })
    .from(agendaPublications)
    .innerJoin(events, eq(events.id, agendaPublications.eventId))
    .where(and(eq(events.slug, slug), eq(agendaPublications.finalized, true)))
    .orderBy(desc(agendaPublications.revision))
    .limit(1);
  if (!publication) return undefined;

  const items = await database
    .select({
      id: publishedAgendaItems.agendaItemId,
      snapshotId: publishedAgendaItems.id,
      kind: publishedAgendaItems.kind,
      title: publishedAgendaItems.title,
      abstract: publishedAgendaItems.abstract,
      format: publishedAgendaItems.format,
      trackId: publishedAgendaItems.trackId,
      trackName: publishedAgendaItems.trackName,
      trackPosition: publishedAgendaItems.trackPosition,
      roomId: publishedAgendaItems.roomId,
      roomName: publishedAgendaItems.roomName,
      roomPosition: publishedAgendaItems.roomPosition,
      startsAt: publishedAgendaItems.startsAt,
      endsAt: publishedAgendaItems.endsAt,
      calendarUid: publishedAgendaItems.calendarUid,
      calendarSequence: publishedAgendaItems.calendarSequence,
    })
    .from(publishedAgendaItems)
    .where(
      and(
        eq(publishedAgendaItems.publicationId, publication.id),
        eq(publishedAgendaItems.canceled, false),
      ),
    )
    .orderBy(
      asc(publishedAgendaItems.startsAt),
      asc(publishedAgendaItems.roomPosition),
      asc(publishedAgendaItems.title),
      asc(publishedAgendaItems.agendaItemId),
    );
  const speakers =
    items.length === 0
      ? []
      : await database
          .select({
            publishedAgendaItemId:
              publishedAgendaSpeakers.publishedAgendaItemId,
            id: publishedAgendaSpeakers.submissionSpeakerId,
            displayName: publishedAgendaSpeakers.displayName,
            bio: publishedAgendaSpeakers.bio,
            headshotUrl: publishedAgendaSpeakers.headshotUrl,
            position: publishedAgendaSpeakers.position,
          })
          .from(publishedAgendaSpeakers)
          .where(
            inArray(
              publishedAgendaSpeakers.publishedAgendaItemId,
              items.map((item) => item.snapshotId),
            ),
          )
          .orderBy(
            asc(publishedAgendaSpeakers.position),
            asc(publishedAgendaSpeakers.submissionSpeakerId),
          );

  const tracks = uniqueOptions(
    items.flatMap((item) =>
      item.trackId && item.trackName && item.trackPosition !== null
        ? [
            {
              id: item.trackId,
              name: item.trackName,
              position: item.trackPosition,
            },
          ]
        : [],
    ),
  );
  const rooms = uniqueOptions(
    items.flatMap((item) =>
      item.roomId && item.roomName && item.roomPosition !== null
        ? [
            {
              id: item.roomId,
              name: item.roomName,
              position: item.roomPosition,
            },
          ]
        : [],
    ),
  );
  return publishedScheduleSchema.parse({
    version: "1.0",
    revision: publication.revision,
    publishedAt: publication.publishedAt.toISOString(),
    event: {
      name: publication.eventName,
      slug,
      timezone: publication.timezone,
      startsOn: publication.startsOn,
      endsOn: publication.endsOn,
    },
    tracks,
    rooms,
    items: items.map((item) => {
      if (item.kind === "service") {
        return {
          id: item.id,
          kind: "service" as const,
          title: item.title,
          roomId: item.roomId,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
        };
      }
      return {
        id: item.id,
        kind: "session" as const,
        title: item.title,
        abstract: item.abstract ?? "",
        format: item.format ?? "",
        trackId: item.trackId ?? "",
        roomId: item.roomId ?? "",
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        calendar: {
          uid: item.calendarUid ?? `${item.id}@openboard`,
          sequence: item.calendarSequence ?? 0,
        },
        speakers: speakers
          .filter(
            (speaker) => speaker.publishedAgendaItemId === item.snapshotId,
          )
          .map((speaker) => ({
            id: speaker.id,
            displayName: speaker.displayName,
            bio: speaker.bio,
            headshotUrl: speaker.headshotUrl
              ? new URL(speaker.headshotUrl, origin).href
              : null,
            position: speaker.position,
          })),
      };
    }),
  });
}

type PublishedScheduleOption = { id: string; name: string; position: number };

function uniqueOptions(
  options: PublishedScheduleOption[],
): PublishedScheduleOption[] {
  return [
    ...new Map(options.map((option) => [option.id, option])).values(),
  ].sort(
    (left, right) =>
      left.position - right.position || left.id.localeCompare(right.id),
  );
}
