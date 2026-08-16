import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/database/client";
import { createAuth } from "../src/server/identity/auth";
import { eventSchema } from "../src/shared/events";

import {
  callTrpc,
  getResult,
  signIn,
  testEnvironment,
  workerFetch,
} from "./support";

describe("sign in and create an event", () => {
  test("persists an owner and working agenda while keeping the event private", async () => {
    const eventInput = {
      name: "Northstar Conference",
      slug: "northstar-2027",
      startsOn: "2027-05-12",
      endsOn: "2027-05-14",
      timezone: "Europe/London",
    };

    const unauthenticatedCreate = await callTrpc("events.create", eventInput);
    expect(unauthenticatedCreate.status).toBe(401);
    const unauthenticatedRead = await callTrpc(
      "events.get",
      { slug: eventInput.slug },
      undefined,
      "query",
    );
    expect(unauthenticatedRead.status).toBe(401);
    const unauthenticatedMutation = await callTrpc("events.rename", {
      slug: eventInput.slug,
      name: "Not signed in",
    });
    expect(unauthenticatedMutation.status).toBe(401);
    const unauthenticatedSettings = await callTrpc("events.updateSettings", {
      ...eventInput,
      expectedRevision: 1,
    });
    expect(unauthenticatedSettings.status).toBe(401);

    const owner = await signIn("owner@example.com");
    const invalidDates = await callTrpc(
      "events.create",
      { ...eventInput, startsOn: "2027-05-15" },
      owner.cookie,
    );
    expect(invalidDates.status).toBe(400);

    const pastDates = await callTrpc(
      "events.create",
      { ...eventInput, startsOn: "2000-01-05", endsOn: "2000-01-07" },
      owner.cookie,
    );
    expect(pastDates.status).toBe(400);

    const invalidTimezone = await callTrpc(
      "events.create",
      { ...eventInput, timezone: "London" },
      owner.cookie,
    );
    expect(invalidTimezone.status).toBe(400);

    const createdResponse = await callTrpc(
      "events.create",
      eventInput,
      owner.cookie,
    );
    expect(createdResponse.status).toBe(200);
    const created = getResult(createdResponse.body, eventSchema);
    expect(created).toMatchObject(eventInput);

    const persisted = await testEnvironment.DB.prepare(
      `SELECT events.owner_user_id AS ownerUserId, agendas.id AS agendaId
       FROM events INNER JOIN agendas ON agendas.event_id = events.id
       WHERE events.slug = ?`,
    )
      .bind(eventInput.slug)
      .first<{ ownerUserId: string; agendaId: string }>();
    expect(persisted).toEqual({
      ownerUserId: owner.userId,
      agendaId: created.agendaId,
    });

    const persistedRoles = await testEnvironment.DB.prepare(
      `SELECT role, user_id AS userId, granted_by_user_id AS grantedByUserId, revoked_at AS revokedAt
       FROM event_roles
       WHERE event_id = ?
       ORDER BY role`,
    )
      .bind(created.id)
      .all<{
        role: string;
        userId: string;
        grantedByUserId: string;
        revokedAt: number | null;
      }>();
    expect(persistedRoles.results).toEqual([
      {
        role: "organizer",
        userId: owner.userId,
        grantedByUserId: owner.userId,
        revokedAt: null,
      },
      {
        role: "reviewer",
        userId: owner.userId,
        grantedByUserId: owner.userId,
        revokedAt: null,
      },
    ]);

    const teamResponse = await callTrpc(
      "eventTeam.list",
      { slug: eventInput.slug },
      owner.cookie,
      "query",
    );
    expect(teamResponse.status).toBe(200);
    const team = getResult(
      teamResponse.body,
      z.object({
        owner: z.object({ id: z.string() }),
        roles: z.array(
          z.object({
            userId: z.string(),
            role: z.enum(["organizer", "reviewer"]),
          }),
        ),
      }),
    );
    expect(team.owner.id).toBe(owner.userId);
    expect(team.roles).toEqual([
      { userId: owner.userId, role: "organizer" },
      { userId: owner.userId, role: "reviewer" },
    ]);

    const reloaded = await callTrpc(
      "events.get",
      { slug: eventInput.slug },
      owner.cookie,
      "query",
    );
    expect(reloaded.status).toBe(200);
    expect(getResult(reloaded.body, eventSchema)).toEqual(created);

    const unrelated = await signIn("unrelated@example.com");
    const privateRead = await callTrpc(
      "events.get",
      { slug: eventInput.slug },
      unrelated.cookie,
      "query",
    );
    expect(privateRead.status).toBe(404);

    const privateMutation = await callTrpc(
      "events.rename",
      { slug: eventInput.slug, name: "Not theirs" },
      unrelated.cookie,
    );
    expect(privateMutation.status).toBe(404);
    const privateSettings = await callTrpc(
      "events.updateSettings",
      { ...eventInput, name: "Not theirs", expectedRevision: 1 },
      unrelated.cookie,
    );
    expect(privateSettings.status).toBe(404);

    const duplicate = await callTrpc(
      "events.create",
      eventInput,
      unrelated.cookie,
    );
    expect(duplicate.status).toBe(409);

    const renamed = await callTrpc(
      "events.rename",
      { slug: eventInput.slug, name: "Northstar 2027" },
      owner.cookie,
    );
    expect(renamed.status).toBe(200);
    expect(getResult(renamed.body, eventSchema)).toMatchObject({
      name: "Northstar 2027",
    });

    const updatedSettings = await callTrpc(
      "events.updateSettings",
      {
        ...eventInput,
        name: "Northstar Summit",
        startsOn: "2028-06-20",
        endsOn: "2028-06-22",
        timezone: "America/Toronto",
        expectedRevision: created.revision,
      },
      owner.cookie,
    );
    expect(updatedSettings.status).toBe(200);
    expect(getResult(updatedSettings.body, eventSchema)).toMatchObject({
      name: "Northstar Summit",
      startsOn: "2028-06-20",
      endsOn: "2028-06-22",
      timezone: "America/Toronto",
    });

    const updated = getResult(updatedSettings.body, eventSchema);
    const organizer = await signIn("settings-organizer@example.com");
    await testEnvironment.DB.prepare(
      `INSERT INTO event_roles
       (id, event_id, user_id, role, granted_by_user_id, created_at)
       VALUES (?, ?, ?, 'organizer', ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        created.id,
        organizer.userId,
        owner.userId,
        Date.now(),
      )
      .run();
    const organizerSettings = await callTrpc(
      "events.updateSettings",
      {
        ...eventInput,
        name: "Organizer-updated Summit",
        startsOn: "2028-07-01",
        endsOn: "2028-07-03",
        expectedRevision: updated.revision,
      },
      organizer.cookie,
    );
    expect(organizerSettings.status).toBe(200);

    const staleSettings = await callTrpc(
      "events.updateSettings",
      {
        ...eventInput,
        name: "Stale owner edit",
        expectedRevision: updated.revision,
      },
      owner.cookie,
    );
    expect(staleSettings.status).toBe(409);

    const reviewer = await signIn("settings-reviewer@example.com");
    await testEnvironment.DB.prepare(
      `INSERT INTO event_roles
       (id, event_id, user_id, role, granted_by_user_id, created_at)
       VALUES (?, ?, ?, 'reviewer', ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        created.id,
        reviewer.userId,
        owner.userId,
        Date.now(),
      )
      .run();
    const reviewerSettings = await callTrpc(
      "events.updateSettings",
      {
        ...eventInput,
        name: "Reviewer edit",
        expectedRevision: updated.revision + 1,
      },
      reviewer.cookie,
    );
    expect(reviewerSettings.status).toBe(404);

    const invalidSettings = await callTrpc(
      "events.updateSettings",
      {
        ...eventInput,
        startsOn: "2028-06-23",
        endsOn: "2028-06-22",
        expectedRevision: updated.revision + 1,
      },
      owner.cookie,
    );
    expect(invalidSettings.status).toBe(400);

    await testEnvironment.DB.prepare(
      `INSERT INTO agenda_items
       (id, agenda_id, event_id, kind, service_scope, service_title, starts_at_local, ends_at_local, created_at, updated_at)
       VALUES (?, ?, ?, 'service', 'event', 'Lunch', ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        created.agendaId,
        created.id,
        "2028-07-02T12:00",
        "2028-07-02T13:00",
        Date.now(),
        Date.now(),
      )
      .run();
    const agendaDateConflict = await callTrpc(
      "events.updateSettings",
      {
        ...eventInput,
        startsOn: "2028-07-03",
        endsOn: "2028-07-04",
        expectedRevision: updated.revision + 1,
      },
      owner.cookie,
    );
    expect(agendaDateConflict.status).toBe(409);
    const agendaTimezoneConflict = await callTrpc(
      "events.updateSettings",
      {
        ...eventInput,
        startsOn: "2028-07-01",
        endsOn: "2028-07-03",
        timezone: "UTC",
        expectedRevision: updated.revision + 1,
      },
      owner.cookie,
    );
    expect(agendaTimezoneConflict.status).toBe(409);
  });

  test("keeps authenticated session reads outside the anonymous limit", async () => {
    const { cookie } = await signIn("session-reader@example.com", "192.0.2.12");

    for (let requestNumber = 0; requestNumber < 101; requestNumber += 1) {
      const session = await workerFetch("/api/auth/get-session", {
        headers: {
          "CF-Connecting-IP": "192.0.2.12",
          Cookie: cookie,
        },
      });
      expect(session.status).toBe(200);
    }
  });

  test("rolls back event creation when an owner role cannot be granted", async () => {
    const owner = await signIn("rollback-owner@example.com");
    const tables = [
      "events",
      "agendas",
      "event_roles",
      "communication_templates",
    ];
    const countsBefore = await tableCounts(tables);
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER reject_owner_reviewer_role
       BEFORE INSERT ON event_roles
       WHEN NEW.role = 'reviewer'
       BEGIN
         SELECT RAISE(ABORT, 'reviewer role rejected');
       END`,
    ).run();

    try {
      const response = await callTrpc(
        "events.create",
        {
          name: "Rollback Conference",
          slug: "rollback-conference",
          startsOn: "2027-06-01",
          endsOn: "2027-06-02",
          timezone: "UTC",
        },
        owner.cookie,
      );
      expect(response.status).toBe(500);
      expect(await tableCounts(tables)).toEqual(countsBefore);
    } finally {
      await testEnvironment.DB.prepare(
        "DROP TRIGGER reject_owner_reviewer_role",
      ).run();
    }
  });
});

async function tableCounts(tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await testEnvironment.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).first<{ count: number }>();
    counts[table] = row?.count ?? 0;
  }
  return counts;
}

test("reports a failed authentication code delivery", async () => {
  const config: AppConfig = {
    appEnv: "production",
    appUrl: "https://localhost",
    authSecret: "test-secret-that-is-at-least-thirty-two-characters",
    problemReports: { type: "unavailable" },
    release: "test",
    scheduledWorkHeartbeat: { type: "disabled" },
    email: {
      type: "cloudflare",
      from: "auth@example.com",
      sender: {
        send: () => Promise.reject(new Error("Email service unavailable")),
      },
    },
  };
  const auth = createAuth({
    config,
    database: createDatabase(testEnvironment.DB),
  });
  const response = await auth.handler(
    new Request("https://localhost/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      body: JSON.stringify({
        email: "delivery-failure@example.com",
        type: "sign-in",
      }),
      headers: {
        "CF-Connecting-IP": "192.0.2.20",
        "Content-Type": "application/json",
        Origin: "https://localhost",
      },
    }),
  );

  expect(response.status).toBe(502);
  const verification = await testEnvironment.DB.prepare(
    "SELECT id FROM verification WHERE identifier = ?",
  )
    .bind("sign-in-otp-delivery-failure@example.com")
    .first();
  expect(verification).toBeNull();
});
