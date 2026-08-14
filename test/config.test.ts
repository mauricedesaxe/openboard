import { describe, expect, test } from "vitest";

import { parseConfig } from "../src/server/config";

const validConfig = {
  APP_ENV: "production",
  APP_URL: "https://openboard.example.com",
  BETTER_AUTH_SECRET: "production-secret-with-at-least-thirty-two-characters",
  EMAIL: { send: () => Promise.resolve({ messageId: "message-id" }) },
  EMAIL_FROM: "auth@alexlazar.dev",
  EMAIL_TRANSPORT: "cloudflare",
};

describe("configuration", () => {
  test("rejects unsafe production authentication transports and missing secrets", () => {
    expect(
      parseConfig({ ...validConfig, EMAIL_TRANSPORT: "capture" }),
    ).toMatchObject({ ok: false });
    expect(
      parseConfig({ ...validConfig, BETTER_AUTH_SECRET: "short" }),
    ).toMatchObject({ ok: false });
    expect(
      parseConfig({ ...validConfig, APP_URL: "http://openboard.example.com" }),
    ).toMatchObject({ ok: false });
    expect(parseConfig({ ...validConfig, EMAIL: undefined })).toMatchObject({
      ok: false,
    });
    expect(
      parseConfig({ ...validConfig, EMAIL_FROM: "not-an-email" }),
    ).toMatchObject({ ok: false });
    expect(
      parseConfig({ ...validConfig, EMAIL_FROM: "auth@example.com" }),
    ).toMatchObject({ ok: false });
  });

  test("accepts an explicit production email transport", () => {
    expect(parseConfig(validConfig)).toEqual({
      ok: true,
      value: {
        appEnv: "production",
        appUrl: "https://openboard.example.com",
        authSecret: validConfig.BETTER_AUTH_SECRET,
        email: {
          type: "cloudflare",
          from: validConfig.EMAIL_FROM,
          sender: validConfig.EMAIL,
        },
        problemReports: { type: "unavailable" },
        release: "production",
      },
    });
    expect(
      parseConfig({
        ...validConfig,
        EMAIL: undefined,
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "resend-key",
      }),
    ).toEqual({
      ok: true,
      value: {
        appEnv: "production",
        appUrl: "https://openboard.example.com",
        authSecret: validConfig.BETTER_AUTH_SECRET,
        email: {
          type: "resend",
          from: validConfig.EMAIL_FROM,
          apiKey: "resend-key",
        },
        problemReports: { type: "unavailable" },
        release: "production",
      },
    });
    expect(
      parseConfig({
        ...validConfig,
        EMAIL: undefined,
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: undefined,
      }),
    ).toMatchObject({ ok: false });
  });

  test("keeps incident credentials in production configuration", () => {
    expect(
      parseConfig({
        ...validConfig,
        BETTERSTACK_INCIDENT_API_TOKEN: "incident-token",
        BETTERSTACK_INCIDENT_POLICY_ID: "owner-policy",
        BETTERSTACK_INCIDENT_REQUESTER_EMAIL: "owner@example.com",
        VERSION: { id: "release-123" },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        problemReports: {
          type: "betterstack",
          apiToken: "incident-token",
          policyId: "owner-policy",
          requesterEmail: "owner@example.com",
        },
        release: "release-123",
      },
    });
  });
});
