import { describe, expect, test } from "vitest";
import { z } from "zod";

import { processCommunicationDeliveryWork } from "../src/server/communications/delivery";
import {
  communicationInsertStatements,
  prepareCommunication,
} from "../src/server/communications/repository";
import { createDatabase } from "../src/server/database/client";
import { getCapturedEmails } from "../src/server/email/transport";

import { callTrpc, getResult, signIn, testEnvironment } from "./support";

describe("templated communications", () => {
  test("snapshots templates and retries delivery without changing domain state", async () => {
    const slug = "communication-flow";
    const owner = await signIn("communication-owner@example.com");
    expect(
      (
        await callTrpc(
          "events.create",
          {
            name: "Communication Conf",
            slug,
            startsOn: "2029-04-10",
            endsOn: "2029-04-11",
            timezone: "Europe/Berlin",
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);

    const templates = getResult(
      (
        await callTrpc(
          "communications.templates",
          { slug },
          owner.cookie,
          "query",
        )
      ).body,
      z.array(
        z.object({
          purpose: z.string(),
          subject: z.string(),
          body: z.string(),
          revision: z.number(),
        }),
      ),
    );
    expect(templates).toHaveLength(7);
    const confirmation = templates.find(
      (template) => template.purpose === "submission_confirmation",
    );
    expect(confirmation).toBeTruthy();
    expect(
      (
        await callTrpc(
          "communications.updateTemplate",
          {
            slug,
            purpose: "submission_confirmation",
            subject: "Got {{submissionTitle}}",
            body: "Hello {{recipientName}}, welcome to {{eventName}}.",
            expectedRevision: confirmation?.revision,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "communications.updateTemplate",
          {
            slug,
            purpose: "submission_confirmation",
            subject: "Bad {{unknown}}",
            body: "Body",
            expectedRevision: 2,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(409);

    const event = await testEnvironment.DB.prepare(
      "SELECT id FROM events WHERE slug = ?",
    )
      .bind(slug)
      .first<{ id: string }>();
    expect(event).toBeTruthy();
    const database = createDatabase(testEnvironment.DB);
    const now = new Date("2029-01-01T00:00:00.000Z");
    const prepared = await prepareCommunication(database, {
      eventId: event?.id ?? "",
      purpose: "submission_confirmation",
      recipient: {
        key: "speaker:speaker-1",
        userId: null,
        invitationId: null,
        destination: "invited@example.com",
        name: "Invited Speaker",
      },
      variables: {
        eventName: "Communication Conf",
        submissionTitle: "Deep modules",
        recipientName: "Invited Speaker",
      },
      context: { submissionId: "submission-1" },
      now,
    });
    await database.batch([
      ...communicationInsertStatements(database, prepared),
    ]);

    const failed = await processCommunicationDeliveryWork(
      database,
      {
        email: {
          type: "cloudflare",
          from: "auth@alexlazar.dev",
          sender: {
            send: () => Promise.reject(new Error("Transport unavailable")),
          },
        },
      },
      { now },
    );
    expect(failed).toEqual({ delivered: 0, failed: 1, terminal: 0 });
    expect(
      (
        await callTrpc(
          "communications.failures",
          { slug },
          owner.cookie,
          "query",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "communications.retry",
          { slug, communicationId: prepared.communication.id },
          owner.cookie,
        )
      ).status,
    ).toBe(200);

    const captureConfig = {
      email: { type: "capture" as const },
    };
    expect(
      await processCommunicationDeliveryWork(database, captureConfig, {
        now: new Date("2029-01-02T00:00:00.000Z"),
      }),
    ).toEqual({ delivered: 1, failed: 0, terminal: 0 });
    expect(getCapturedEmails(captureConfig).at(-1)).toMatchObject({
      to: "invited@example.com",
      subject: "Got Deep modules",
      text: "Hello Invited Speaker, welcome to Communication Conf.",
    });
    expect(
      await processCommunicationDeliveryWork(database, captureConfig, {
        now: new Date("2029-01-02T00:00:01.000Z"),
      }),
    ).toEqual({ delivered: 0, failed: 0, terminal: 0 });
    expect(
      getCapturedEmails(captureConfig).filter(
        (message) => message.idempotencyKey === prepared.communication.id,
      ),
    ).toHaveLength(1);
    const exhausted = await prepareCommunication(database, {
      eventId: event?.id ?? "",
      purpose: "submission_confirmation",
      recipient: {
        key: `user:${owner.userId}`,
        userId: owner.userId,
        invitationId: null,
        destination: "communication-owner@example.com",
        name: "Communication Owner",
      },
      variables: {
        eventName: "Communication Conf",
        submissionTitle: "Retry limits",
        recipientName: "Communication Owner",
      },
      context: { submissionId: "submission-2" },
      now,
    });
    await database.batch([
      ...communicationInsertStatements(database, exhausted),
    ]);
    await testEnvironment.DB.prepare(
      "UPDATE communication_delivery_work SET attempt_count = 7 WHERE id = ?",
    )
      .bind(exhausted.work.id)
      .run();
    expect(
      await processCommunicationDeliveryWork(
        database,
        {
          email: {
            type: "cloudflare",
            from: "auth@alexlazar.dev",
            sender: {
              send: () => Promise.reject(new Error("Transport unavailable")),
            },
          },
        },
        { now: new Date("2029-01-03T00:00:00.000Z") },
      ),
    ).toEqual({ delivered: 0, failed: 0, terminal: 1 });
    expect(
      await testEnvironment.DB.prepare(
        "SELECT status, attempt_count AS attemptCount FROM communication_delivery_work WHERE id = ?",
      )
        .bind(exhausted.work.id)
        .first(),
    ).toEqual({ status: "terminal", attemptCount: 8 });
    const stale = await prepareCommunication(database, {
      eventId: event?.id ?? "",
      purpose: "submission_confirmation",
      recipient: {
        key: "speaker:stale-cloudflare",
        userId: null,
        invitationId: null,
        destination: "stale@example.com",
        name: "Stale Claim",
      },
      variables: {
        eventName: "Communication Conf",
        submissionTitle: "Ambiguous delivery",
        recipientName: "Stale Claim",
      },
      context: { submissionId: "submission-stale" },
      now,
    });
    await database.batch([...communicationInsertStatements(database, stale)]);
    await testEnvironment.DB.prepare(
      "UPDATE communication_delivery_work SET claim_token = ?, claimed_at = ?, attempt_count = 1 WHERE id = ?",
    )
      .bind("stale-cloudflare-claim", now.getTime(), stale.work.id)
      .run();
    let staleCloudflareSends = 0;
    expect(
      await processCommunicationDeliveryWork(
        database,
        {
          email: {
            type: "cloudflare",
            from: "auth@alexlazar.dev",
            sender: {
              send: () => {
                staleCloudflareSends += 1;
                return Promise.resolve({ messageId: "unexpected-send" });
              },
            },
          },
        },
        { now: new Date("2029-01-02T00:00:00.000Z") },
      ),
    ).toEqual({ delivered: 0, failed: 0, terminal: 1 });
    expect(staleCloudflareSends).toBe(0);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT status, attempt_count AS attemptCount, last_error AS lastError FROM communication_delivery_work WHERE id = ?",
      )
        .bind(stale.work.id)
        .first(),
    ).toEqual({
      status: "terminal",
      attemptCount: 1,
      lastError: "Previous Cloudflare delivery outcome is unknown",
    });
    const incompleteCommunicationId = crypto.randomUUID();
    const incompleteWorkId = crypto.randomUUID();
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "INSERT INTO communications (id, event_id, destination, purpose, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        incompleteCommunicationId,
        event?.id,
        "legacy@example.com",
        "submission_confirmation",
        now.getTime(),
      ),
      testEnvironment.DB.prepare(
        "INSERT INTO communication_delivery_work (id, communication_id, created_at) VALUES (?, ?, ?)",
      ).bind(incompleteWorkId, incompleteCommunicationId, now.getTime()),
    ]);
    expect(
      await processCommunicationDeliveryWork(database, captureConfig, {
        now: new Date("2029-01-04T00:00:00.000Z"),
      }),
    ).toEqual({ delivered: 0, failed: 0, terminal: 1 });
    expect(
      await testEnvironment.DB.prepare(
        `SELECT work.status, work.attempt_count AS attemptCount, attempts.result
         FROM communication_delivery_work AS work
         JOIN communication_delivery_attempts AS attempts ON attempts.work_id = work.id
         WHERE work.id = ?`,
      )
        .bind(incompleteWorkId)
        .first(),
    ).toEqual({
      status: "terminal",
      attemptCount: 1,
      result: "terminal_failure",
    });
    const leaseBatch = await Promise.all(
      ["first", "second"].map((name) =>
        prepareCommunication(database, {
          eventId: event?.id ?? "",
          purpose: "submission_confirmation",
          recipient: {
            key: `speaker:lease-${name}`,
            userId: null,
            invitationId: null,
            destination: `${name}@example.com`,
            name,
          },
          variables: {
            eventName: "Communication Conf",
            submissionTitle: `${name} lease`,
            recipientName: name,
          },
          context: { submissionId: `submission-lease-${name}` },
          now,
        }),
      ),
    );
    for (const item of leaseBatch) {
      await database.batch([...communicationInsertStatements(database, item)]);
    }
    const communicationClaims: number[] = [];
    let communicationClock = new Date("2029-01-05T00:00:00.000Z").getTime();
    expect(
      await processCommunicationDeliveryWork(
        database,
        {
          email: {
            type: "cloudflare",
            from: "auth@alexlazar.dev",
            sender: {
              send: async (message) => {
                const claim = await testEnvironment.DB.prepare(
                  `SELECT work.claimed_at AS claimedAt
                   FROM communication_delivery_work AS work
                   JOIN communications ON communications.id = work.communication_id
                   WHERE communications.destination = ?`,
                )
                  .bind(message.to)
                  .first<{ claimedAt: number }>();
                communicationClaims.push(claim?.claimedAt ?? 0);
                return { messageId: crypto.randomUUID() };
              },
            },
          },
        },
        {
          clock: () => {
            const current = new Date(communicationClock);
            communicationClock += 3 * 60_000;
            return current;
          },
        },
      ),
    ).toEqual({ delivered: 2, failed: 0, terminal: 0 });
    expect(communicationClaims).toEqual([
      new Date("2029-01-05T00:03:00.000Z").getTime(),
      new Date("2029-01-05T00:09:00.000Z").getTime(),
    ]);
    await expect(
      testEnvironment.DB.prepare(
        "UPDATE communications SET subject = 'Changed' WHERE id = ?",
      )
        .bind(prepared.communication.id)
        .run(),
    ).rejects.toThrow("immutable_communication");
    expect(
      await testEnvironment.DB.prepare("SELECT name FROM events WHERE id = ?")
        .bind(event?.id)
        .first(),
    ).toEqual({ name: "Communication Conf" });
  });
});
