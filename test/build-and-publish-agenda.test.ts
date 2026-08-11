import { describe, expect, test } from "vitest";
import { z } from "zod";

import { callTrpc, getResult, signIn, testEnvironment } from "./support";

const idSchema = z.object({ id: z.string() });
const workingAgendaSchema = z.object({
  revision: z.number(),
  rooms: z.array(z.object({ id: z.string(), name: z.string() })),
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
      speakers: z.array(z.object({ displayName: z.string() })),
    }),
  ),
});

describe("build and publish an agenda", () => {
  test("corrects conflicts and publishes immutable public revisions", async () => {
    const slug = "agenda-flow-2027";
    const owner = await signIn("agenda-owner@example.com");
    const organizer = await signIn("agenda-organizer@example.com");
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

    expect(
      (await callTrpc("agendas.working", { slug }, outsider.cookie, "query"))
        .status,
    ).toBe(404);
    expect(
      (await callTrpc("agendas.working", { slug }, organizer.cookie, "query"))
        .status,
    ).toBe(200);
    expect(
      (await callTrpc("agendas.published", { slug }, undefined, "query"))
        .status,
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
    expect(firstPublication.status).toBe(200);
    let published = await getPublished(slug);
    expect(published.revision).toBe(1);
    expect(published.items.map((item) => item.title)).toEqual([
      "Opening systems",
      "Closing systems",
      "Lunch",
      "Independent systems",
    ]);
    expect(published.items[0]?.speakers[0]?.displayName).toBe("Shared Speaker");

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
  await testEnvironment.DB.batch([
    testEnvironment.DB.prepare(
      "INSERT INTO speaker_profiles (id, user_id, display_name, bio, created_at, updated_at) VALUES (?, ?, 'Shared Speaker', 'Shared bio', ?, ?)",
    ).bind(crypto.randomUUID(), sharedSpeakerUserId, now, now),
    testEnvironment.DB.prepare(
      "INSERT INTO speaker_profiles (id, user_id, display_name, bio, created_at, updated_at) VALUES (?, ?, 'Other Speaker', 'Other bio', ?, ?)",
    ).bind(crypto.randomUUID(), otherSpeakerUserId, now, now),
  ]);
  return {
    first: seeded[0]?.programItemId ?? "",
    second: seeded[1]?.programItemId ?? "",
    third: seeded[2]?.programItemId ?? "",
    firstSubmission: seeded[0]?.submissionId ?? "",
  };
}
