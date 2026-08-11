import type { EventRole } from "../../shared/event-team";
import type { AppConfig } from "../config";

const capturedInvitationSecrets = new Map<string, string>();

export async function sendEventInvitation(
  config: AppConfig,
  invitation: {
    email: string;
    eventName: string;
    role: EventRole;
    secret: string;
  },
): Promise<void> {
  if (config.email.type === "capture") {
    captureInvitationSecret(invitation.email, invitation.secret);
    return;
  }

  const invitationUrl = `${config.appUrl}/invitations/${invitation.secret}`;
  const article = invitation.role === "organizer" ? "an" : "a";
  await config.email.sender.send({
    from: { email: config.email.from, name: "OpenBoard" },
    to: invitation.email,
    subject: `Join ${invitation.eventName} on OpenBoard`,
    text: `You have been invited as ${article} ${invitation.role} for ${invitation.eventName}. Open ${invitationUrl} to accept or decline.`,
  });
}

export function captureInvitationSecret(email: string, secret: string): void {
  capturedInvitationSecrets.set(normalizeEmail(email), secret);
}

export function getCapturedInvitationSecret(
  config: AppConfig,
  email: string,
): string | undefined {
  if (config.email.type !== "capture") return undefined;
  return capturedInvitationSecrets.get(normalizeEmail(email));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
