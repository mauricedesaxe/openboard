import { describe, expect, test } from "vitest";

import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/database/client";
import { createAuth } from "../src/server/identity/auth";

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

    const createdResponse = await callTrpc<
      typeof eventInput & { id: string; ownerUserId: string; agendaId: string }
    >("events.create", eventInput, owner.cookie);
    expect(createdResponse.status).toBe(200);
    const created = getResult(createdResponse.body);
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

    const reloaded = await callTrpc(
      "events.get",
      { slug: eventInput.slug },
      owner.cookie,
      "query",
    );
    expect(reloaded.status).toBe(200);
    expect(getResult(reloaded.body)).toEqual(created);

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
    expect(getResult(renamed.body)).toMatchObject({ name: "Northstar 2027" });
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
});

test("reports a failed authentication code delivery", async () => {
  const config: AppConfig = {
    appEnv: "production",
    appUrl: "https://localhost",
    authSecret: "test-secret-that-is-at-least-thirty-two-characters",
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
