import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  cfpFormContractSchema,
  cfpSchema,
  visibleCustomFields,
} from "../src/shared/cfps";

import { callTrpc, getResult, signIn, testEnvironment } from "./support";

const eventOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
});

describe("build and open a conditional CFP", () => {
  test("publishes one typed form while protecting organizer setup", async () => {
    const slug = "conditional-cfp-2027";
    const eventInput = {
      name: "Conditional CFP Conference",
      slug,
      startsOn: "2027-08-10",
      endsOn: "2027-08-12",
      timezone: "Europe/Berlin",
    };
    const owner = await signIn("cfp-owner@example.com", "192.0.2.30");
    const unrelated = await signIn("cfp-unrelated@example.com", "192.0.2.31");
    const organizer = await signIn("cfp-organizer@example.com", "192.0.2.32");
    const reviewer = await signIn("cfp-reviewer@example.com", "192.0.2.33");
    const event = getResult(
      (await callTrpc("events.create", eventInput, owner.cookie)).body,
      z.object({ id: z.string() }),
    );

    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        `INSERT INTO event_roles
          (id, event_id, user_id, role, granted_by_user_id, created_at)
         VALUES (?, ?, ?, 'organizer', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        event.id,
        organizer.userId,
        owner.userId,
        Date.now(),
      ),
      testEnvironment.DB.prepare(
        `INSERT INTO event_roles
          (id, event_id, user_id, role, granted_by_user_id, created_at)
         VALUES (?, ?, ?, 'reviewer', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        event.id,
        reviewer.userId,
        owner.userId,
        Date.now(),
      ),
    ]);

    expect(
      (await callTrpc("tracks.create", { slug, name: "Web" })).status,
    ).toBe(401);
    expect(
      (await callTrpc("tracks.create", { slug, name: "Web" }, unrelated.cookie))
        .status,
    ).toBe(404);
    expect(
      (await callTrpc("tracks.create", { slug, name: "Web" }, reviewer.cookie))
        .status,
    ).toBe(404);
    expect(
      (await callTrpc("cfps.getSetup", { slug }, reviewer.cookie, "query"))
        .status,
    ).toBe(404);
    expect(
      (await callTrpc("tracks.list", { slug }, reviewer.cookie, "query"))
        .status,
    ).toBe(404);
    expect(
      (await callTrpc("rooms.list", { slug }, reviewer.cookie, "query")).status,
    ).toBe(404);
    expect(
      (
        await callTrpc(
          "rooms.create",
          { slug, name: "Breakout" },
          organizer.cookie,
        )
      ).status,
    ).toBe(200);

    const web = getResult(
      (await callTrpc("tracks.create", { slug, name: "Web" }, owner.cookie))
        .body,
      eventOptionSchema,
    );
    const data = getResult(
      (await callTrpc("tracks.create", { slug, name: "Data" }, owner.cookie))
        .body,
      eventOptionSchema,
    );
    expect(
      (await callTrpc("tracks.create", { slug, name: "web" }, owner.cookie))
        .status,
    ).toBe(409);
    const archived = getResult(
      (
        await callTrpc(
          "tracks.create",
          { slug, name: "Archive me" },
          owner.cookie,
        )
      ).body,
      eventOptionSchema,
    );
    expect(
      (
        await callTrpc(
          "tracks.update",
          { slug, trackId: web.id, name: "Web platform" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "tracks.reorder",
          { slug, orderedIds: [data.id, web.id, archived.id] },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "tracks.archive",
          { slug, trackId: archived.id },
          owner.cookie,
        )
      ).status,
    ).toBe(200);

    const room = getResult(
      (
        await callTrpc(
          "rooms.create",
          { slug, name: "Main hall" },
          owner.cookie,
        )
      ).body,
      eventOptionSchema,
    );
    expect(
      (
        await callTrpc(
          "rooms.create",
          { slug, name: "MAIN HALL" },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "rooms.update",
          { slug, roomId: room.id, name: "Auditorium" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    const concurrentRooms = await Promise.all([
      callTrpc(
        "rooms.create",
        { slug, name: "Concurrent room A" },
        owner.cookie,
      ),
      callTrpc(
        "rooms.create",
        { slug, name: "Concurrent room B" },
        owner.cookie,
      ),
    ]);
    expect(concurrentRooms.map((response) => response.status)).toEqual([
      200, 200,
    ]);
    const listedRooms = getResult(
      (await callTrpc("rooms.list", { slug }, owner.cookie, "query")).body,
      z.array(eventOptionSchema),
    );
    expect(
      new Set(listedRooms.map((listedRoom) => listedRoom.position)).size,
    ).toBe(listedRooms.length);

    const draftInput = {
      slug,
      name: "Speak at Conditional CFP",
      deadline: "2027-04-30T21:59:00Z",
      formats: ["Talk", "Workshop"],
      customFields: [
        {
          key: "audience",
          label: "Who is this for?",
          type: "single_select",
          required: true,
          options: ["Beginner", "Experienced"],
        },
        {
          key: "workshop_requirements",
          label: "Workshop requirements",
          type: "long_text",
          required: true,
          condition: { fieldKey: "audience", equals: "Experienced" },
        },
      ],
    } as const;
    expect(
      (
        await callTrpc(
          "cfps.createDraft",
          {
            ...draftInput,
            deadline: "2027-08-13T10:00:00Z",
            name: "Deadline after event",
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await callTrpc(
          "cfps.createDraft",
          {
            ...draftInput,
            deadline: "2020-01-01T09:00:00Z",
            name: "Expired draft",
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);
    const draftResponse = await callTrpc(
      "cfps.createDraft",
      draftInput,
      owner.cookie,
    );
    expect(draftResponse.status).toBe(200);
    const draft = getResult(draftResponse.body, cfpSchema);
    expect(draft.status).toBe("draft");
    expect(
      (await callTrpc("cfps.createDraft", draftInput, reviewer.cookie)).status,
    ).toBe(404);
    expect(
      (
        await callTrpc(
          "cfps.createDraft",
          { ...draftInput, name: "Duplicate draft" },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    const invalidCondition = await callTrpc(
      "cfps.updateDraft",
      {
        ...draftInput,
        cfpId: draft.id,
        customFields: [
          {
            key: "details",
            label: "Details",
            type: "short_text",
            required: false,
            condition: { fieldKey: "missing", equals: "Yes" },
          },
        ],
      },
      owner.cookie,
    );
    expect(invalidCondition.status).toBe(400);
    expect(
      (
        await callTrpc(
          "cfps.updateDraft",
          {
            ...draftInput,
            cfpId: draft.id,
            deadline: "2020-01-01T09:00:00Z",
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await callTrpc(
          "cfps.updateDraft",
          {
            ...draftInput,
            cfpId: draft.id,
            customFields: [
              {
                key: "title",
                label: "Replacement title",
                type: "short_text",
                required: false,
              },
            ],
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await callTrpc(
          "cfps.updateDraft",
          { ...draftInput, cfpId: draft.id, name: "Saved draft" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    const fieldsWithFile = [
      ...draftInput.customFields,
      {
        key: "outline",
        label: "Session outline",
        type: "file",
        required: false,
        acceptedTypes: ["application/pdf"],
        maxSizeMb: 10,
      },
    ];
    expect(
      (
        await callTrpc(
          "cfps.open",
          {
            ...draftInput,
            cfpId: draft.id,
            name: "Speak with us",
            customFields: fieldsWithFile,
          },
          unrelated.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await callTrpc(
          "cfps.open",
          {
            ...draftInput,
            cfpId: draft.id,
            name: "Speak with us",
            customFields: fieldsWithFile,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "cfps.open",
          {
            ...draftInput,
            cfpId: draft.id,
            name: "Ignored repeat",
            customFields: fieldsWithFile,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);

    const publicResponse = await callTrpc(
      "cfps.publicByEventSlug",
      { slug },
      undefined,
      "query",
    );
    expect(publicResponse.status).toBe(200);
    const publicForm = getResult(publicResponse.body, cfpFormContractSchema);
    expect(publicForm).toMatchObject({
      event: {
        name: eventInput.name,
        slug,
        startsOn: eventInput.startsOn,
        endsOn: eventInput.endsOn,
        timezone: eventInput.timezone,
      },
      name: "Ignored repeat",
      deadline: draftInput.deadline,
      coreFields: {
        title: { required: true },
        abstract: { required: true },
        proposedSpeakers: { required: true },
      },
      formats: ["Talk", "Workshop"],
      tracks: [
        { id: data.id, name: "Data" },
        { id: web.id, name: "Web platform" },
      ],
    });
    expect(publicForm.customFields).toEqual(fieldsWithFile);
    const selectedTrack = publicForm.tracks.find(
      (track) => track.id === data.id,
    );
    expect(selectedTrack?.name).toBe("Data");
    expect(
      visibleCustomFields(publicForm.customFields, {
        audience: "Beginner",
      }).map((field) => field.key),
    ).toEqual(["audience", "outline"]);
    expect(
      visibleCustomFields(publicForm.customFields, {
        audience: "Experienced",
      }).find((field) => field.key === "workshop_requirements"),
    ).toMatchObject({ required: true });
    expect(
      (
        await callTrpc(
          "cfps.updateDraft",
          { ...draftInput, cfpId: draft.id, name: "Edited while open" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "tracks.archive",
          { slug, trackId: data.id },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "tracks.archive",
          { slug, trackId: web.id },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    const secondDraft = getResult(
      (
        await callTrpc(
          "cfps.createDraft",
          { ...draftInput, name: "Second CFP" },
          owner.cookie,
        )
      ).body,
      cfpSchema,
    );
    await testEnvironment.DB.prepare(
      "UPDATE cfps SET deadline = ? WHERE id = ?",
    )
      .bind("2020-01-01T09:00:45.678Z", secondDraft.id)
      .run();
    const renamedExpiredDraft = getResult(
      (
        await callTrpc(
          "cfps.updateDraft",
          {
            ...secondDraft,
            cfpId: secondDraft.id,
            deadline: "2020-01-01T09:00:00Z",
            slug,
            name: "Renamed expired draft",
          },
          owner.cookie,
        )
      ).body,
      cfpSchema,
    );
    expect(renamedExpiredDraft.deadline).toBe("2020-01-01T09:00:45.678Z");
    expect(
      await testEnvironment.DB.prepare("SELECT deadline FROM cfps WHERE id = ?")
        .bind(secondDraft.id)
        .first(),
    ).toEqual({ deadline: "2020-01-01T09:00:45.678Z" });

    expect(
      (
        await callTrpc(
          "cfps.updateDraft",
          {
            ...secondDraft,
            cfpId: secondDraft.id,
            deadline: "2020-01-02T09:00:00Z",
            slug,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);

    const futureDeadline = "2027-05-01T09:00:00Z";
    const rescheduledDraft = getResult(
      (
        await callTrpc(
          "cfps.updateDraft",
          {
            ...secondDraft,
            cfpId: secondDraft.id,
            deadline: futureDeadline,
            slug,
            name: "Rescheduled draft",
          },
          owner.cookie,
        )
      ).body,
      cfpSchema,
    );
    expect(rescheduledDraft.deadline).toBe(futureDeadline);
    await testEnvironment.DB.prepare(
      "UPDATE cfps SET deadline = ? WHERE id = ?",
    )
      .bind("2020-01-01T09:00:45.678Z", secondDraft.id)
      .run();

    const concurrentDeadlineUpdates = await Promise.all([
      callTrpc(
        "cfps.updateDraft",
        {
          ...secondDraft,
          cfpId: secondDraft.id,
          deadline: futureDeadline,
          slug,
          name: "Rescheduled draft",
        },
        owner.cookie,
      ),
      callTrpc(
        "cfps.updateDraft",
        {
          ...secondDraft,
          cfpId: secondDraft.id,
          deadline: "2020-01-01T09:00:00Z",
          slug,
          name: "Stale draft edit",
        },
        owner.cookie,
      ),
    ]);
    expect(
      concurrentDeadlineUpdates.every(({ status }) =>
        [200, 400, 409].includes(status),
      ),
    ).toBe(true);
    expect(concurrentDeadlineUpdates[0]?.status).toBe(200);
    expect(
      await testEnvironment.DB.prepare("SELECT deadline FROM cfps WHERE id = ?")
        .bind(secondDraft.id)
        .first(),
    ).toEqual({ deadline: futureDeadline });
    const setup = getResult(
      (await callTrpc("cfps.getSetup", { slug }, owner.cookie, "query")).body,
      z.object({ draft: cfpSchema.nullable(), open: cfpSchema.nullable() }),
    );
    expect(setup).toMatchObject({
      draft: { id: secondDraft.id },
      open: { id: draft.id, name: "Edited while open" },
    });
    const secondOpen = await callTrpc(
      "cfps.open",
      { ...draftInput, slug, cfpId: secondDraft.id, name: "Second CFP" },
      owner.cookie,
    );
    expect(secondOpen.status).toBe(409);
    expect(
      (
        await callTrpc(
          "tracks.archive",
          { slug, trackId: crypto.randomUUID() },
          owner.cookie,
        )
      ).status,
    ).toBe(404);

    const noTrackSlug = "no-track-cfp-2027";
    await callTrpc(
      "events.create",
      { ...eventInput, name: "No Track Event", slug: noTrackSlug },
      owner.cookie,
    );
    const noTrackDraft = getResult(
      (
        await callTrpc(
          "cfps.createDraft",
          { ...draftInput, slug: noTrackSlug, name: "No tracks yet" },
          owner.cookie,
        )
      ).body,
      cfpSchema,
    );
    expect(
      (
        await callTrpc(
          "cfps.publicByEventSlug",
          { slug: noTrackSlug },
          undefined,
          "query",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await callTrpc(
          "cfps.open",
          {
            ...draftInput,
            slug: noTrackSlug,
            cfpId: noTrackDraft.id,
            name: "No tracks yet",
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);
    const soleTrack = getResult(
      (
        await callTrpc(
          "tracks.create",
          { slug: noTrackSlug, name: "Only track" },
          owner.cookie,
        )
      ).body,
      eventOptionSchema,
    );
    const [raceOpen, raceArchive] = await Promise.all([
      callTrpc(
        "cfps.open",
        {
          ...draftInput,
          slug: noTrackSlug,
          cfpId: noTrackDraft.id,
          name: "Race-safe CFP",
        },
        owner.cookie,
      ),
      callTrpc(
        "tracks.archive",
        { slug: noTrackSlug, trackId: soleTrack.id },
        owner.cookie,
      ),
    ]);
    expect([raceOpen.status, raceArchive.status]).not.toEqual([200, 200]);
    expect(
      (
        await callTrpc(
          "cfps.open",
          {
            ...draftInput,
            slug: noTrackSlug,
            cfpId: noTrackDraft.id,
            deadline: "2020-01-01T00:00:00Z",
            name: "Past deadline",
          },
          owner.cookie,
        )
      ).status,
    ).toBe(400);

    await testEnvironment.DB.prepare(
      "UPDATE cfps SET structure_locked_at = ? WHERE id = ?",
    )
      .bind(Date.now(), secondDraft.id)
      .run();
    const lockedEdit = await callTrpc(
      "cfps.updateDraft",
      {
        ...draftInput,
        cfpId: secondDraft.id,
        customFields: [],
      },
      owner.cookie,
    );
    expect(lockedEdit.status).toBe(409);
    expect(
      (
        await callTrpc(
          "tracks.create",
          { slug, name: "Locked track" },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "tracks.update",
          { slug, trackId: web.id, name: "Locked rename" },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "tracks.reorder",
          { slug, orderedIds: [web.id] },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
  });
});
