import { describe, expect, test } from "vitest";

import type { CfpFormContract } from "../src/shared/cfps";

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
    await callTrpc("events.create", eventInput, owner.cookie);

    expect(
      (await callTrpc("tracks.create", { slug, name: "Web" })).status,
    ).toBe(401);
    expect(
      (await callTrpc("tracks.create", { slug, name: "Web" }, unrelated.cookie))
        .status,
    ).toBe(404);

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
          "rooms.update",
          { slug, roomId: room.id, name: "Auditorium" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);

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
          { ...draftInput, cfpId: draft.id, name: "Speak with us" },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await callTrpc("cfps.open", { slug, cfpId: draft.id }, unrelated.cookie))
        .status,
    ).toBe(404);
    expect(
      (await callTrpc("cfps.open", { slug, cfpId: draft.id }, owner.cookie))
        .status,
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
      name: "Speak with us",
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

    const secondDraft = getResult(
      (
        await callTrpc<{ id: string }>(
          "cfps.createDraft",
          { ...draftInput, name: "Second CFP" },
          owner.cookie,
        )
      ).body,
    );
    const secondOpen = await callTrpc(
      "cfps.open",
      { slug, cfpId: secondDraft.id },
      owner.cookie,
    );
    expect(secondOpen.status).toBe(409);

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
  });
});
