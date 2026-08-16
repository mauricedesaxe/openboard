import { describe, expect, test, vi } from "vitest";

import { parseConfig } from "../src/server/config";
import { reportScheduledWorkLiveness } from "../src/server/heartbeats";

const heartbeatUrl = "https://uptime.betterstack.com/api/v1/heartbeat/abc123";

const productionConfig = {
  APP_ENV: "production",
  APP_URL: "https://openboard.example.com",
  BETTER_AUTH_SECRET: "production-secret-with-at-least-thirty-two-characters",
  BETTERSTACK_HEARTBEAT_URL: heartbeatUrl,
  EMAIL: { send: () => Promise.resolve({ messageId: "message-id" }) },
  EMAIL_FROM: "auth@alexlazar.dev",
  EMAIL_TRANSPORT: "cloudflare",
};

describe("scheduled work heartbeats", () => {
  test("pings the configured heartbeat after production configuration", async () => {
    const config = parseConfig(productionConfig);
    expect(config).toMatchObject({
      ok: true,
      value: {
        scheduledWorkHeartbeat: { type: "betterstack", url: heartbeatUrl },
      },
    });
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const send = vi.fn().mockResolvedValue({ ok: true });
    await reportScheduledWorkLiveness(config.value, send);

    expect(send).toHaveBeenCalledExactlyOnceWith(heartbeatUrl);
  });

  test("never pings outside production even when a heartbeat URL is set", async () => {
    const preview = parseConfig({
      ...productionConfig,
      APP_ENV: "preview",
    });
    expect(preview).toMatchObject({
      ok: true,
      value: { scheduledWorkHeartbeat: { type: "disabled" } },
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const send = vi.fn();
    await reportScheduledWorkLiveness(preview.value, send);
    expect(send).not.toHaveBeenCalled();
  });

  test("stays silent when production has no heartbeat URL", async () => {
    const config = parseConfig({
      ...productionConfig,
      BETTERSTACK_HEARTBEAT_URL: undefined,
    });
    expect(config).toMatchObject({
      ok: true,
      value: { scheduledWorkHeartbeat: { type: "disabled" } },
    });
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const send = vi.fn();
    await reportScheduledWorkLiveness(config.value, send);
    expect(send).not.toHaveBeenCalled();
  });

  test("reports a rejected ping without throwing", async () => {
    const config = parseConfig(productionConfig);
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const send = vi.fn().mockResolvedValue({ ok: false });
    await expect(
      reportScheduledWorkLiveness(config.value, send),
    ).resolves.toBeUndefined();
  });

  test("reports a failed ping without throwing", async () => {
    const config = parseConfig(productionConfig);
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const send = vi.fn().mockRejectedValue(new Error("network unavailable"));
    await expect(
      reportScheduledWorkLiveness(config.value, send),
    ).resolves.toBeUndefined();
  });
});
