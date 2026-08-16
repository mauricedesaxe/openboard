import type { AppConfig } from "./config";
import { reportOperationalFailure } from "./observability";

type HeartbeatSender = (url: string) => Promise<{ ok: boolean }>;

export async function reportScheduledWorkLiveness(
  config: Pick<AppConfig, "scheduledWorkHeartbeat">,
  send: HeartbeatSender = pingHeartbeat,
): Promise<void> {
  if (config.scheduledWorkHeartbeat.type === "disabled") {
    return;
  }

  try {
    const response = await send(config.scheduledWorkHeartbeat.url);
    if (!response.ok) {
      reportOperationalFailure("scheduled_heartbeat_ping_rejected", {
        "error.type": "HeartbeatRejected",
      });
    }
  } catch {
    reportOperationalFailure("scheduled_heartbeat_ping_failed", {
      "error.type": "HeartbeatPingFailed",
    });
  }
}

async function pingHeartbeat(url: string): Promise<{ ok: boolean }> {
  const response = await fetch(url, { method: "GET", redirect: "error" });
  return { ok: response.ok };
}
