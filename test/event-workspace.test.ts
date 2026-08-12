import { describe, expect, test } from "vitest";
import { z } from "zod";

import { eventSchema } from "../src/shared/events";

import { callTrpc, getResult, signIn, testEnvironment } from "./support";

const workspaceSchema = z.object({
  event: eventSchema,
  attention: z.array(
    z.object({
      key: z.string(),
      severity: z.enum(["critical", "warning"]),
      href: z.string(),
    }),
  ),
  reviewer: z
    .object({
      roundStatus: z.string(),
      remaining: z.number(),
      assigned: z.number(),
      cfpDeadline: z.string().nullable(),
    })
    .nullable(),
  statuses: z.array(z.object({ key: z.string(), href: z.string() })),
});

describe("event workspace", () => {
  test("shows owner action state and exact working routes", async () => {
    const owner = await signIn("workspace-owner@example.com");
    await createEvent(owner.cookie, "workspace-owner-event");

    const response = await callTrpc(
      "events.workspace",
      { slug: "workspace-owner-event" },
      owner.cookie,
      "query",
    );

    expect(response.status).toBe(200);
    const workspace = getResult(response.body, workspaceSchema);
    expect(workspace.event.permissions).toEqual(["organizer", "reviewer"]);
    expect(workspace.attention).toContainEqual(
      expect.objectContaining({
        key: "cfp",
        href: "/events/workspace-owner-event/cfp/manage",
      }),
    );
    expect(workspace.statuses.map((status) => status.key)).toEqual([
      "cfp",
      "review",
      "agenda",
      "readiness",
      "team",
      "communications",
    ]);
  });

  test("keeps additive organizer and reviewer permissions", async () => {
    const owner = await signIn("workspace-role-owner@example.com");
    const member = await signIn("workspace-role-member@example.com");
    await createEvent(owner.cookie, "workspace-additive-event");
    const event = await testEnvironment.DB.prepare(
      "SELECT id FROM events WHERE slug = ?",
    )
      .bind("workspace-additive-event")
      .first<{ id: string }>();
    expect(event).toBeTruthy();
    const now = Date.now();
    for (const role of ["organizer", "reviewer"] as const) {
      await testEnvironment.DB.prepare(
        `INSERT INTO event_roles
         (id, event_id, user_id, role, granted_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          event?.id,
          member.userId,
          role,
          owner.userId,
          now,
        )
        .run();
    }

    const listResponse = await callTrpc(
      "events.list",
      undefined,
      member.cookie,
      "query",
    );
    const events = getResult(listResponse.body, eventSchema.array());
    expect(events[0]?.access).toBe("organizer");
    expect(events[0]?.permissions.toSorted()).toEqual([
      "organizer",
      "reviewer",
    ]);

    const workspaceResponse = await callTrpc(
      "events.workspace",
      { slug: "workspace-additive-event" },
      member.cookie,
      "query",
    );
    const workspace = getResult(workspaceResponse.body, workspaceSchema);
    expect(workspace.reviewer).not.toBeNull();
    expect(workspace.statuses).toHaveLength(5);
  });

  test("limits pure reviewers to their review state", async () => {
    const owner = await signIn("workspace-review-owner@example.com");
    const reviewer = await signIn("workspace-reviewer@example.com");
    await createEvent(owner.cookie, "workspace-review-event");
    const event = await testEnvironment.DB.prepare(
      "SELECT id FROM events WHERE slug = ?",
    )
      .bind("workspace-review-event")
      .first<{ id: string }>();
    await testEnvironment.DB.prepare(
      `INSERT INTO event_roles
       (id, event_id, user_id, role, granted_by_user_id, created_at)
       VALUES (?, ?, ?, 'reviewer', ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        event?.id,
        reviewer.userId,
        owner.userId,
        Date.now(),
      )
      .run();

    const response = await callTrpc(
      "events.workspace",
      { slug: "workspace-review-event" },
      reviewer.cookie,
      "query",
    );
    const workspace = getResult(response.body, workspaceSchema);
    expect(workspace.event.permissions).toEqual(["reviewer"]);
    expect(workspace.attention).toEqual([]);
    expect(workspace.statuses).toEqual([]);
    expect(workspace.reviewer).toMatchObject({ assigned: 0, remaining: 0 });
  });

  test("scopes reviewer Home to the current review round", async () => {
    const owner = await signIn("workspace-round-owner@example.com");
    const reviewer = await signIn("workspace-round-reviewer@example.com");
    await createEvent(owner.cookie, "workspace-round-event");
    const event = await eventId("workspace-round-event");
    const now = Date.now();
    const trackId = crypto.randomUUID();
    await testEnvironment.DB.prepare(
      `INSERT INTO event_roles
       (id, event_id, user_id, role, granted_by_user_id, created_at)
       VALUES (?, ?, ?, 'reviewer', ?, ?)`,
    )
      .bind(crypto.randomUUID(), event, reviewer.userId, owner.userId, now)
      .run();
    await testEnvironment.DB.prepare(
      `INSERT INTO tracks
       (id, event_id, name, position, created_at, updated_at)
       VALUES (?, ?, 'Workspace track', 0, ?, ?)`,
    )
      .bind(trackId, event, now, now)
      .run();

    await insertReviewRound({
      eventId: event,
      ownerUserId: owner.userId,
      reviewerUserId: reviewer.userId,
      trackId,
      status: "open",
      deadline: "2027-09-01T00:00:00Z",
      createdAt: now,
    });
    await insertReviewRound({
      eventId: event,
      ownerUserId: owner.userId,
      reviewerUserId: reviewer.userId,
      trackId,
      status: "draft",
      deadline: "2027-09-15T00:00:00Z",
      createdAt: now + 1,
    });

    const response = await callTrpc(
      "events.workspace",
      { slug: "workspace-round-event" },
      reviewer.cookie,
      "query",
    );
    const workspace = getResult(response.body, workspaceSchema);
    expect(workspace.reviewer).toEqual({
      roundStatus: "open",
      remaining: 1,
      assigned: 1,
      cfpDeadline: "2027-09-01T00:00:00Z",
    });
  });

  test("links queued decisions to their review page", async () => {
    const owner = await signIn("workspace-decision-owner@example.com");
    await createEvent(owner.cookie, "workspace-decision-event");
    const event = await eventId("workspace-decision-event");
    const now = Date.now();
    await testEnvironment.DB.prepare(
      `INSERT INTO event_roles
       (id, event_id, user_id, role, granted_by_user_id, created_at)
       VALUES (?, ?, ?, 'reviewer', ?, ?)`,
    )
      .bind(crypto.randomUUID(), event, owner.userId, owner.userId, now)
      .run();
    await insertReviewRound({
      eventId: event,
      ownerUserId: owner.userId,
      reviewerUserId: owner.userId,
      trackId: await insertTrack(event, now),
      status: "open",
      deadline: "2027-09-01T00:00:00Z",
      createdAt: now,
    });
    await testEnvironment.DB.prepare(
      `UPDATE decisions SET status = 'accept_queued'
       WHERE submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
    )
      .bind(event)
      .run();

    const workspace = getResult(
      (
        await callTrpc(
          "events.workspace",
          { slug: "workspace-decision-event" },
          owner.cookie,
          "query",
        )
      ).body,
      workspaceSchema,
    );
    expect(workspace.attention).toContainEqual(
      expect.objectContaining({
        key: "decisions",
        href: "/events/workspace-decision-event/review/decisions",
      }),
    );
  });

  test("separates active and expired team invitations", async () => {
    const owner = await signIn("workspace-invite-owner@example.com");
    await createEvent(owner.cookie, "workspace-invite-event");
    const event = await eventId("workspace-invite-event");
    const now = Date.now();
    for (const [email, expiresAt] of [
      ["active@example.com", now + 60_000],
      ["expired@example.com", now - 60_000],
    ] as const) {
      await testEnvironment.DB.prepare(
        `INSERT INTO invitations
         (id, event_id, email, role, secret_hash, status, invited_by_user_id,
          expires_at, created_at)
         VALUES (?, ?, ?, 'organizer', ?, 'pending', ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          event,
          email,
          crypto.randomUUID(),
          owner.userId,
          expiresAt,
          now,
        )
        .run();
    }

    const response = await callTrpc(
      "events.workspace",
      { slug: "workspace-invite-event" },
      owner.cookie,
      "query",
    );
    const workspace = getResult(response.body, workspaceSchema);
    expect(workspace.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "team", severity: "warning" }),
        expect.objectContaining({ key: "team-expired", severity: "critical" }),
      ]),
    );
  });
});

async function createEvent(cookie: string, slug: string) {
  const response = await callTrpc(
    "events.create",
    {
      name: slug.replaceAll("-", " "),
      slug,
      startsOn: "2027-10-01",
      endsOn: "2027-10-03",
      timezone: "UTC",
    },
    cookie,
  );
  expect(response.status).toBe(200);
}

async function eventId(slug: string) {
  const event = await testEnvironment.DB.prepare(
    "SELECT id FROM events WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string }>();
  expect(event).toBeTruthy();
  return event?.id as string;
}

async function insertTrack(eventId: string, now: number): Promise<string> {
  const trackId = crypto.randomUUID();
  await testEnvironment.DB.prepare(
    `INSERT INTO tracks
     (id, event_id, name, position, created_at, updated_at)
     VALUES (?, ?, 'Workspace track', 0, ?, ?)`,
  )
    .bind(trackId, eventId, now, now)
    .run();
  return trackId;
}

async function insertReviewRound(input: {
  eventId: string;
  ownerUserId: string;
  reviewerUserId: string;
  trackId: string;
  status: "draft" | "open";
  deadline: string;
  createdAt: number;
}) {
  const cfpId = crypto.randomUUID();
  const roundId = crypto.randomUUID();
  const submissionId = crypto.randomUUID();
  await testEnvironment.DB.prepare(
    `INSERT INTO cfps
     (id, event_id, name, deadline, status, formats_json, custom_fields_json,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '["Talk"]', '[]', ?, ?)`,
  )
    .bind(
      cfpId,
      input.eventId,
      `${input.status} CFP`,
      input.deadline,
      input.status,
      input.createdAt,
      input.createdAt,
    )
    .run();
  await testEnvironment.DB.prepare(
    `INSERT INTO review_rounds
     (id, event_id, cfp_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      roundId,
      input.eventId,
      cfpId,
      `${input.status} round`,
      input.status,
      input.createdAt,
      input.createdAt,
    )
    .run();
  if (input.status === "draft") return;
  await testEnvironment.DB.prepare(
    `INSERT INTO submissions
     (id, event_id, cfp_id, cfp_revision, owner_user_id, client_draft_id,
      track_id, title, abstract, format, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Workspace abstract', 'Talk', 'active', ?, ?)`,
  )
    .bind(
      submissionId,
      input.eventId,
      cfpId,
      input.createdAt,
      input.ownerUserId,
      crypto.randomUUID(),
      input.trackId,
      `${input.status} submission`,
      input.createdAt,
      input.createdAt,
    )
    .run();
  await testEnvironment.DB.prepare(
    `INSERT INTO decisions
     (id, submission_id, status, revision, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?)`,
  )
    .bind(crypto.randomUUID(), submissionId, input.createdAt, input.createdAt)
    .run();
  await testEnvironment.DB.prepare(
    `INSERT INTO reviewer_assignments
     (id, event_id, review_round_id, submission_id, reviewer_user_id,
      assigned_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      input.eventId,
      roundId,
      submissionId,
      input.reviewerUserId,
      input.ownerUserId,
      input.createdAt,
    )
    .run();
}
