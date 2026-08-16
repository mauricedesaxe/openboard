import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/database/client";
import {
  deliverProblemReport,
  getCapturedProblemReports,
  type ProblemReport,
  redactSensitiveText,
} from "../src/server/problem-reports/delivery";
import {
  releaseProblemReportReservation,
  reserveProblemReport,
} from "../src/server/problem-reports/repository";
import type { UserId } from "../src/shared/events";

import { callTrpc, getResult, signIn, testEnvironment } from "./support";

const acceptedSchema = z.object({ accepted: z.literal(true) });
const reportInput = {
  contactAllowed: true,
  description: "The page stopped responding after I opened the agenda.",
  formOpenDurationMs: 2_000,
  honeypotWebsite: "",
  route: "/events/private-event/agenda",
};

describe("problem reports", () => {
  test("delivers signed-out and signed-in reports with safe context", async () => {
    const before = getCapturedProblemReports().length;
    const anonymous = await callTrpc(
      "problemReports.submit",
      reportInput,
      undefined,
      "mutation",
      { "CF-Connecting-IP": "192.0.2.241" },
    );
    expect(anonymous.status).toBe(200);
    expect(getResult(anonymous.body, acceptedSchema)).toEqual({
      accepted: true,
    });

    const user = await signIn("reporter@example.com", "192.0.2.242");
    const authenticated = await callTrpc(
      "problemReports.submit",
      reportInput,
      user.cookie,
      "mutation",
      { "CF-Connecting-IP": "192.0.2.242" },
    );
    expect(authenticated.status).toBe(200);

    const reports = getCapturedProblemReports().slice(before);
    expect(reports).toMatchObject([
      {
        contactAllowed: false,
        environment: "test",
        route: "/events/:slug/agenda",
      },
      {
        contactAllowed: true,
        environment: "test",
        route: "/events/:slug/agenda",
        userId: user.userId,
      },
    ]);
    expect(typeof reports[0]?.release).toBe("string");
    expect(reports[0]).not.toHaveProperty("userId");
  });

  test("rejects automation and limits repeated reports", async () => {
    const automated = await callTrpc(
      "problemReports.submit",
      { ...reportInput, honeypotWebsite: "https://spam.example" },
      undefined,
      "mutation",
      { "CF-Connecting-IP": "192.0.2.243" },
    );
    expect(automated.status).toBe(400);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const accepted = await callTrpc(
        "problemReports.submit",
        reportInput,
        undefined,
        "mutation",
        { "CF-Connecting-IP": "192.0.2.244" },
      );
      expect(accepted.status).toBe(200);
    }
    const limited = await callTrpc(
      "problemReports.submit",
      reportInput,
      undefined,
      "mutation",
      { "CF-Connecting-IP": "192.0.2.244" },
    );
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({
      error: { data: { code: "TOO_MANY_REQUESTS" } },
    });
  });

  test("alerts by email with redacted diagnostic context", async () => {
    const requests: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    function request(input: RequestInfo | URL, init?: RequestInit) {
      requests.push({ input, init });
      return Promise.resolve(new Response(undefined, { status: 201 }));
    }
    const result = await deliverProblemReport(
      betterStackConfig,
      {
        ...problemReport,
        description:
          "Code 123456 failed for person@example.com while opening the agenda.",
      },
      request,
    );

    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const init = requests[0]?.init;
    expect(init?.headers).toEqual({
      Authorization: "Bearer server-only-token",
      "Content-Type": "application/json",
    });
    expect(init?.body).toBe(
      JSON.stringify({
        description: [
          "A user reported a production problem.",
          "",
          "Description: Code [redacted code] failed for [redacted email] while opening the agenda.",
          "Route: /events/:slug/agenda",
          "Release: release-123",
          "Timestamp: 2026-08-14T12:00:00.000Z",
          "Environment: production",
          "User ID: user-123",
          "Contact allowed: yes",
        ].join("\n"),
        email: true,
        name: "OpenBoard user report",
        policy_id: "owner-policy",
        requester_email: "owner@example.com",
        summary: "User reported a problem on /events/:slug/agenda",
      }),
    );
  });

  test("returns a recoverable failure when incident delivery fails", async () => {
    const result = await deliverProblemReport(
      betterStackConfig,
      problemReport,
      () => Promise.resolve(new Response("Unavailable", { status: 503 })),
    );
    expect(result).toEqual({ ok: false, reason: "delivery" });
  });

  test("keeps accepted-report capacity after delivery failures", async () => {
    const database = createDatabase(testEnvironment.DB);
    const identity = { type: "ip" as const, ipAddress: "192.0.2.245" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reservation = await reserveProblemReport(
        database,
        identity,
        "rate-limit-secret",
        new Date(),
      );
      expect(reservation).toBeDefined();
      if (reservation) {
        await releaseProblemReportReservation(database, reservation);
      }
    }

    expect(
      await reserveProblemReport(
        database,
        identity,
        "rate-limit-secret",
        new Date(),
      ),
    ).toBeDefined();
  });

  test("limits automated form submissions by speed", async () => {
    const tooFast = await callTrpc(
      "problemReports.submit",
      { ...reportInput, formOpenDurationMs: 500 },
      undefined,
      "mutation",
      { "CF-Connecting-IP": "192.0.2.246" },
    );
    expect(tooFast.status).toBe(400);
  });
});

describe("report text sanitization", () => {
  test("replaces email addresses with a redacted placeholder", () => {
    expect(redactSensitiveText("Contact admin@example.com for help.")).toBe(
      "Contact [redacted email] for help.",
    );
    expect(
      redactSensitiveText(
        "a+b@c.net wrote to user@sub.domain.org about the page.",
      ),
    ).toBe("[redacted email] wrote to [redacted email] about the page.");
    expect(redactSensitiveText("hello@me.example")).toBe("[redacted email]");
  });

  test("replaces six-digit number sequences with a redacted placeholder", () => {
    expect(redactSensitiveText("Code 123456 failed.")).toBe(
      "Code [redacted code] failed.",
    );
    expect(redactSensitiveText("Codes 111111 and 999999 both work.")).toBe(
      "Codes [redacted code] and [redacted code] both work.",
    );
  });

  test("keeps numbers that are not six digits", () => {
    expect(redactSensitiveText("Code 12345 worked.")).toBe(
      "Code 12345 worked.",
    );
    expect(redactSensitiveText("Code 1234567 failed.")).toBe(
      "Code 1234567 failed.",
    );
    expect(redactSensitiveText("Order #12345 placed.")).toBe(
      "Order #12345 placed.",
    );
  });

  test("redacts mixed emails and codes in the same text", () => {
    expect(
      redactSensitiveText(
        "User admin@example.com reported Code 654321 on route /events/conf",
      ),
    ).toBe(
      "User [redacted email] reported Code [redacted code] on route /events/conf",
    );
  });

  test("strips control characters except tabs, newlines, and carriage returns", () => {
    expect(redactSensitiveText("Line\u0000break")).toBe("Line break");
    expect(redactSensitiveText("Tab\tNewline\nReturn\rAll")).toBe(
      "Tab\tNewline\nReturn\rAll",
    );
  });

  test("returns unchanged text when there is nothing to redact", () => {
    const text = "The page stopped responding after I opened the agenda.";
    expect(redactSensitiveText(text)).toBe(text);
  });

  test("returns empty string when given empty input", () => {
    expect(redactSensitiveText("")).toBe("");
  });
});

const betterStackConfig: AppConfig = {
  appEnv: "production",
  appUrl: "https://openboard.example",
  authSecret: "not-used-in-this-test",
  email: { type: "capture" },
  problemReports: {
    type: "betterstack",
    apiToken: "server-only-token",
    policyId: "owner-policy",
    requesterEmail: "owner@example.com",
  },
  release: "release-123",
};

const problemReport: ProblemReport = {
  contactAllowed: true,
  description: "The agenda did not open.",
  environment: "production",
  release: "release-123",
  reportedAt: "2026-08-14T12:00:00.000Z",
  route: "/events/:slug/agenda",
  userId: "user-123" as UserId,
};
