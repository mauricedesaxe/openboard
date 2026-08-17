import { afterEach, describe, expect, test, vi } from "vitest";

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

function spyOperationalFailures() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

    const logs = spyOperationalFailures();
    const send = vi.fn().mockResolvedValue({ ok: true });
    await reportScheduledWorkLiveness(config.value, send);

    expect(send).toHaveBeenCalledExactlyOnceWith(heartbeatUrl);
    expect(logs).not.toHaveBeenCalled();
  });

  test("pings through a workerd-compatible fetch with a bounded timeout", async () => {
    const config = parseConfig(productionConfig);
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    spyOperationalFailures();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await reportScheduledWorkLiveness(config.value);

    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      heartbeatUrl,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
      }),
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("stays silent outside production even when a heartbeat URL is set", async () => {
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

    const logs = spyOperationalFailures();
    const send = vi.fn();
    await reportScheduledWorkLiveness(preview.value, send);
    expect(send).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  });

  test("reports a missing heartbeat URL in production instead of staying silent", async () => {
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

    const logs = spyOperationalFailures();
    const send = vi.fn();
    await reportScheduledWorkLiveness(config.value, send);
    expect(send).not.toHaveBeenCalled();
    expect(logs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "scheduled_heartbeat_unconfigured",
        severity: "error",
      }),
    );
  });

  test("reports a rejected ping without throwing", async () => {
    const config = parseConfig(productionConfig);
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const logs = spyOperationalFailures();
    const send = vi.fn().mockResolvedValue({ ok: false });
    await expect(
      reportScheduledWorkLiveness(config.value, send),
    ).resolves.toBeUndefined();
    expect(logs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: "scheduled_heartbeat_ping_rejected" }),
    );
  });

  test("reports a failed ping without throwing", async () => {
    const config = parseConfig(productionConfig);
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const logs = spyOperationalFailures();
    const send = vi.fn().mockRejectedValue(new Error("network unavailable"));
    await expect(
      reportScheduledWorkLiveness(config.value, send),
    ).resolves.toBeUndefined();
    expect(logs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: "scheduled_heartbeat_ping_failed" }),
    );
  });
});
