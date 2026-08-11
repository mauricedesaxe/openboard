import { describe, expect, test } from "vitest";
import { z } from "zod";

import { cfpSchema } from "../src/shared/cfps";

import {
  callTrpc,
  getResult,
  signIn,
  testEnvironment,
  workerFetch,
} from "./support";

const idSchema = z.object({ id: z.string() });
const createdSubmissionSchema = z.object({
  id: z.string(),
  proposedSpeakers: z.array(z.object({ id: z.string() })),
});
const addedSpeakerSchema = z.object({
  speakerId: z.string(),
  invitationId: z.string(),
});
const profileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  bio: z.string(),
  headshotUrl: z.string().nullable(),
});
const profileStateSchema = z.object({
  eligible: z.boolean(),
  profile: profileSchema.nullable(),
  suggestedDisplayName: z.string().nullable(),
});
const submissionPermissionsSchema = z.object({
  permissions: z.object({
    canEdit: z.boolean(),
    canManageSpeakers: z.boolean(),
    canWithdraw: z.boolean(),
  }),
});
const accessibleSubmissionSchema = submissionPermissionsSchema.extend({
  proposedSpeakers: z.array(
    z.object({ name: z.string(), email: z.string().nullable() }),
  ),
});
const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  submissionTitle: z.string(),
  speakerName: z.string(),
});

describe("claim a proposed-speaker invitation", () => {
  test("claims the existing relationship and derives submission access from it", async () => {
    const owner = await signIn("speaker-claim-owner@example.com");
    const recipient = await signIn("speaker-claim-recipient@example.com");
    const unrelated = await signIn("speaker-claim-unrelated@example.com");
    const submission = await createSubmission({
      slug: "speaker-claim-2027",
      eventOwner: owner,
      submissionOwner: owner,
      proposedSpeakers: [
        {
          name: "Riley Recipient",
          email: "speaker-claim-recipient@example.com",
        },
        { name: "Other Speaker", email: "other-speaker@example.com" },
      ],
    });

    const beforeClaim = await testEnvironment.DB.prepare(
      `SELECT id, claimed_user_id
       FROM submission_speakers
       WHERE submission_id = ? AND invited_email = ?`,
    )
      .bind(submission.id, "speaker-claim-recipient@example.com")
      .first<{ id: string; claimed_user_id: string | null }>();
    expect(beforeClaim).toMatchObject({ claimed_user_id: null });
    expect(
      (
        await callTrpc(
          "submissions.get",
          { submissionId: submission.id },
          recipient.cookie,
          "query",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await callTrpc(
          "submissions.get",
          { submissionId: submission.id },
          unrelated.cookie,
          "query",
        )
      ).status,
    ).toBe(404);

    const secret = await getInvitationSecret(
      "speaker-claim-recipient@example.com",
    );
    const invitation = getResult(
      (
        await callTrpc(
          "submissionSpeakerInvitations.get",
          { secret },
          undefined,
          "query",
        )
      ).body,
      invitationSchema,
    );
    expect(invitation).toMatchObject({
      email: "speaker-claim-recipient@example.com",
      submissionTitle: "A claimed proposal",
      speakerName: "Riley Recipient",
    });
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.accept",
          { secret },
          unrelated.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.accept",
          { secret },
          recipient.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      getResult(
        (
          await callTrpc(
            "submissions.list",
            undefined,
            recipient.cookie,
            "query",
          )
        ).body,
        z.array(z.object({ id: z.string() })),
      ).map(({ id }) => id),
    ).toContain(submission.id);

    const afterClaim = await testEnvironment.DB.prepare(
      `SELECT id, claimed_user_id
       FROM submission_speakers
       WHERE submission_id = ? AND invited_email = ?`,
    )
      .bind(submission.id, "speaker-claim-recipient@example.com")
      .first<{ id: string; claimed_user_id: string | null }>();
    expect(afterClaim).toEqual({
      id: beforeClaim?.id,
      claimed_user_id: recipient.userId,
    });
    const accessibleSubmission = getResult(
      (
        await callTrpc(
          "submissions.get",
          { submissionId: submission.id },
          recipient.cookie,
          "query",
        )
      ).body,
      accessibleSubmissionSchema,
    );
    expect(accessibleSubmission.permissions).toEqual({
      canEdit: false,
      canManageSpeakers: false,
      canWithdraw: false,
    });
    expect(accessibleSubmission.proposedSpeakers).toEqual([
      {
        name: "Riley Recipient",
        email: "speaker-claim-recipient@example.com",
      },
      { name: "Other Speaker", email: null },
    ]);
  });

  test("claims the submission owner's matching proposed-speaker relationship", async () => {
    const owner = await signIn("self-claim-owner@example.com");
    const submission = await createSubmission({
      slug: "self-claim-2027",
      eventOwner: owner,
      submissionOwner: owner,
      proposedSpeakers: [
        { name: "Owner Speaker", email: "self-claim-owner@example.com" },
      ],
    });
    expect(
      await testEnvironment.DB.prepare(
        `SELECT claimed_user_id FROM submission_speakers
         WHERE submission_id = ?`,
      )
        .bind(submission.id)
        .first<{ claimed_user_id: string }>(),
    ).toEqual({ claimed_user_id: owner.userId });
    expect(
      await testEnvironment.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM submission_speaker_invitations
         INNER JOIN submission_speakers
           ON submission_speakers.id = submission_speaker_invitations.submission_speaker_id
         WHERE submission_speakers.submission_id = ?`,
      )
        .bind(submission.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  test("keeps claim and decline as one atomic outcome", async () => {
    const owner = await signIn("claim-race-owner@example.com");
    const recipient = await signIn("claim-race-recipient@example.com");
    const submission = await createSubmission({
      slug: "claim-race-2027",
      eventOwner: owner,
      submissionOwner: owner,
      proposedSpeakers: [
        {
          name: "Race Recipient",
          email: "claim-race-recipient@example.com",
        },
      ],
    });
    const secret = await getInvitationSecret(
      "claim-race-recipient@example.com",
    );
    await Promise.all([
      callTrpc(
        "submissionSpeakerInvitations.accept",
        { secret },
        recipient.cookie,
      ),
      callTrpc("submissionSpeakerInvitations.decline", { secret }),
    ]);

    const outcome = await testEnvironment.DB.prepare(
      `SELECT submission_speaker_invitations.status, submission_speakers.claimed_user_id
       FROM submission_speaker_invitations
       INNER JOIN submission_speakers
         ON submission_speakers.id = submission_speaker_invitations.submission_speaker_id
       WHERE submission_speakers.submission_id = ?`,
    )
      .bind(submission.id)
      .first<{ status: string; claimed_user_id: string | null }>();
    expect(["accepted", "declined"]).toContain(outcome?.status);
    expect(outcome?.claimed_user_id).toBe(
      outcome?.status === "accepted" ? recipient.userId : null,
    );
  });

  test("lets owners and organizers manage speakers without losing history", async () => {
    const eventOwner = await signIn("speaker-manage-event-owner@example.com");
    const submissionOwner = await signIn(
      "speaker-manage-submission-owner@example.com",
    );
    const organizer = await signIn("speaker-manage-organizer@example.com");
    const firstRecipient = await signIn("speaker-manage-first@example.com");
    const claimedRecipient = await signIn("speaker-manage-claimed@example.com");
    const unrelated = await signIn("speaker-manage-unrelated@example.com");
    const slug = "speaker-manage-2027";
    const submission = await createSubmission({
      slug,
      eventOwner,
      submissionOwner,
      proposedSpeakers: [
        {
          name: "First Recipient",
          email: "speaker-manage-first@example.com",
        },
      ],
    });
    const firstSecret = await getInvitationSecret(
      "speaker-manage-first@example.com",
    );

    await callTrpc(
      "eventTeam.invite",
      {
        slug,
        email: "speaker-manage-organizer@example.com",
        role: "organizer",
      },
      eventOwner.cookie,
    );
    const organizerSecret = await getInvitationSecret(
      "speaker-manage-organizer@example.com",
    );
    await callTrpc(
      "invitations.accept",
      { secret: organizerSecret },
      organizer.cookie,
    );

    expect(
      (
        await callTrpc(
          "submissions.addSpeaker",
          {
            submissionId: submission.id,
            name: "Blocked Recipient",
            email: "blocked@example.com",
          },
          unrelated.cookie,
        )
      ).status,
    ).toBe(404);
    const claimedSpeaker = getResult(
      (
        await callTrpc(
          "submissions.addSpeaker",
          {
            submissionId: submission.id,
            name: "Claimed Recipient",
            email: "speaker-manage-claimed@example.com",
          },
          submissionOwner.cookie,
        )
      ).body,
      addedSpeakerSchema,
    );
    const claimedSecret = await getInvitationSecret(
      "speaker-manage-claimed@example.com",
    );

    expect(
      (
        await callTrpc(
          "submissions.removeSpeaker",
          {
            submissionId: submission.id,
            speakerId: submission.proposedSpeakers[0]?.id,
          },
          submissionOwner.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.get",
          { secret: firstSecret },
          undefined,
          "query",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.accept",
          { secret: claimedSecret },
          claimedRecipient.cookie,
        )
      ).status,
    ).toBe(200);

    const finalSpeaker = getResult(
      (
        await callTrpc(
          "submissions.addSpeaker",
          {
            submissionId: submission.id,
            name: "Final Recipient",
            email: "speaker-manage-final@example.com",
          },
          organizer.cookie,
        )
      ).body,
      addedSpeakerSchema,
    );
    expect(
      getResult(
        (
          await callTrpc(
            "submissions.get",
            { submissionId: submission.id },
            organizer.cookie,
            "query",
          )
        ).body,
        submissionPermissionsSchema,
      ).permissions.canManageSpeakers,
    ).toBe(true);
    expect(
      (
        await callTrpc(
          "submissions.removeSpeaker",
          {
            submissionId: submission.id,
            speakerId: claimedSpeaker.speakerId,
          },
          organizer.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "submissions.get",
          { submissionId: submission.id },
          claimedRecipient.cookie,
          "query",
        )
      ).status,
    ).toBe(404);
    expect(
      getResult(
        (
          await callTrpc(
            "submissions.list",
            undefined,
            claimedRecipient.cookie,
            "query",
          )
        ).body,
        z.array(z.object({ id: z.string() })),
      ).map(({ id }) => id),
    ).not.toContain(submission.id);
    expect(
      (
        await callTrpc(
          "submissions.removeSpeaker",
          {
            submissionId: submission.id,
            speakerId: finalSpeaker.speakerId,
          },
          organizer.cookie,
        )
      ).status,
    ).toBe(409);

    const history = await testEnvironment.DB.prepare(
      `SELECT claimed_user_id, removed_at
       FROM submission_speakers
       WHERE id = ?`,
    )
      .bind(claimedSpeaker.speakerId)
      .first<{ claimed_user_id: string; removed_at: number }>();
    expect(history?.claimed_user_id).toBe(claimedRecipient.userId);
    expect(history?.removed_at).toBeTypeOf("number");
    expect(firstRecipient.userId).not.toBe(claimedRecipient.userId);
  });

  test("keeps invitation attempts immutable across replacement and resolution", async () => {
    const owner = await signIn("speaker-attempt-owner@example.com");
    const firstRecipient = await signIn("speaker-attempt-first@example.com");
    const secondRecipient = await signIn("speaker-attempt-second@example.com");
    const submission = await createSubmission({
      slug: "speaker-attempts-2027",
      eventOwner: owner,
      submissionOwner: owner,
      proposedSpeakers: [
        { name: "First Attempt", email: "speaker-attempt-first@example.com" },
      ],
    });
    const firstSecret = await getInvitationSecret(
      "speaker-attempt-first@example.com",
    );
    const firstInvitation = getResult(
      (
        await callTrpc(
          "submissionSpeakerInvitations.get",
          { secret: firstSecret },
          undefined,
          "query",
        )
      ).body,
      invitationSchema,
    );

    expect(
      (
        await callTrpc(
          "submissions.replaceSpeakerInvitation",
          {
            submissionId: submission.id,
            speakerId: submission.proposedSpeakers[0]?.id,
            replacesInvitationId: firstInvitation.id,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    const replacementSecret = await getInvitationSecret(
      "speaker-attempt-first@example.com",
    );
    expect(replacementSecret).not.toBe(firstSecret);
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.get",
          { secret: firstSecret },
          undefined,
          "query",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc("submissionSpeakerInvitations.decline", {
          secret: replacementSecret,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.accept",
          { secret: replacementSecret },
          firstRecipient.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await callTrpc(
          "submissions.resendSpeakerInvitation",
          {
            submissionId: submission.id,
            speakerId: submission.proposedSpeakers[0]?.id,
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    const resentSecret = await getInvitationSecret(
      "speaker-attempt-first@example.com",
    );
    expect(resentSecret).not.toBe(replacementSecret);
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.get",
          { secret: resentSecret },
          undefined,
          "query",
        )
      ).status,
    ).toBe(200);

    const secondSpeaker = getResult(
      (
        await callTrpc(
          "submissions.addSpeaker",
          {
            submissionId: submission.id,
            name: "Second Attempt",
            email: "speaker-attempt-second@example.com",
          },
          owner.cookie,
        )
      ).body,
      addedSpeakerSchema,
    );
    const expiredSecret = await getInvitationSecret(
      "speaker-attempt-second@example.com",
    );
    await testEnvironment.DB.prepare(
      "UPDATE submission_speaker_invitations SET expires_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 1, secondSpeaker.invitationId)
      .run();
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.get",
          { secret: expiredSecret },
          undefined,
          "query",
        )
      ).status,
    ).toBe(409);
    await callTrpc(
      "submissions.replaceSpeakerInvitation",
      {
        submissionId: submission.id,
        speakerId: secondSpeaker.speakerId,
        replacesInvitationId: secondSpeaker.invitationId,
      },
      owner.cookie,
    );
    const usableSecret = await getInvitationSecret(
      "speaker-attempt-second@example.com",
    );

    const event = await testEnvironment.DB.prepare(
      "SELECT event_id FROM submissions WHERE id = ?",
    )
      .bind(submission.id)
      .first<{ event_id: string }>();
    const existingAgenda = await testEnvironment.DB.prepare(
      "SELECT id FROM agendas WHERE event_id = ?",
    )
      .bind(event?.event_id)
      .first<{ id: string }>();
    const agendaId = existingAgenda?.id ?? "";
    const agendaUpdatedAt = Date.now() - 10_000;
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "UPDATE decisions SET status = 'accepted' WHERE submission_id = ?",
      ).bind(submission.id),
      testEnvironment.DB.prepare(
        "UPDATE agendas SET updated_at = ? WHERE id = ?",
      ).bind(agendaUpdatedAt, agendaId),
    ]);
    expect(
      (
        await callTrpc(
          "submissionSpeakerInvitations.accept",
          { secret: usableSecret },
          secondRecipient.cookie,
        )
      ).status,
    ).toBe(200);

    const attempts = await testEnvironment.DB.prepare(
      `SELECT status, replacement_for_invitation_id
       FROM submission_speaker_invitations
       WHERE submission_speaker_id = ?
       ORDER BY created_at`,
    )
      .bind(submission.proposedSpeakers[0]?.id)
      .all<{
        status: string;
        replacement_for_invitation_id: string | null;
      }>();
    expect(attempts.results).toEqual([
      { status: "revoked", replacement_for_invitation_id: null },
      {
        status: "declined",
        replacement_for_invitation_id: firstInvitation.id,
      },
      { status: "pending", replacement_for_invitation_id: null },
    ]);
    const agenda = await testEnvironment.DB.prepare(
      "SELECT updated_at FROM agendas WHERE id = ?",
    )
      .bind(agendaId)
      .first<{ updated_at: number }>();
    expect(agenda?.updated_at).toBe(agendaUpdatedAt);
    expect(
      await testEnvironment.DB.prepare(
        "SELECT COUNT(*) AS count FROM submission_speakers WHERE submission_id = ?",
      )
        .bind(submission.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });

  test("gives claimed speakers one reusable profile and nobody an empty one", async () => {
    const owner = await signIn("speaker-profile-owner@example.com");
    const recipient = await signIn("speaker-profile-recipient@example.com");
    const organizer = await signIn("speaker-profile-organizer@example.com");
    const reviewer = await signIn("speaker-profile-reviewer@example.com");
    const slug = "speaker-profile-2027";
    await createSubmission({
      slug,
      eventOwner: owner,
      submissionOwner: owner,
      proposedSpeakers: [
        {
          name: "Profile Recipient",
          email: "speaker-profile-recipient@example.com",
        },
      ],
    });
    const secret = await getInvitationSecret(
      "speaker-profile-recipient@example.com",
    );
    await callTrpc(
      "submissionSpeakerInvitations.accept",
      { secret },
      recipient.cookie,
    );
    await grantEventRole(
      slug,
      owner.cookie,
      organizer.cookie,
      "speaker-profile-organizer@example.com",
      "organizer",
    );
    await grantEventRole(
      slug,
      owner.cookie,
      reviewer.cookie,
      "speaker-profile-reviewer@example.com",
      "reviewer",
    );

    expect(
      getResult(
        (
          await callTrpc(
            "speakerProfile.getOwn",
            undefined,
            recipient.cookie,
            "query",
          )
        ).body,
        profileStateSchema,
      ),
    ).toEqual({
      eligible: true,
      profile: null,
      suggestedDisplayName: "Profile Recipient",
    });

    for (const user of [owner, organizer, reviewer]) {
      expect(
        getResult(
          (
            await callTrpc(
              "speakerProfile.getOwn",
              undefined,
              user.cookie,
              "query",
            )
          ).body,
          profileStateSchema,
        ),
      ).toEqual({
        eligible: false,
        profile: null,
        suggestedDisplayName: null,
      });
      expect(
        (
          await callTrpc(
            "speakerProfile.saveOwn",
            {
              displayName: "Not a speaker",
              bio: "This user has no claimed speaker relationship.",
              headshotUrl: null,
            },
            user.cookie,
          )
        ).status,
      ).toBe(403);
    }

    const created = getResult(
      (
        await callTrpc(
          "speakerProfile.saveOwn",
          {
            displayName: "Profile Recipient",
            bio: "A reusable biography for every event and submission.",
            headshotUrl: "https://example.com/profile.jpg",
          },
          recipient.cookie,
        )
      ).body,
      profileSchema,
    );
    const updated = getResult(
      (
        await callTrpc(
          "speakerProfile.saveOwn",
          {
            displayName: "Riley Profile",
            bio: "An updated biography that keeps the same global profile.",
            headshotUrl: null,
          },
          recipient.cookie,
        )
      ).body,
      profileSchema,
    );
    expect(updated).toMatchObject({
      id: created.id,
      displayName: "Riley Profile",
      headshotUrl: null,
    });
    expect(
      await testEnvironment.DB.prepare(
        "SELECT COUNT(*) AS count FROM speaker_profiles WHERE user_id = ?",
      )
        .bind(recipient.userId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
});

async function createSubmission(input: {
  slug: string;
  eventOwner: { cookie: string };
  submissionOwner: { cookie: string };
  proposedSpeakers: Array<{ name: string; email: string }>;
}) {
  await callTrpc(
    "events.create",
    {
      name: "Speaker Claim Conference",
      slug: input.slug,
      startsOn: "2027-08-10",
      endsOn: "2027-08-12",
      timezone: "Europe/Berlin",
    },
    input.eventOwner.cookie,
  );
  const track = getResult(
    (
      await callTrpc(
        "tracks.create",
        { slug: input.slug, name: "Systems" },
        input.eventOwner.cookie,
      )
    ).body,
    idSchema,
  );
  const cfp = getResult(
    (
      await callTrpc(
        "cfps.createDraft",
        {
          slug: input.slug,
          name: "Share your work",
          deadline: "2027-04-30T21:59:00Z",
          formats: ["Talk"],
          customFields: [],
        },
        input.eventOwner.cookie,
      )
    ).body,
    cfpSchema,
  );
  await callTrpc(
    "cfps.open",
    {
      slug: input.slug,
      cfpId: cfp.id,
      name: cfp.name,
      deadline: cfp.deadline,
      formats: cfp.formats,
      customFields: cfp.customFields,
    },
    input.eventOwner.cookie,
  );

  return getResult(
    (
      await callTrpc(
        "submissions.submit",
        {
          slug: input.slug,
          cfpId: cfp.id,
          clientDraftId: crypto.randomUUID(),
          title: "A claimed proposal",
          abstract: "A proposal that has an invited proposed speaker.",
          format: "Talk",
          trackId: track.id,
          proposedSpeakers: input.proposedSpeakers,
          customAnswers: {},
        },
        input.submissionOwner.cookie,
      )
    ).body,
    createdSubmissionSchema,
  );
}

async function getInvitationSecret(email: string): Promise<string> {
  const response = await workerFetch(
    `/api/dev/invitation-secret?email=${encodeURIComponent(email)}`,
  );
  expect(response.status).toBe(200);
  return z.object({ secret: z.string() }).parse(await response.json()).secret;
}

async function grantEventRole(
  slug: string,
  ownerCookie: string,
  recipientCookie: string,
  email: string,
  role: "organizer" | "reviewer",
): Promise<void> {
  await callTrpc("eventTeam.invite", { slug, email, role }, ownerCookie);
  const secret = await getInvitationSecret(email);
  expect(
    (await callTrpc("invitations.accept", { secret }, recipientCookie)).status,
  ).toBe(200);
}
