import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { createDatabase } from "../src/server/database/client";
import { processAgendaDeliveryWork } from "../src/server/published-schedule/delivery";
import { saveOwnSpeakerProfile } from "../src/server/speaker-profiles/repository";
import type { UserId } from "../src/shared/events";

import {
  callTrpc,
  getResult,
  signIn,
  testEnvironment,
  workerFetch,
} from "./support";

const idSchema = z.object({ id: z.string() });
const workingAgendaSchema = z.object({
  revision: z.number(),
  rooms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      archived: z.boolean(),
    }),
  ),
  unplacedProgramItems: z.array(
    z.object({ id: z.string(), title: z.string() }),
  ),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["program", "service"]),
      title: z.string().nullable(),
      serviceTitle: z.string().nullable(),
      canceled: z.boolean(),
      roomName: z.string().nullable(),
      revision: z.number(),
      conflicts: z.array(z.enum(["room", "speaker"])),
    }),
  ),
});
const publishedAgendaSchema = z.object({
  revision: z.number(),
  event: z.object({ name: z.string(), timezone: z.string() }),
  items: z.array(
    z.object({
      agendaItemId: z.string(),
      title: z.string(),
      roomName: z.string().nullable(),
      startsAt: z.string(),
      speakers: z.array(
        z.object({
          displayName: z.string(),
          headshotUrl: z.string().nullable(),
        }),
      ),
    }),
  ),
});
const publicationStatusSchema = z
  .object({ revision: z.number(), publishedAt: z.string() })
  .nullable();

describe("build and publish an agenda", () => {
  test("corrects conflicts and publishes immutable public revisions", async () => {
    const slug = "agenda-flow-2027";
    const owner = await signIn("agenda-owner@example.com");
    const organizer = await signIn("agenda-organizer@example.com");
    const additiveOrganizer = await signIn(
      "agenda-additive-organizer@example.com",
    );
    const outsider = await signIn("agenda-outsider@example.com");
    const sharedSpeaker = await signIn("agenda-speaker@example.com");
    const otherSpeaker = await signIn("agenda-speaker-two@example.com");

    await expectOk(
      "events.create",
      {
        name: "OpenBoard Live",
        slug,
        startsOn: "2027-10-30",
        endsOn: "2027-11-01",
        timezone: "Europe/Berlin",
      },
      owner.cookie,
    );
    await expectOk(
      "communications.updateTemplate",
      {
        slug,
        purpose: "agenda_invitation",
        subject: "Calendar: {{sessionTitle}}",
        body: "Hello {{recipientName}}, {{sessionTitle}} is at {{eventName}}.",
        expectedRevision: 1,
      },
      owner.cookie,
    );
    const engineering = getResult(
      (
        await callTrpc(
          "tracks.create",
          { slug, name: "Engineering" },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const mainRoom = getResult(
      (
        await callTrpc(
          "rooms.create",
          { slug, name: "Main hall" },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const studio = getResult(
      (await callTrpc("rooms.create", { slug, name: "Studio" }, owner.cookie))
        .body,
      idSchema,
    );
    const program = await seedAcceptedProgram(
      slug,
      engineering.id,
      owner.userId,
      sharedSpeaker.userId,
      otherSpeaker.userId,
    );
    await testEnvironment.DB.prepare(
      "INSERT INTO event_roles (id, event_id, user_id, role, granted_by_user_id, created_at) SELECT ?, id, ?, 'organizer', ?, ? FROM events WHERE slug = ?",
    )
      .bind(
        crypto.randomUUID(),
        organizer.userId,
        owner.userId,
        Date.now(),
        slug,
      )
      .run();
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "INSERT INTO event_roles (id, event_id, user_id, role, granted_by_user_id, created_at) SELECT ?, id, ?, 'reviewer', ?, ? FROM events WHERE slug = ?",
      ).bind(
        crypto.randomUUID(),
        additiveOrganizer.userId,
        owner.userId,
        Date.now(),
        slug,
      ),
      testEnvironment.DB.prepare(
        "INSERT INTO event_roles (id, event_id, user_id, role, granted_by_user_id, created_at) SELECT ?, id, ?, 'organizer', ?, ? FROM events WHERE slug = ?",
      ).bind(
        crypto.randomUUID(),
        additiveOrganizer.userId,
        owner.userId,
        Date.now(),
        slug,
      ),
    ]);

    expect(
      (await callTrpc("agendas.working", { slug }, outsider.cookie, "query"))
        .status,
    ).toBe(404);
    expect(
      (await callTrpc("agendas.working", { slug }, organizer.cookie, "query"))
        .status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "agendas.working",
          { slug },
          additiveOrganizer.cookie,
          "query",
        )
      ).status,
    ).toBe(200);
    expect(
      (await callTrpc("agendas.published", { slug }, undefined, "query"))
        .status,
    ).toBe(404);
    expect(
      getResult(
        (
          await callTrpc(
            "agendas.publicationStatus",
            { slug },
            owner.cookie,
            "query",
          )
        ).body,
        publicationStatusSchema,
      ),
    ).toBeNull();
    expect(
      (
        await callTrpc(
          "agendas.publicationStatus",
          { slug },
          outsider.cookie,
          "query",
        )
      ).status,
    ).toBe(404);

    const firstPlacement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: program.first,
            roomId: mainRoom.id,
            startsAtLocal: "2027-10-30T09:00",
            endsAtLocal: "2027-10-30T10:00",
          },
          organizer.cookie,
        )
      ).body,
      idSchema,
    );
    const secondPlacement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: program.second,
            roomId: studio.id,
            startsAtLocal: "2027-10-30T09:30",
            endsAtLocal: "2027-10-30T10:30",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const duplicatePlacement = await callTrpc(
      "agendas.placeProgram",
      {
        slug,
        programItemId: program.first,
        roomId: studio.id,
        startsAtLocal: "2027-10-30T11:00",
        endsAtLocal: "2027-10-30T12:00",
      },
      owner.cookie,
    );
    expect(duplicatePlacement).toMatchObject({ status: 409 });
    const revisionAfterDuplicate = (await getWorking(owner.cookie, slug))
      .revision;
    expect(revisionAfterDuplicate).toBe(2);

    let working = await getWorking(owner.cookie, slug);
    expect(
      working.items.filter((item) => item.conflicts.includes("speaker")),
    ).toHaveLength(2);
    expect(
      (
        await callTrpc(
          "agendas.publish",
          { slug, expectedRevision: working.revision },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    await expectOk(
      "agendas.move",
      {
        slug,
        agendaItemId: secondPlacement.id,
        roomId: studio.id,
        startsAtLocal: "2027-10-30T10:00",
        endsAtLocal: "2027-10-30T11:00",
      },
      owner.cookie,
    );
    await expectOk(
      "agendas.placeService",
      {
        slug,
        title: "Lunch",
        scope: { type: "event" },
        startsAtLocal: "2027-10-30T12:00",
        endsAtLocal: "2027-10-30T13:00",
      },
      owner.cookie,
    );
    const thirdPlacement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: program.third,
            roomId: mainRoom.id,
            startsAtLocal: "2027-10-30T12:30",
            endsAtLocal: "2027-10-30T13:30",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    working = await getWorking(owner.cookie, slug);
    expect(working.items.some((item) => item.conflicts.includes("room"))).toBe(
      true,
    );
    expect(
      (
        await callTrpc(
          "agendas.publish",
          { slug, expectedRevision: working.revision },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    await expectOk(
      "agendas.move",
      {
        slug,
        agendaItemId: thirdPlacement.id,
        roomId: mainRoom.id,
        startsAtLocal: "2027-10-30T13:00",
        endsAtLocal: "2027-10-30T14:00",
      },
      owner.cookie,
    );
    working = await getWorking(owner.cookie, slug);
    const firstPublication = await callTrpc(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      organizer.cookie,
    );
    expect(firstPublication.status, JSON.stringify(firstPublication.body)).toBe(
      200,
    );
    let published = await getPublished(slug);
    expect(published.revision).toBe(1);
    expect(published.items.map((item) => item.title)).toEqual([
      "Opening systems",
      "Closing systems",
      "Lunch",
      "Independent systems",
    ]);
    expect(published.items[0]?.speakers[0]?.displayName).toBe("Shared Speaker");
    const publishedHeadshotUrl = published.items[0]?.speakers[0]?.headshotUrl;
    expect(publishedHeadshotUrl).toMatch(
      /^\/api\/speaker-headshots\/[0-9a-f-]+$/,
    );
    const replacedProfile = getResult(
      (
        await callTrpc(
          "speakerProfile.saveOwn",
          {
            displayName: "Shared Speaker",
            bio: "Shared bio",
            expectedRevision: 1,
            headshot: {
              fileName: "replacement.png",
              contentType: "image/png",
              contentBase64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            },
          },
          sharedSpeaker.cookie,
        )
      ).body,
      z.object({ headshotUrl: z.string() }),
    );
    expect(replacedProfile.headshotUrl).not.toBe(publishedHeadshotUrl);
    expect((await workerFetch(publishedHeadshotUrl ?? "")).status).toBe(200);
    expect(
      (
        await workerFetch(replacedProfile.headshotUrl, {
          headers: { Cookie: sharedSpeaker.cookie },
        })
      ).status,
    ).toBe(200);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT subject, body FROM agenda_delivery_work WHERE agenda_item_id = ? AND calendar_sequence = 0",
      )
        .bind(firstPlacement.id)
        .first(),
    ).toEqual({
      subject: "Calendar: Opening systems",
      body: "Hello Shared Speaker, Opening systems is at OpenBoard Live.",
    });

    const profileBeforeConflict = await testEnvironment.DB.prepare(
      "SELECT updated_at AS updatedAt, revision FROM speaker_profiles WHERE user_id = ?",
    )
      .bind(sharedSpeaker.userId)
      .first<{ updatedAt: number; revision: number }>();
    expect(profileBeforeConflict).toBeTruthy();
    const putFile = testEnvironment.FILES.put.bind(testEnvironment.FILES);
    const putFileSpy = vi
      .spyOn(testEnvironment.FILES, "put")
      .mockImplementationOnce(async (...arguments_) => {
        const result = await putFile(...arguments_);
        await testEnvironment.DB.prepare(
          "UPDATE speaker_profiles SET display_name = ?, bio = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?",
        )
          .bind(
            "Concurrent Speaker",
            "Saved while the headshot uploaded.",
            profileBeforeConflict?.updatedAt,
            sharedSpeaker.userId,
          )
          .run();
        return result;
      });
    const conflictingProfileSave = await saveOwnSpeakerProfile(
      createDatabase(testEnvironment.DB),
      testEnvironment.FILES,
      sharedSpeaker.userId as UserId,
      {
        displayName: "Stale Speaker",
        bio: "This edit started before the concurrent save.",
        expectedRevision: profileBeforeConflict?.revision ?? 0,
        headshot: {
          fileName: "racing.png",
          contentType: "image/png",
          contentBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      },
    );
    putFileSpy.mockRestore();
    expect(conflictingProfileSave).toEqual({
      ok: false,
      error: "profile_conflict",
    });
    expect(
      await testEnvironment.DB.prepare(
        "SELECT display_name AS displayName, bio, revision, updated_at AS updatedAt FROM speaker_profiles WHERE user_id = ?",
      )
        .bind(sharedSpeaker.userId)
        .first(),
    ).toEqual({
      displayName: "Concurrent Speaker",
      bio: "Saved while the headshot uploaded.",
      revision: (profileBeforeConflict?.revision ?? 0) + 1,
      updatedAt: profileBeforeConflict?.updatedAt,
    });

    const deliveryClaims: number[] = [];
    let deliveryClock = new Date("2028-01-01T00:00:00.000Z").getTime();
    const failedDelivery = await processAgendaDeliveryWork(
      createDatabase(testEnvironment.DB),
      async (delivery) => {
        const claim = await testEnvironment.DB.prepare(
          "SELECT claimed_at AS claimedAt FROM agenda_delivery_work WHERE id = ?",
        )
          .bind(delivery.workId)
          .first<{ claimedAt: number }>();
        deliveryClaims.push(claim?.claimedAt ?? 0);
        throw new Error("Calendar transport unavailable");
      },
      {
        organizerEmail: "calendar@example.com",
        clock: () => {
          const current = new Date(deliveryClock);
          deliveryClock += 3 * 60_000;
          return current;
        },
        limit: 100,
      },
    );
    expect(failedDelivery).toEqual({ delivered: 0, failed: 3, superseded: 0 });
    expect(deliveryClaims).toEqual([
      new Date("2028-01-01T00:03:00.000Z").getTime(),
      new Date("2028-01-01T00:09:00.000Z").getTime(),
      new Date("2028-01-01T00:15:00.000Z").getTime(),
    ]);

    const initialRetries: Array<{
      workId: string;
      agendaItemId: string;
      uid: string;
      sequence: number;
    }> = [];
    const successfulRetry = await processAgendaDeliveryWork(
      createDatabase(testEnvironment.DB),
      (delivery) => {
        initialRetries.push(delivery);
        return Promise.resolve();
      },
      {
        organizerEmail: "calendar@example.com",
        now: new Date("2028-01-02T00:00:00.000Z"),
        limit: 100,
      },
    );
    expect(successfulRetry).toEqual({ delivered: 3, failed: 0, superseded: 0 });
    const retriedFirstPlacement = initialRetries.find(
      (delivery) => delivery.agendaItemId === firstPlacement.id,
    );
    expect(retriedFirstPlacement).toMatchObject({
      uid: `${firstPlacement.id}@openboard`,
      sequence: 0,
    });
    expect(
      await testEnvironment.DB.prepare(
        "SELECT attempt_count AS attemptCount FROM agenda_delivery_work WHERE id = ?",
      )
        .bind(retriedFirstPlacement?.workId)
        .first(),
    ).toEqual({ attemptCount: 2 });

    const jsonResponse = await workerFetch(`/api/v1/events/${slug}/schedule`);
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(jsonResponse.headers.get("cache-control")).toMatch(/^public,/);
    const etag = jsonResponse.headers.get("etag");
    expect(etag).toBeTruthy();
    const publicSchedule = await jsonResponse.json<{
      revision: number;
      event: { timezone: string };
      items: Array<Record<string, unknown>>;
    }>();
    expect(publicSchedule.revision).toBe(1);
    expect(publicSchedule.event.timezone).toBe("Europe/Berlin");
    expect(publicSchedule.items[0]).not.toHaveProperty("programItemId");
    expect(publicSchedule.items[0]).not.toHaveProperty("publicationId");
    expect(
      (
        publicSchedule.items[0] as {
          speakers: Array<{ headshotUrl: string }>;
        }
      ).speakers[0]?.headshotUrl,
    ).toMatch(/^https?:\/\/[^/]+\/api\/speaker-headshots\/[0-9a-f-]+$/);

    const calendarResponse = await workerFetch(
      `/api/v1/events/${slug}/schedule.ics`,
    );
    expect(calendarResponse.status).toBe(200);
    expect(calendarResponse.headers.get("content-type")).toMatch(
      /^text\/calendar/,
    );
    expect(await calendarResponse.text()).toContain(
      "X-OPENBOARD-REVISION:1\r\n",
    );

    const unchangedResponse = await workerFetch(
      `/api/v1/events/${slug}/schedule`,
      { headers: { "If-None-Match": etag ?? "" } },
    );
    expect(unchangedResponse.status).toBe(304);

    const compressedResponse = await workerFetch(
      `/api/v1/events/${slug}/schedule`,
      { headers: { "Accept-Encoding": "gzip" } },
    );
    expect(compressedResponse.headers.get("content-encoding")).toBe("gzip");

    const openApiResponse = await workerFetch("/api/v1/openapi.json");
    expect(openApiResponse.status).toBe(200);
    const openApi = await openApiResponse.json<{
      openapi: string;
      paths: Record<string, unknown>;
    }>();
    expect(openApi.openapi).toBe("3.1.0");
    expect(Object.keys(openApi.paths)).toEqual([
      "/api/v1/events/{eventSlug}/schedule",
      "/api/v1/events/{eventSlug}/schedule.ics",
    ]);

    await expectOk(
      "events.create",
      {
        name: "Unpublished agenda",
        slug: "agenda-unpublished",
        startsOn: "2027-10-30",
        endsOn: "2027-10-30",
        timezone: "Europe/Berlin",
      },
      owner.cookie,
    );

    const unknownResponse = await workerFetch(
      "/api/v1/events/unknown-event/schedule",
    );
    const unpublishedResponse = await workerFetch(
      "/api/v1/events/agenda-unpublished/schedule",
    );
    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.text()).toBe(await unpublishedResponse.text());
    expect((await workerFetch("/api/v1/events/%ZZ/schedule")).status).toBe(404);

    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "UPDATE submissions SET title = ? WHERE id = ?",
      ).bind("Opening systems, revised", program.firstSubmission),
      testEnvironment.DB.prepare(
        "UPDATE speaker_profiles SET display_name = ? WHERE user_id = ?",
      ).bind("Shared Speaker, revised", sharedSpeaker.userId),
      testEnvironment.DB.prepare("UPDATE rooms SET name = ? WHERE id = ?").bind(
        "Grand hall",
        mainRoom.id,
      ),
      testEnvironment.DB.prepare("UPDATE user SET email = ? WHERE id = ?").bind(
        "agenda-speaker-two-new@example.com",
        otherSpeaker.userId,
      ),
    ]);
    published = await getPublished(slug);
    expect(published.items[0]?.title).toBe("Opening systems");
    expect(published.items[0]?.roomName).toBe("Main hall");
    expect(published.items[0]?.speakers[0]?.displayName).toBe("Shared Speaker");

    working = await getWorking(owner.cookie, slug);
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER mutate_speaker_claim_during_publication AFTER INSERT ON agenda_publications BEGIN UPDATE submission_speakers SET claimed_user_id = '${otherSpeaker.userId}' WHERE submission_id = '${program.firstSubmission}'; END`,
    ).run();
    expect(
      (
        await callTrpc(
          "agendas.publish",
          { slug, expectedRevision: working.revision },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
    await testEnvironment.DB.prepare(
      "DROP TRIGGER mutate_speaker_claim_during_publication",
    ).run();
    expect((await getPublished(slug)).revision).toBe(1);

    await testEnvironment.DB.prepare(
      "CREATE TRIGGER fail_agenda_snapshot BEFORE INSERT ON published_agenda_items BEGIN SELECT RAISE(ABORT, 'forced_failure'); END",
    ).run();
    expect(
      (
        await callTrpc(
          "agendas.publish",
          { slug, expectedRevision: working.revision },
          owner.cookie,
        )
      ).status,
    ).toBe(500);
    await testEnvironment.DB.prepare("DROP TRIGGER fail_agenda_snapshot").run();
    expect((await getPublished(slug)).revision).toBe(1);

    await expectOk(
      "agendas.cancel",
      { slug, agendaItemId: firstPlacement.id },
      owner.cookie,
    );
    const canceledRevision = (await getWorking(owner.cookie, slug)).revision;
    expect(
      (
        await callTrpc(
          "agendas.cancel",
          { slug, agendaItemId: firstPlacement.id },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect((await getWorking(owner.cookie, slug)).revision).toBe(
      canceledRevision,
    );
    working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    published = await getPublished(slug);
    expect(published.revision).toBe(2);
    expect(
      published.items.some((item) => item.agendaItemId === firstPlacement.id),
    ).toBe(false);
    const canceledJson = await workerFetch(`/api/v1/events/${slug}/schedule`);
    const canceledCalendar = await workerFetch(
      `/api/v1/events/${slug}/schedule.ics`,
    );
    expect((await canceledJson.json<{ revision: number }>()).revision).toBe(2);
    expect(await canceledCalendar.text()).toContain(
      "X-OPENBOARD-REVISION:2\r\n",
    );

    const changedRecipientHistory = await testEnvironment.DB.prepare(
      "SELECT action, destination, calendar_sequence AS sequence FROM agenda_delivery_work WHERE agenda_item_id = ? ORDER BY calendar_sequence, action, destination",
    )
      .bind(thirdPlacement.id)
      .all<{ action: string; destination: string; sequence: number }>();
    expect(changedRecipientHistory.results).toEqual([
      {
        action: "publish",
        destination: "agenda-speaker-two@example.com",
        sequence: 0,
      },
      {
        action: "cancel",
        destination: "agenda-speaker-two@example.com",
        sequence: 1,
      },
      {
        action: "update",
        destination: "agenda-speaker-two-new@example.com",
        sequence: 1,
      },
    ]);
    const changedRecipientWork = await testEnvironment.DB.prepare(
      "SELECT action, destination, calendar_sequence AS sequence FROM agenda_delivery_work WHERE agenda_item_id = ? AND calendar_sequence = 1 ORDER BY action, destination",
    )
      .bind(thirdPlacement.id)
      .all<{ action: string; destination: string; sequence: number }>();
    expect(changedRecipientWork.results).toEqual([
      {
        action: "cancel",
        destination: "agenda-speaker-two@example.com",
        sequence: 1,
      },
      {
        action: "update",
        destination: "agenda-speaker-two-new@example.com",
        sequence: 1,
      },
    ]);

    await expectOk(
      "agendas.restore",
      { slug, agendaItemId: firstPlacement.id },
      organizer.cookie,
    );
    working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    published = await getPublished(slug);
    expect(published.revision).toBe(3);
    expect(published.items[0]?.title).toBe("Opening systems, revised");
    expect(published.items[0]?.roomName).toBe("Grand hall");
    expect(published.items[0]?.speakers[0]?.displayName).toBe(
      "Shared Speaker, revised",
    );
    const restoredJson = await workerFetch(`/api/v1/events/${slug}/schedule`);
    const restoredCalendar = await workerFetch(
      `/api/v1/events/${slug}/schedule.ics`,
    );
    expect((await restoredJson.json<{ revision: number }>()).revision).toBe(3);
    const restoredCalendarBody = await restoredCalendar.text();
    expect(restoredCalendarBody).toContain("X-OPENBOARD-REVISION:3\r\n");
    expect(restoredCalendarBody).toContain(
      `UID:${firstPlacement.id}@openboard\r\n`,
    );
    expect(restoredCalendarBody).toContain("SEQUENCE:2\r\n");

    const sync = await testEnvironment.DB.prepare(
      "SELECT sequence, canceled FROM calendar_sync_states WHERE agenda_item_id = ?",
    )
      .bind(firstPlacement.id)
      .first<{ sequence: number; canceled: number }>();
    expect(sync).toEqual({ sequence: 2, canceled: 0 });
    const work = await testEnvironment.DB.prepare(
      "SELECT action FROM agenda_delivery_work WHERE agenda_item_id = ? ORDER BY created_at",
    )
      .bind(firstPlacement.id)
      .all<{ action: string }>();
    expect(work.results.map((row) => row.action)).toEqual([
      "publish",
      "cancel",
      "restore",
    ]);

    const deliveredSequences: number[] = [];
    const retriedDelivery = await processAgendaDeliveryWork(
      createDatabase(testEnvironment.DB),
      (delivery) => {
        deliveredSequences.push(delivery.sequence);
        return Promise.resolve();
      },
      {
        organizerEmail: "calendar@example.com",
        now: new Date("2030-01-01T00:00:00.000Z"),
        limit: 100,
      },
    );
    expect(retriedDelivery.superseded).toBeGreaterThan(0);
    expect(retriedDelivery.delivered).toBeGreaterThan(0);
    expect(deliveredSequences).toContain(2);
    const firstPlacementAttempts = await testEnvironment.DB.prepare(
      "SELECT agenda_delivery_attempts.result FROM agenda_delivery_attempts INNER JOIN agenda_delivery_work ON agenda_delivery_work.id = agenda_delivery_attempts.work_id WHERE agenda_delivery_work.agenda_item_id = ? ORDER BY agenda_delivery_work.calendar_sequence, agenda_delivery_attempts.attempt_number",
    )
      .bind(firstPlacement.id)
      .all<{ result: string }>();
    expect(
      firstPlacementAttempts.results.map((attempt) => attempt.result),
    ).toEqual(["failed", "delivered", "superseded", "delivered"]);

    const unchangedPublication = await callTrpc(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    expect(unchangedPublication.status).toBe(200);
    expect(
      getResult(
        unchangedPublication.body,
        z.object({ revision: z.number(), deliveryWork: z.number() }),
      ),
    ).toEqual({ revision: 4, deliveryWork: 0 });
    const unchangedJson = await workerFetch(`/api/v1/events/${slug}/schedule`);
    const unchangedCalendar = await workerFetch(
      `/api/v1/events/${slug}/schedule.ics`,
    );
    expect((await unchangedJson.json<{ revision: number }>()).revision).toBe(4);
    expect(await unchangedCalendar.text()).toContain(
      "X-OPENBOARD-REVISION:4\r\n",
    );
  });

  test("publishes an agenda above D1 statement binding limits", async () => {
    const slug = "large-agenda-2028";
    const owner = await signIn("large-agenda-owner@example.com");
    const fixture = await seedAgendaFixture(
      slug,
      owner,
      70,
      3,
      "2028-08-10",
      "2028-08-13",
    );

    for (const [index, programItemId] of fixture.programItemIds.entries()) {
      const day = 10 + Math.floor(index / 20);
      const hour = index % 20;
      await expectOk(
        "agendas.placeProgram",
        {
          slug,
          programItemId,
          roomId: fixture.roomId,
          startsAtLocal: `2028-08-${day}T${String(hour).padStart(2, "0")}:00`,
          endsAtLocal: `2028-08-${day}T${String(hour + 1).padStart(2, "0")}:00`,
        },
        owner.cookie,
      );
    }

    const working = await getWorking(owner.cookie, slug);
    expect(
      (
        await callTrpc(
          "agendas.publish",
          { slug, expectedRevision: working.revision },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    const published = await getPublished(slug);
    expect(published.items).toHaveLength(70);
    expect(published.items.every((item) => item.speakers.length === 3)).toBe(
      true,
    );
  }, 15_000);

  test("exposes only finalized revisions and closes them to later rows", async () => {
    const slug = "finalized-agenda-2028";
    const owner = await signIn("finalized-agenda-owner@example.com");
    await expectOk(
      "events.create",
      {
        name: "Finalized Agenda",
        slug,
        startsOn: "2028-08-10",
        endsOn: "2028-08-10",
        timezone: "Europe/Berlin",
      },
      owner.cookie,
    );
    await expectOk(
      "agendas.placeService",
      {
        slug,
        title: "Doors open",
        scope: { type: "event" },
        startsAtLocal: "2028-08-10T08:00",
        endsAtLocal: "2028-08-10T09:00",
      },
      owner.cookie,
    );
    let working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    const laterItem = getResult(
      (
        await callTrpc(
          "agendas.placeService",
          {
            slug,
            title: "Reception",
            scope: { type: "event" },
            startsAtLocal: "2028-08-10T17:00",
            endsAtLocal: "2028-08-10T18:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    working = await getWorking(owner.cookie, slug);
    await testEnvironment.DB.prepare(
      "INSERT INTO agenda_publications (id, agenda_id, event_id, revision, working_revision, event_name, timezone, starts_on, ends_on, published_by_user_id, created_at, requires_finalization) SELECT ?, agendas.id, events.id, 2, agendas.revision, events.name, events.timezone, events.starts_on, events.ends_on, ?, ?, 1 FROM agendas INNER JOIN events ON events.id = agendas.event_id WHERE events.slug = ?",
    )
      .bind(crypto.randomUUID(), owner.userId, Date.now(), slug)
      .run();
    expect(
      getResult(
        (
          await callTrpc(
            "agendas.publicationStatus",
            { slug },
            owner.cookie,
            "query",
          )
        ).body,
        publicationStatusSchema,
      )?.revision,
    ).toBe(1);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT finalized FROM agenda_publications INNER JOIN events ON events.id = agenda_publications.event_id WHERE events.slug = ? AND agenda_publications.revision = 2",
      )
        .bind(slug)
        .first<{ finalized: number }>(),
    ).toEqual({ finalized: 0 });
    expect((await getPublished(slug)).revision).toBe(1);

    const firstPublication = await testEnvironment.DB.prepare(
      "SELECT agenda_publications.id FROM agenda_publications INNER JOIN events ON events.id = agenda_publications.event_id WHERE events.slug = ? AND agenda_publications.revision = 1",
    )
      .bind(slug)
      .first<{ id: string }>();
    expect(firstPublication).toBeTruthy();
    await expect(
      testEnvironment.DB.prepare(
        "INSERT INTO published_agenda_items (id, publication_id, agenda_item_id, kind, title, starts_at, ends_at, canceled) VALUES (?, ?, ?, 'service', 'Reception', '2028-08-10T15:00:00.000Z', '2028-08-10T16:00:00.000Z', 0)",
      )
        .bind(crypto.randomUUID(), firstPublication?.id, laterItem.id)
        .run(),
    ).rejects.toThrow("immutable_agenda_publication");
  });

  test("publishes cancellations after references become unavailable", async () => {
    const slug = "agenda-cancellation-2028";
    const owner = await signIn("agenda-cancellation-owner@example.com");
    const fixture = await seedAgendaFixture(slug, owner, 2, 1);
    const firstPlacement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: fixture.programItemIds[0],
            roomId: fixture.roomId,
            startsAtLocal: "2028-08-10T09:00",
            endsAtLocal: "2028-08-10T10:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    let working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );

    const neverPublishedPlacement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: fixture.programItemIds[1],
            roomId: fixture.roomId,
            startsAtLocal: "2028-08-10T10:00",
            endsAtLocal: "2028-08-10T11:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    await expectOk(
      "agendas.cancel",
      { slug, agendaItemId: neverPublishedPlacement.id },
      owner.cookie,
    );
    await expectOk(
      "rooms.archive",
      { slug, roomId: fixture.roomId },
      owner.cookie,
    );
    expect((await getWorking(owner.cookie, slug)).rooms).toContainEqual(
      expect.objectContaining({
        id: fixture.roomId,
        archived: true,
      }),
    );
    await expectOk(
      "agendas.cancel",
      { slug, agendaItemId: firstPlacement.id },
      owner.cookie,
    );
    working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    expect((await getPublished(slug)).items).toEqual([]);

    const neverPublishedWork = await testEnvironment.DB.prepare(
      "SELECT action FROM agenda_delivery_work WHERE agenda_item_id = ?",
    )
      .bind(neverPublishedPlacement.id)
      .all<{ action: string }>();
    expect(neverPublishedWork.results).toEqual([]);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT sequence FROM calendar_sync_states WHERE agenda_item_id = ?",
      )
        .bind(neverPublishedPlacement.id)
        .first(),
    ).toBeNull();

    const replacementRoom = getResult(
      (
        await callTrpc(
          "rooms.create",
          { slug, name: "Replacement room" },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    await expectOk(
      "agendas.move",
      {
        slug,
        agendaItemId: neverPublishedPlacement.id,
        roomId: replacementRoom.id,
        startsAtLocal: "2028-08-10T10:00",
        endsAtLocal: "2028-08-10T11:00",
      },
      owner.cookie,
    );
    await expectOk(
      "agendas.restore",
      { slug, agendaItemId: neverPublishedPlacement.id },
      owner.cookie,
    );
    working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    const initialDelivery = await testEnvironment.DB.prepare(
      "SELECT action, calendar_sequence AS sequence FROM agenda_delivery_work WHERE agenda_item_id = ?",
    )
      .bind(neverPublishedPlacement.id)
      .first<{ action: string; sequence: number }>();
    expect(initialDelivery).toEqual({ action: "publish", sequence: 0 });
  });

  test("edits service blocks and returns program items to the palette", async () => {
    const slug = "agenda-editor-2028";
    const owner = await signIn("agenda-editor-owner@example.com");
    const fixture = await seedAgendaFixture(slug, owner, 1, 1);
    const programPlacement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: fixture.programItemIds[0],
            roomId: fixture.roomId,
            startsAtLocal: "2028-08-10T09:00",
            endsAtLocal: "2028-08-10T10:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    const service = getResult(
      (
        await callTrpc(
          "agendas.placeService",
          {
            slug,
            title: "New service block",
            scope: { type: "event" },
            startsAtLocal: "2028-08-10T10:00",
            endsAtLocal: "2028-08-10T11:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    let working = await getWorking(owner.cookie, slug);
    const serviceRevision = working.items.find(
      (item) => item.id === service.id,
    )?.revision;
    expect(serviceRevision).toBe(1);

    await expectOk(
      "agendas.updateService",
      {
        slug,
        agendaItemId: service.id,
        expectedRevision: serviceRevision,
        title: "Coffee break",
        scope: { type: "room", roomId: fixture.roomId },
        startsAtLocal: "2028-08-10T10:15",
        endsAtLocal: "2028-08-10T10:45",
      },
      owner.cookie,
    );
    const staleUpdate = await callTrpc(
      "agendas.updateService",
      {
        slug,
        agendaItemId: service.id,
        expectedRevision: serviceRevision,
        title: "Stale break",
        scope: { type: "event" },
        startsAtLocal: "2028-08-10T10:30",
        endsAtLocal: "2028-08-10T11:00",
      },
      owner.cookie,
    );
    expect(staleUpdate.status).toBe(409);
    working = await getWorking(owner.cookie, slug);
    expect(working.items).toContainEqual(
      expect.objectContaining({
        id: service.id,
        serviceTitle: "Coffee break",
        roomName: "Room",
      }),
    );

    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    const syncStateBeforeUnplace = await testEnvironment.DB.prepare(
      "SELECT uid, sequence FROM calendar_sync_states WHERE agenda_item_id = ?",
    )
      .bind(programPlacement.id)
      .first<{ uid: string; sequence: number }>();
    expect(syncStateBeforeUnplace).toEqual({
      uid: `${programPlacement.id}@openboard`,
      sequence: 0,
    });

    await expectOk(
      "agendas.unplaceProgram",
      { slug, agendaItemId: programPlacement.id },
      owner.cookie,
    );
    working = await getWorking(owner.cookie, slug);
    expect(working.items.some((item) => item.id === programPlacement.id)).toBe(
      false,
    );
    expect(working.unplacedProgramItems).toContainEqual(
      expect.objectContaining({ id: fixture.programItemIds[0] }),
    );
    expect(
      await testEnvironment.DB.prepare(
        "SELECT uid, sequence FROM calendar_sync_states WHERE agenda_item_id = ?",
      )
        .bind(programPlacement.id)
        .first(),
    ).toEqual(syncStateBeforeUnplace);

    const replaced = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: fixture.programItemIds[0],
            roomId: fixture.roomId,
            startsAtLocal: "2028-08-10T11:00",
            endsAtLocal: "2028-08-10T12:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    expect(replaced.id).toBe(programPlacement.id);
  });

  test("publishes after a program item returns to unplaced", async () => {
    const slug = "agenda-republish-unplaced";
    const owner = await signIn("agenda-republish-unplaced@example.com");
    const fixture = await seedAgendaFixture(slug, owner, 1, 1);
    const placement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: fixture.programItemIds[0],
            roomId: fixture.roomId,
            startsAtLocal: "2028-08-10T09:00",
            endsAtLocal: "2028-08-10T10:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    let working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    await expectOk(
      "agendas.unplaceProgram",
      { slug, agendaItemId: placement.id },
      owner.cookie,
    );
    working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    expect((await getPublished(slug)).items).toEqual([]);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT sequence, canceled FROM calendar_sync_states WHERE agenda_item_id = ?",
      )
        .bind(placement.id)
        .first(),
    ).toEqual({ sequence: 1, canceled: 1 });
    expect(
      await testEnvironment.DB.prepare(
        "SELECT action, calendar_sequence AS sequence FROM agenda_delivery_work WHERE agenda_item_id = ? ORDER BY calendar_sequence DESC",
      )
        .bind(placement.id)
        .first(),
    ).toEqual({ action: "cancel", sequence: 1 });
    await testEnvironment.DB.prepare(
      "UPDATE submission_speakers SET invited_email = 'restored@example.com' WHERE submission_id = (SELECT submission_id FROM program_items WHERE id = ?)",
    )
      .bind(fixture.programItemIds[0])
      .run();
    await expectOk(
      "agendas.placeProgram",
      {
        slug,
        programItemId: fixture.programItemIds[0],
        roomId: fixture.roomId,
        startsAtLocal: "2028-08-10T11:00",
        endsAtLocal: "2028-08-10T12:00",
      },
      owner.cookie,
    );
    working = await getWorking(owner.cookie, slug);
    await expectOk(
      "agendas.publish",
      { slug, expectedRevision: working.revision },
      owner.cookie,
    );
    await testEnvironment.DB.prepare(
      "UPDATE calendar_sync_states SET sequence = 2 WHERE agenda_item_id = ?",
    )
      .bind(placement.id)
      .run();
    const deliveries: Array<{
      agendaItemId: string;
      method: string;
      sequence: number;
      calendar: string;
    }> = [];
    expect(
      await processAgendaDeliveryWork(
        createDatabase(testEnvironment.DB),
        (delivery) => {
          deliveries.push({
            agendaItemId: delivery.agendaItemId,
            method: delivery.method,
            sequence: delivery.sequence,
            calendar: delivery.calendar,
          });
          return Promise.resolve();
        },
        { organizerEmail: "calendar@example.com", limit: 10_000 },
      ),
    ).toMatchObject({ failed: 0 });
    const placementDeliveries = deliveries.filter(
      (delivery) =>
        delivery.agendaItemId === placement.id && delivery.method === "CANCEL",
    );
    expect(placementDeliveries).toHaveLength(1);
    expect(placementDeliveries[0]).toMatchObject({
      agendaItemId: placement.id,
      method: "CANCEL",
      sequence: 1,
    });
    expect(placementDeliveries[0]?.calendar).toContain(
      "DTSTART:20280810T070000Z",
    );
    expect(placementDeliveries[0]?.calendar).not.toContain(
      "DTSTART:20280810T090000Z",
    );
  });

  test("does not place a program item through another event", async () => {
    const owner = await signIn("agenda-cross-event-owner@example.com");
    const first = await seedAgendaFixture(
      "agenda-cross-event-one",
      owner,
      1,
      1,
    );
    await seedAgendaFixture("agenda-cross-event-two", owner, 1, 1);
    const response = await callTrpc(
      "agendas.placeProgram",
      {
        slug: "agenda-cross-event-two",
        programItemId: first.programItemIds[0],
        roomId: null,
        startsAtLocal: "2028-08-10T09:00",
        endsAtLocal: "2028-08-10T10:00",
      },
      owner.cookie,
    );
    expect(response.status).toBe(409);
    expect(
      (await getWorking(owner.cookie, "agenda-cross-event-two")).items,
    ).toEqual([]);
  });

  test("rejects every invalid active placement from authoritative state", async () => {
    const slug = "agenda-validation-2028";
    const owner = await signIn("agenda-validation-owner@example.com");
    const fixture = await seedAgendaFixture(slug, owner, 1, 1, "2028-10-29");
    const placement = getResult(
      (
        await callTrpc(
          "agendas.placeProgram",
          {
            slug,
            programItemId: fixture.programItemIds[0],
            roomId: null,
            startsAtLocal: "2028-10-29T09:00",
            endsAtLocal: "2028-10-29T10:00",
          },
          owner.cookie,
        )
      ).body,
      idSchema,
    );
    await expectPublicationFailure(slug, owner.cookie);

    await expectOk(
      "agendas.move",
      {
        slug,
        agendaItemId: placement.id,
        roomId: fixture.roomId,
        startsAtLocal: "2028-10-29T02:30",
        endsAtLocal: "2028-10-29T03:30",
      },
      owner.cookie,
    );
    await expectPublicationFailure(slug, owner.cookie);

    const beforeInvalidMove = await getWorking(owner.cookie, slug);
    const invalidMove = await callTrpc(
      "agendas.move",
      {
        slug,
        agendaItemId: placement.id,
        roomId: fixture.roomId,
        startsAtLocal: "2028-10-29T10:00",
        endsAtLocal: "2028-10-29T09:00",
      },
      owner.cookie,
    );
    expect(invalidMove.status).toBe(400);
    expect(JSON.stringify(invalidMove.body)).toContain(
      "End must be after start.",
    );
    expect(await getWorking(owner.cookie, slug)).toEqual(beforeInvalidMove);

    await testEnvironment.DB.prepare(
      "UPDATE agenda_items SET starts_at_local = ?, ends_at_local = ? WHERE id = ?",
    )
      .bind("2028-10-29T10:00", "2028-10-29T09:00", placement.id)
      .run();
    const corrupted = await getWorking(owner.cookie, slug);
    const publication = await callTrpc(
      "agendas.publish",
      { slug, expectedRevision: corrupted.revision },
      owner.cookie,
    );
    expect(publication.status).toBe(400);
    expect(JSON.stringify(publication.body)).toContain(
      "End time must be after start time.",
    );

    await expectOk(
      "agendas.move",
      {
        slug,
        agendaItemId: placement.id,
        roomId: fixture.roomId,
        startsAtLocal: "2028-10-29T09:00",
        endsAtLocal: "2028-10-29T10:00",
      },
      owner.cookie,
    );
    await expectOk(
      "rooms.archive",
      { slug, roomId: fixture.roomId },
      owner.cookie,
    );
    await expectPublicationFailure(slug, owner.cookie);
    expect(
      (await callTrpc("agendas.published", { slug }, undefined, "query"))
        .status,
    ).toBe(404);
  });
});

async function getWorking(cookie: string, slug: string) {
  return getResult(
    (await callTrpc("agendas.working", { slug }, cookie, "query")).body,
    workingAgendaSchema,
  );
}

async function getPublished(slug: string) {
  return getResult(
    (await callTrpc("agendas.published", { slug }, undefined, "query")).body,
    publishedAgendaSchema,
  );
}

async function expectOk(procedure: string, input: unknown, cookie: string) {
  expect((await callTrpc(procedure, input, cookie)).status).toBe(200);
}

async function expectPublicationFailure(
  slug: string,
  cookie: string,
  expectedStatus = 409,
) {
  const working = await getWorking(cookie, slug);
  expect(
    (
      await callTrpc(
        "agendas.publish",
        { slug, expectedRevision: working.revision },
        cookie,
      )
    ).status,
  ).toBe(expectedStatus);
}

async function seedAcceptedProgram(
  slug: string,
  trackId: string,
  ownerUserId: string,
  sharedSpeakerUserId: string,
  otherSpeakerUserId: string,
) {
  const event = await testEnvironment.DB.prepare(
    "SELECT id FROM events WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string }>();
  if (!event) throw new Error("Event fixture missing.");
  const now = Date.now();
  const cfpId = crypto.randomUUID();
  await testEnvironment.DB.prepare(
    "INSERT INTO cfps (id, event_id, name, deadline, status, formats_json, custom_fields_json, structure_locked_at, created_at, updated_at) VALUES (?, ?, 'Agenda CFP', ?, 'open', '[\"Talk\"]', '[]', ?, ?, ?)",
  )
    .bind(cfpId, event.id, "2027-09-01T00:00:00.000Z", now, now, now)
    .run();
  await testEnvironment.DB.prepare(
    "INSERT INTO review_rounds (id, event_id, cfp_id, name, status, closed_at, created_at, updated_at) VALUES (?, ?, ?, 'Agenda review', 'closed', ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), event.id, cfpId, now, now, now)
    .run();
  const definitions = [
    ["Opening systems", sharedSpeakerUserId, "Shared Speaker"],
    ["Closing systems", sharedSpeakerUserId, "Shared Speaker"],
    ["Independent systems", otherSpeakerUserId, "Other Speaker"],
  ] as const;
  const seeded: Array<{ programItemId: string; submissionId: string }> = [];
  for (const [title, speakerUserId, speakerName] of definitions) {
    const submissionId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    const programItemId = crypto.randomUUID();
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "INSERT INTO submissions (id, event_id, cfp_id, cfp_revision, owner_user_id, client_draft_id, track_id, title, abstract, format, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Talk', 'active', ?, ?)",
      ).bind(
        submissionId,
        event.id,
        cfpId,
        now,
        ownerUserId,
        crypto.randomUUID(),
        trackId,
        title,
        `${title} abstract`,
        now,
        now,
      ),
      testEnvironment.DB.prepare(
        "INSERT INTO decisions (id, submission_id, status, revision, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)",
      ).bind(decisionId, submissionId, now, now),
      testEnvironment.DB.prepare(
        "INSERT INTO submission_speakers (id, submission_id, invited_name, invited_email, claimed_user_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        submissionId,
        speakerName,
        `${speakerUserId}@example.invalid`,
        speakerUserId,
        now,
        now,
      ),
      testEnvironment.DB.prepare(
        "UPDATE decisions SET status = 'accepted', revision = 1, updated_at = ? WHERE id = ?",
      ).bind(now, decisionId),
      testEnvironment.DB.prepare(
        "INSERT INTO program_items (id, event_id, submission_id, created_at) VALUES (?, ?, ?, ?)",
      ).bind(programItemId, event.id, submissionId, now),
    ]);
    seeded.push({ programItemId, submissionId });
  }
  const sharedHeadshotFileId = crypto.randomUUID();
  const sharedHeadshotObjectKey = `speaker-headshots/${sharedSpeakerUserId}/${sharedHeadshotFileId}`;
  await testEnvironment.DB.batch([
    testEnvironment.DB.prepare(
      "INSERT INTO stored_files (id, object_key, file_name, content_type, size_bytes, uploaded_by_user_id, created_at) VALUES (?, ?, 'shared.png', 'image/png', 1, ?, ?)",
    ).bind(
      sharedHeadshotFileId,
      sharedHeadshotObjectKey,
      sharedSpeakerUserId,
      now,
    ),
    testEnvironment.DB.prepare(
      "INSERT INTO speaker_profiles (id, user_id, display_name, bio, headshot_stored_file_id, created_at, updated_at) VALUES (?, ?, 'Shared Speaker', 'Shared bio', ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      sharedSpeakerUserId,
      sharedHeadshotFileId,
      now,
      now,
    ),
    testEnvironment.DB.prepare(
      "INSERT INTO speaker_profiles (id, user_id, display_name, bio, created_at, updated_at) VALUES (?, ?, 'Other Speaker', 'Other bio', ?, ?)",
    ).bind(crypto.randomUUID(), otherSpeakerUserId, now, now),
  ]);
  await testEnvironment.FILES.put(
    sharedHeadshotObjectKey,
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  );
  return {
    first: seeded[0]?.programItemId ?? "",
    second: seeded[1]?.programItemId ?? "",
    third: seeded[2]?.programItemId ?? "",
    firstSubmission: seeded[0]?.submissionId ?? "",
  };
}

async function seedAgendaFixture(
  slug: string,
  owner: { cookie: string; userId: string },
  itemCount: number,
  speakersPerItem: number,
  eventDate = "2028-08-10",
  eventEndDate = eventDate,
) {
  await expectOk(
    "events.create",
    {
      name: slug,
      slug,
      startsOn: eventDate,
      endsOn: eventEndDate,
      timezone: "Europe/Berlin",
    },
    owner.cookie,
  );
  const track = getResult(
    (await callTrpc("tracks.create", { slug, name: "Track" }, owner.cookie))
      .body,
    idSchema,
  );
  const room = getResult(
    (await callTrpc("rooms.create", { slug, name: "Room" }, owner.cookie)).body,
    idSchema,
  );
  const event = await testEnvironment.DB.prepare(
    "SELECT id FROM events WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string }>();
  if (!event) throw new Error("Event fixture missing.");
  const now = Date.now();
  const cfpId = crypto.randomUUID();
  await testEnvironment.DB.batch([
    testEnvironment.DB.prepare(
      "INSERT INTO cfps (id, event_id, name, deadline, status, formats_json, custom_fields_json, structure_locked_at, created_at, updated_at) VALUES (?, ?, 'Agenda CFP', ?, 'open', '[\"Talk\"]', '[]', ?, ?, ?)",
    ).bind(cfpId, event.id, "2028-01-01T00:00:00.000Z", now, now, now),
    testEnvironment.DB.prepare(
      "INSERT INTO review_rounds (id, event_id, cfp_id, name, status, closed_at, created_at, updated_at) VALUES (?, ?, ?, 'Agenda review', 'closed', ?, ?, ?)",
    ).bind(crypto.randomUUID(), event.id, cfpId, now, now, now),
  ]);
  const programItemIds: string[] = [];
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const submissionId = crypto.randomUUID();
    const programItemId = crypto.randomUUID();
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "INSERT INTO submissions (id, event_id, cfp_id, cfp_revision, owner_user_id, client_draft_id, track_id, title, abstract, format, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Talk', 'active', ?, ?)",
      ).bind(
        submissionId,
        event.id,
        cfpId,
        now,
        owner.userId,
        crypto.randomUUID(),
        track.id,
        `Session ${itemIndex + 1}`,
        `Session ${itemIndex + 1} abstract`,
        now,
        now,
      ),
      testEnvironment.DB.prepare(
        "INSERT INTO decisions (id, submission_id, status, revision, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)",
      ).bind(crypto.randomUUID(), submissionId, now, now),
    ]);
    for (
      let speakerIndex = 0;
      speakerIndex < speakersPerItem;
      speakerIndex += 1
    ) {
      await testEnvironment.DB.prepare(
        "INSERT INTO submission_speakers (id, submission_id, invited_name, invited_email, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          crypto.randomUUID(),
          submissionId,
          `Speaker ${itemIndex + 1}-${speakerIndex + 1}`,
          `speaker-${itemIndex + 1}-${speakerIndex + 1}@example.com`,
          speakerIndex,
          now,
          now,
        )
        .run();
    }
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "UPDATE decisions SET status = 'accepted', revision = 1, updated_at = ? WHERE submission_id = ?",
      ).bind(now, submissionId),
      testEnvironment.DB.prepare(
        "INSERT INTO program_items (id, event_id, submission_id, created_at) VALUES (?, ?, ?, ?)",
      ).bind(programItemId, event.id, submissionId, now),
    ]);
    programItemIds.push(programItemId);
  }
  return { programItemIds, roomId: room.id, trackId: track.id };
}
