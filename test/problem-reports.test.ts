import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AppConfig } from "../src/server/config";
import {
  deliverProblemReport,
  getCapturedProblemReports,
  type ProblemReport,
} from "../src/server/problem-reports/delivery";
import type { UserId } from "../src/shared/events";

import { callTrpc, getResult, signIn } from "./support";

const acceptedSchema = z.object({ accepted: z.literal(true) });
const reportInput = {
  contactAllowed: true,
  description: "The page stopped responding after I opened the agenda.",
  elapsedMs: 2_000,
  route: "/events/private-event/agenda",
  website: "",
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
      { ...reportInput, website: "https://spam.example" },
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
});

const betterStackConfig: AppConfig = {
  appEnv: "production",
  appUrl: "https://openboard.example",
  authSecret: "not-used-in-this-test",
  email: { type: "capture" },
  problemReports: {
    type: "betterstack",
    apiToken: "server-only-token",
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
