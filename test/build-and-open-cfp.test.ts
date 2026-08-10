import { describe, expect, test } from "vitest";

import { visibleCustomFields, type CfpFormContract } from "../src/shared/cfps";

import { callTrpc, getResult, signIn, testEnvironment } from "./support";

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
      (
        await callTrpc<{ id: string }>(
          "events.create",
          eventInput,
          owner.cookie,
        )
      ).body,
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
      (
        await callTrpc<{ id: string; name: string }>(
          "tracks.create",
          { slug, name: "Web" },
          owner.cookie,
        )
      ).body,
    );
    const data = getResult(
      (
        await callTrpc<{ id: string; name: string }>(
          "tracks.create",
          { slug, name: "Data" },
          owner.cookie,
        )
      ).body,
    );
    expect(
      (await callTrpc("tracks.create", { slug, name: "web" }, owner.cookie))
        .status,
    ).toBe(409);
    const archived = getResult(
      (
        await callTrpc<{ id: string; name: string }>(
          "tracks.create",
          { slug, name: "Archive me" },
          owner.cookie,
        )
      ).body,
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
        await callTrpc<{ id: string }>(
          "rooms.create",
          { slug, name: "Main hall" },
          owner.cookie,
        )
      ).body,
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
      (
        await callTrpc<{ position: number }[]>(
          "rooms.list",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
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
        {
          key: "outline",
          label: "Session outline",
          type: "file",
          required: false,
          acceptedTypes: ["application/pdf"],
          maxSizeMb: 10,
        },
      ],
    } as const;
    const draftResponse = await callTrpc<{ id: string; status: string }>(
      "cfps.createDraft",
      draftInput,
      owner.cookie,
    );
    expect(draftResponse.status).toBe(200);
    const draft = getResult(draftResponse.body);
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
    expect(
      (
        await callTrpc(
          "cfps.open",
          { ...draftInput, cfpId: draft.id, name: "Speak with us" },
          unrelated.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await callTrpc(
          "cfps.open",
          { ...draftInput, cfpId: draft.id, name: "Speak with us" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "cfps.open",
          { ...draftInput, cfpId: draft.id, name: "Ignored repeat" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);

    const publicResponse = await callTrpc<CfpFormContract>(
      "cfps.publicByEventSlug",
      { slug },
      undefined,
      "query",
    );
    expect(publicResponse.status).toBe(200);
    const publicForm = getResult(publicResponse.body);
    expect(publicForm).toMatchObject({
      event: { name: eventInput.name, slug },
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
    expect(publicForm.customFields).toEqual(draftInput.customFields);
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
        await callTrpc<{ id: string }>(
          "cfps.createDraft",
          { ...draftInput, name: "Second CFP" },
          owner.cookie,
        )
      ).body,
    );
    const setup = getResult(
      (
        await callTrpc<{
          draft: { id: string } | null;
          open: { id: string; name: string } | null;
        }>("cfps.getSetup", { slug }, owner.cookie, "query")
      ).body,
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
        await callTrpc<{ id: string }>(
          "cfps.createDraft",
          { ...draftInput, slug: noTrackSlug, name: "No tracks yet" },
          owner.cookie,
        )
      ).body,
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
        await callTrpc<{ id: string }>(
          "tracks.create",
          { slug: noTrackSlug, name: "Only track" },
          owner.cookie,
        )
      ).body,
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
