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
      deadline: z.string().nullable(),
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
        href: "/events/workspace-owner-event/cfp/setup",
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
    expect(events[0]).toMatchObject({
      access: "organizer",
      permissions: ["organizer", "reviewer"],
    });

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
