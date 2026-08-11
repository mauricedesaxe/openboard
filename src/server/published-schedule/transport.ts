import type { AppConfig } from "../config";
import { sendConfiguredEmail } from "../email/transport";

import type { AgendaCalendarDelivery } from "./delivery";

export async function sendAgendaCalendarDelivery(
  config: AppConfig,
  delivery: AgendaCalendarDelivery,
): Promise<void> {
  await sendConfiguredEmail(config, {
    idempotencyKey: delivery.workId,
    to: delivery.destination,
    subject: delivery.subject,
    text: delivery.text,
    attachments: [
      {
        filename: "openboard-session.ics",
        contentType: `text/calendar; method=${delivery.method}; charset=utf-8`,
        content: new TextEncoder().encode(delivery.calendar),
      },
    ],
  });
}
