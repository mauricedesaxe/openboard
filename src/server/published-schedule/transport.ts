import type { AppConfig } from "../config";

import type { AgendaCalendarDelivery } from "./delivery";

const capturedCalendarDeliveries: AgendaCalendarDelivery[] = [];

export async function sendAgendaCalendarDelivery(
  config: AppConfig,
  delivery: AgendaCalendarDelivery,
): Promise<void> {
  if (config.email.type === "capture") {
    capturedCalendarDeliveries.push(delivery);
    return;
  }

  await config.email.sender.send({
    from: { email: config.email.from, name: "OpenBoard" },
    to: delivery.destination,
    subject: delivery.subject,
    text: delivery.text,
    attachments: [
      {
        disposition: "attachment",
        filename: "openboard-session.ics",
        type: `text/calendar; method=${delivery.method}; charset=utf-8`,
        content: new TextEncoder().encode(delivery.calendar),
      },
    ],
  });
}

export function getCapturedCalendarDeliveries(
  config: AppConfig,
): readonly AgendaCalendarDelivery[] {
  return config.email.type === "capture" ? capturedCalendarDeliveries : [];
}
