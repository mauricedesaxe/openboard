import type { AppConfig } from "./config";
import { reportOperationalFailure } from "./observability";

const heartbeatTimeoutMs = 10_000;

type HeartbeatSender = (url: string) => Promise<{ ok: boolean }>;

export async function reportScheduledWorkLiveness(
  config: Pick<AppConfig, "appEnv" | "scheduledWorkHeartbeat">,
  send: HeartbeatSender = pingHeartbeat,
): Promise<void> {
  if (config.scheduledWorkHeartbeat.type === "disabled") {
    if (config.appEnv === "production") {
      reportOperationalFailure("scheduled_heartbeat_unconfigured", {
        "error.type": "ConfigurationError",
      });
    }
    return;
  }

  try {
    const response = await send(config.scheduledWorkHeartbeat.url);
    if (!response.ok) {
      reportOperationalFailure("scheduled_heartbeat_ping_rejected", {
        "error.type": "HeartbeatRejected",
      });
    }
  } catch (error) {
    reportOperationalFailure("scheduled_heartbeat_ping_failed", {}, error);
  }
}

async function pingHeartbeat(url: string): Promise<{ ok: boolean }> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual", // workerd rejects "error"; a redirect lands in the !ok rejection path
    signal: AbortSignal.timeout(heartbeatTimeoutMs),
  });
  return { ok: response.ok };
}
