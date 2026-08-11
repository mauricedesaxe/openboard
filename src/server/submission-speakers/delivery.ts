import type { AppConfig } from "../config";
import { captureInvitationSecret } from "../event-team/delivery";

export async function sendSubmissionSpeakerInvitation(
  config: AppConfig,
  invitation: {
    email: string;
    eventName: string;
    speakerName: string;
    submissionTitle: string;
    secret: string;
  },
): Promise<void> {
  if (config.email.type === "capture") {
    captureInvitationSecret(invitation.email, invitation.secret);
    return;
  }

  const invitationUrl = `${config.appUrl}/speaker-invitations/${invitation.secret}`;
  await config.email.sender.send({
    from: { email: config.email.from, name: "OpenBoard" },
    to: invitation.email,
    subject: `Join ${invitation.submissionTitle} on OpenBoard`,
    text: `${invitation.speakerName}, you have been invited to speak at ${invitation.eventName}. Open ${invitationUrl} to accept or decline.`,
  });
}
